import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { newId, toPublic, type SessionRequest, type SessionResponse, type Settings, type SiteConfig } from "@website-chatbot/shared";
import { makeOwnerPass, makeToken, readReplyTag, readToken, verifyAccess, verifyOwnerPass, verifySig, verifyTurnstile, visitorKey } from "./auth";
import type { RoomInit } from "./chatroom";
import * as db from "./db";
import { DEMO_SITE } from "./demo-site";
import { isDev, type Env } from "./env";
import { ntfy } from "./notify";

export { ChatRoom } from "./chatroom";
export { Hub } from "./hub";

type App = { Bindings: Env };
const app = new Hono<App>();

const room = (env: Env, chatId: string) => env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("hub"));

async function siteFor(env: Env, key: string): Promise<SiteConfig | null> {
  const site = await db.getSite(env.DB, key);
  if (site) return site;
  return isDev(env) && key === "demo" ? DEMO_SITE : null;
}

const ownOrigin = (env: Env) => {
  try {
    return env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : "";
  } catch {
    return "";
  }
};

function originAllowed(env: Env, site: SiteConfig, origin: string | undefined): boolean {
  if (!origin) return false;
  // The site's own pages, plus the hosted Playground on this server.
  if (site.origins.includes(origin) || origin === ownOrigin(env)) return true;
  return isDev(env) && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** Dev sites, local pages and the Playground: their alerts are marked [DEV]. */
function isDevOrigin(env: Env, origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host.startsWith("dev.") || origin === ownOrigin(env);
  } catch {
    return false;
  }
}

const REGIONS = new Intl.DisplayNames(["en"], { type: "region" });

function cfInfo(c: Context<App>): { country?: string; city?: string; ip: string | null; location: string } {
  const cf = (c.req.raw as Request & { cf?: { country?: string; city?: string } }).cf;
  let countryName = cf?.country ?? "";
  try {
    if (countryName && countryName !== "XX" && countryName !== "T1") countryName = REGIONS.of(countryName) ?? countryName;
  } catch {
    // unknown code: keep it
  }
  const location = [cf?.city, countryName].filter(Boolean).join(", ") || "Unknown location";
  return { country: cf?.country, city: cf?.city, ip: c.req.header("CF-Connecting-IP") ?? null, location };
}

/** The owner counts as online when the inbox toggle is on and an inbox tab is (or was just) open. */
async function ownerOnline(env: Env, settings: Settings): Promise<boolean> {
  return settings.ownerOnline && (await hub(env).ownerPresent());
}

// ---------- visitor API ----------

app.use("/api/session", cors({ origin: (o) => o, allowMethods: ["POST"], allowHeaders: ["Content-Type"], maxAge: 86400 }));

app.post("/api/session", async (c) => {
  const env = c.env;
  let body: SessionRequest;
  try {
    body = await c.req.json<SessionRequest>();
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }
  const site = await siteFor(env, String(body.site ?? ""));
  if (!site) return c.json({ error: "unknown_site" }, 404);
  if (!originAllowed(env, site, c.req.header("Origin"))) return c.json({ error: "origin" }, 403);

  const { country, city, ip } = cfInfo(c);
  // Playground options: always locally, and on the deployed server for the signed-in owner only.
  const devOk = isDev(env) || (await verifyOwnerPass(env.TOKEN_SECRET, body.dev?.pass));
  let visitorId = body.visitorId && /^v_[\w]+$/.test(body.visitorId) ? body.visitorId : undefined;
  const known = !!visitorId && !!body.visitorKey && (await verifySig(env.TOKEN_SECRET, `visitor:${visitorId}`, body.visitorKey));
  if (!known) {
    if (!devOk && site.turnstileSiteKey && !(await verifyTurnstile(env, body.turnstileToken, ip))) {
      return c.json({ error: "turnstile_required", siteKey: site.turnstileSiteKey }, 401);
    }
    visitorId = newId("v");
  }
  const vid = visitorId as string;

  let chatId = !body.newChat && body.chatId ? body.chatId : undefined;
  if (chatId) {
    const existing = await db.getChatSummary(env.DB, chatId);
    if (existing && existing.visitorId !== vid) chatId = undefined;
  }
  if (!chatId && !body.newChat) chatId = (await db.visitorLastChat(env.DB, vid)) ?? undefined;
  chatId ??= newId("c");

  const d = body.device ?? { width: 0, touch: false, lang: "", tz: "" };
  const device = `${d.touch ? "touch" : "mouse"} · ${d.width}px · ${d.lang} · ${d.tz}`.slice(0, 120);
  await db.upsertVisitor(env.DB, { id: vid, site: site.key, country, city, device });

  const settings = await db.getSettings(env.DB);
  // The daily clean-up rides on the first chat of the day, so no cron trigger is needed (Workers Free allows 5 per account).
  c.executionCtx.waitUntil(dailyJobIfDue(env));
  let dev: SessionRequest["dev"];
  if (devOk && body.dev) {
    const { pass: _pass, ...rest } = body.dev;
    dev = { ...rest, ownerName: rest.ownerName?.slice(0, 60) };
  }
  const token = await makeToken(env.TOKEN_SECRET, { chatId, visitorId: vid, site: site.key, exp: Date.now() + 6 * 3600_000, dev });
  const res: SessionResponse = {
    visitorId: vid,
    visitorKey: await visitorKey(env.TOKEN_SECRET, vid),
    chatId,
    token,
    wsUrl: "/api/chat/ws",
    site: toPublic(site),
    aiEnabled: settings.aiEnabled,
    ownerOnline: await ownerOnline(env, settings),
  };
  return c.json(res);
});

app.get("/api/chat/ws", async (c) => {
  const env = c.env;
  const t = await readToken(env.TOKEN_SECRET, c.req.query("token") ?? "");
  if (!t) return c.text("bad token", 401);
  const site = await siteFor(env, t.site);
  const origin = c.req.header("Origin");
  if (!site || !originAllowed(env, site, origin)) return c.text("origin", 403);
  const q = c.req.query();
  const init: RoomInit = {
    chatId: t.chatId,
    site: t.site,
    visitorId: t.visitorId,
    dev: t.dev,
    devHost: isDevOrigin(env, origin),
    location: cfInfo(c).location,
    page: q.page?.slice(0, 500),
    title: q.title?.slice(0, 200),
    referrer: q.ref?.slice(0, 500) || undefined,
    device: q.device?.slice(0, 120),
  };
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Init", encodeURIComponent(JSON.stringify(init)));
  return room(env, t.chatId).fetch(new Request("https://room/ws?role=visitor", { headers }));
});

app.get("/api/health", (c) => c.json({ ok: true }));

/** Public site config for the launcher before any chat starts. Browsers cache it for 10 minutes. */
app.get("/api/site/:key", async (c) => {
  const site = await siteFor(c.env, c.req.param("key"));
  if (!site) return c.json({ error: "unknown_site" }, 404);
  const settings = await db.getSettings(c.env.DB);
  return c.json(
    { site: toPublic(site), aiEnabled: settings.aiEnabled, ownerOnline: await ownerOnline(c.env, settings) },
    200,
    { "Cache-Control": "public, max-age=600", "Access-Control-Allow-Origin": "*" },
  );
});

// ---------- machine API (kb-sync, Sitrep) ----------

const bearer = (c: Context<App>) => !!c.env.API_TOKEN && c.req.header("Authorization") === `Bearer ${c.env.API_TOKEN}`;

app.put("/api/sync/site", async (c) => {
  if (!bearer(c)) return c.text("unauthorized", 401);
  const site = await c.req.json<SiteConfig>();
  const missing = (["key", "name", "assistantName", "ownerName", "storeName", "instruction", "ownerEmail", "emailFrom"] as const).filter((k) => !site[k]);
  if (missing.length) return c.json({ error: `missing: ${missing.join(", ")}` }, 400);
  await db.putSite(c.env.DB, site);
  return c.json({ ok: true, key: site.key });
});

/** The owner's Playground pass for scripts holding the API token (same as /admin/api/dev-pass). */
app.get("/api/dev-pass", async (c) => {
  if (!bearer(c)) return c.text("unauthorized", 401);
  return c.json({ pass: await makeOwnerPass(c.env.TOKEN_SECRET, 1) });
});

/** Sends a test alert to a site's ntfy topic, to check delivery from Cloudflare. */
app.post("/api/test-alert/:key", async (c) => {
  if (!bearer(c)) return c.text("unauthorized", 401);
  const site = await siteFor(c.env, c.req.param("key"));
  if (!site) return c.json({ error: "unknown_site" }, 404);
  const error = await ntfy(c.env, site, {
    title: `${site.alertName ?? site.name} chat - test alert`,
    lines: ["🔔 Sent from the chatbot server to check that alerts arrive."],
    priority: 2,
    tags: ["bell"],
    actions: [{ label: "Open inbox", url: `${c.env.PUBLIC_URL}/admin/` }],
    dev: true,
  });
  return c.json({ ok: !error, error });
});

app.get("/api/summary", async (c) => {
  if (!bearer(c)) return c.text("unauthorized", 401);
  return c.json(await summary(c.env));
});

async function summary(env: Env) {
  const day = Date.now() - 86_400_000;
  const [settings, spend, stats, enquiries, chats, failedAnswers, failedAttempts, failedAlerts, failedMails] = await Promise.all([
    db.getSettings(env.DB),
    db.spendToday(env.DB),
    db.stats(env.DB, 7),
    db.listEnquiries(env.DB, 20),
    db.listChats(env.DB, { limit: 20 }),
    db.countIncidents(env.DB, "turn_failed", day),
    db.countIncidents(env.DB, "attempt_failed", day),
    db.countIncidents(env.DB, "alert_failed", day),
    db.countIncidents(env.DB, "mail_failed", day),
  ]);
  return {
    aiEnabled: settings.aiEnabled,
    ownerOnline: settings.ownerOnline,
    problemsLast24h: { failedAnswers, failedAttempts, failedAlerts, failedMails },
    spendTodayUsd: spend,
    dailyBudgetUsd: settings.dailyBudgetUsd,
    newEnquiries: enquiries.filter((e) => e.status === "new").length,
    waitingChats: chats.filter((x) => x.wantsOwner).length,
    liveChats: chats.filter((x) => x.visitorOnline).length,
    last7Days: stats,
  };
}

// ---------- owner API (behind Cloudflare Access) ----------

app.use("/admin/api/*", async (c, next) => {
  if (isDev(c.env) || (await verifyAccess(c.env, c.req.raw))) return next();
  return c.text("unauthorized", 401);
});

app.get("/admin/api/overview", async (c) => {
  const env = c.env;
  const [settings, spend, sites, health] = await Promise.all([db.getSettings(env.DB, true), db.spendToday(env.DB), db.listSites(env.DB), db.modelHealth(env.DB)]);
  const siteList = sites.map((s) => ({ key: s.key, name: s.name }));
  if (isDev(env) && !siteList.some((s) => s.key === "demo")) siteList.push({ key: "demo", name: "Demo (dev)" });
  return c.json({ settings, spendTodayUsd: spend, sites: siteList, modelHealth: health });
});

app.get("/admin/api/sites", async (c) => c.json(await db.listSites(c.env.DB)));

/** Lets the hosted Playground use its test options (scripted brain, scenarios) for the signed-in owner. */
app.get("/admin/api/dev-pass", async (c) => c.json({ pass: await makeOwnerPass(c.env.TOKEN_SECRET) }));

app.get("/admin/api/incidents", async (c) => c.json(await db.recentIncidents(c.env.DB, Math.min(Number(c.req.query("limit") ?? 100), 500))));

app.patch("/admin/api/settings", async (c) => {
  const patch = await c.req.json<Partial<Settings>>();
  const settings = await db.saveSettings(c.env.DB, sanitizeSettings(patch));
  await hub(c.env).settings();
  return c.json(settings);
});

app.get("/admin/api/chats", async (c) => {
  const q = c.req.query();
  const filter = (["all", "live", "wants", "email"] as const).find((f) => f === q.filter) ?? "all";
  return c.json(await db.listChats(c.env.DB, { site: q.site || undefined, filter, before: q.before ? Number(q.before) : undefined }));
});

app.get("/admin/api/chats/:id", async (c) => {
  const id = c.req.param("id");
  const chat = await db.getChatSummary(c.env.DB, id);
  if (!chat) return c.json({ error: "not found" }, 404);
  const [messages, visitorChats] = await Promise.all([room(c.env, id).transcript(), db.visitorChats(c.env.DB, chat.visitorId)]);
  return c.json({ chat, messages, visitorChats: visitorChats.filter((v) => v.id !== id) });
});

app.post("/admin/api/chats/:id/read", async (c) => {
  const id = c.req.param("id");
  const chat = await db.getChatSummary(c.env.DB, id);
  if (chat) await db.upsertChat(c.env.DB, id, { site: chat.site, visitorId: chat.visitorId }, { unread: 0, updated_at: chat.updatedAt });
  return c.json({ ok: true });
});

app.get("/admin/api/chats/:id/ws", async (c) => {
  const id = c.req.param("id");
  const chat = await db.getChatSummary(c.env.DB, id);
  if (!chat) return c.text("not found", 404);
  const init: RoomInit = { chatId: id, site: chat.site, visitorId: chat.visitorId };
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Init", encodeURIComponent(JSON.stringify(init)));
  return room(c.env, id).fetch(new Request("https://room/ws?role=owner", { headers }));
});

app.get("/admin/api/hub/ws", (c) => hub(c.env).fetch(c.req.raw));

app.get("/admin/api/enquiries", async (c) => c.json(await db.listEnquiries(c.env.DB)));

app.patch("/admin/api/enquiries/:id", async (c) => {
  const { status } = await c.req.json<{ status: "new" | "replied" | "closed" }>();
  if (!["new", "replied", "closed"].includes(status)) return c.json({ error: "bad status" }, 400);
  await db.setEnquiryStatus(c.env.DB, c.req.param("id"), status);
  return c.json({ ok: true });
});

app.get("/admin/api/stats", async (c) => {
  const days = Math.min(Number(c.req.query("days") ?? 14), 90);
  return c.json(await db.stats(c.env.DB, days));
});

app.get("/admin/api/summary", async (c) => c.json(await summary(c.env)));

function sanitizeSettings(p: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
  for (const k of ["aiEnabled", "ownerOnline", "streaming", "alertOnNewChat"] as const) if (typeof p[k] === "boolean") out[k] = p[k];
  const ranges: [keyof Settings, number, number][] = [
    ["chatCapUsd", 0, 100],
    ["dailyBudgetUsd", 0, 1000],
    ["perVisitorDailyMessages", 1, 1000],
    ["maxMessageChars", 100, 10000],
    ["stallTimeoutSec", 5, 300],
    ["turnTimeoutSec", 10, 900],
    ["cooldownAfterFailures", 1, 100],
    ["cooldownMinutes", 1, 1440],
    ["archiveAfterDays", 1, 365],
  ];
  for (const [k, min, max] of ranges) {
    const v = num(p[k], min, max);
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  for (const k of ["capAction", "budgetAction"] as const) if (p[k] === "free_tier" || p[k] === "get_in_touch") out[k] = p[k];
  if (Array.isArray(p.ladder)) {
    out.ladder = p.ladder
      .filter((t) => t && typeof t.provider === "string" && typeof t.model === "string" && t.provider && t.model)
      .map((t) => ({ provider: t.provider, model: t.model, label: String(t.label || t.model), free: !!t.free, enabled: !!t.enabled }));
  }
  return out;
}

// ---------- inbound email and the daily job ----------

function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From: /.test(line) || line.trim() === "---") break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export default {
  fetch: app.fetch,

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const local = message.to.split("@")[0] ?? "";
    const chatId = local.startsWith("chat+") ? await readReplyTag(env.TOKEN_SECRET, local.slice(5)) : null;
    if (!chatId) {
      message.setReject("Unknown address");
      return;
    }
    const parsed = await PostalMime.parse(message.raw);
    const text = stripQuoted(parsed.text ?? "");
    if (text) await room(env, chatId).emailReply(message.from, text);
  },

  /** Optional: with a cron trigger configured, the clean-up also runs on schedule. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await dailyJob(env);
  },
} satisfies ExportedHandler<Env>;

async function dailyJobIfDue(env: Env): Promise<void> {
  try {
    if (await db.alertDue(env.DB, "daily-job", 20 * 3600_000)) await dailyJob(env);
  } catch (e) {
    console.error("daily job", e);
  }
}

/** Archives Omnara agents of chats idle for archiveAfterDays; a later message starts a fresh agent with a recap. */
async function dailyJob(env: Env): Promise<void> {
  const settings = await db.getSettings(env.DB, true);
  const idle = await db.idleAgents(env.DB, Date.now() - settings.archiveAfterDays * 86_400_000);
  for (const chat of idle) {
    try {
      await room(env, chat.id).archiveAgent();
      await env.DB.prepare("UPDATE chats SET agent_archived = 1 WHERE id = ?").bind(chat.id).run();
    } catch (e) {
      console.error("archive", chat.id, e);
    }
  }
}
