import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { newId, toPublic, type SessionRequest, type SessionResponse, type Settings, type SiteConfig } from "@website-chatbot/shared";
import { makeOwnerPass, makeToken, readReplyTag, readToken, verifyAccess, verifyOwnerPass, verifySig, verifySvix, verifyTurnstile, visitorKey } from "./auth";
import type { RoomInit } from "./chatroom";
import * as db from "./db";
import { DEMO_SITE } from "./demo-site";
import { isDev, type Env } from "./env";
import { ntfy } from "./notify";
import { buildInstruction } from "./brain/agent-config";
import { deviceLine, placeLine } from "./visitor-info";

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

function cfInfo(c: Context<App>): { country?: string; city?: string; region?: string; ip: string | null; location: string } {
  const cf = (c.req.raw as Request & { cf?: { country?: string; city?: string; region?: string } }).cf;
  let countryName = cf?.country ?? "";
  try {
    if (countryName && countryName !== "XX" && countryName !== "T1") countryName = REGIONS.of(countryName) ?? countryName;
  } catch {
    // unknown code: keep it
  }
  const location = placeLine({ city: cf?.city, region: cf?.region, country: countryName });
  return { country: cf?.country, city: cf?.city, region: cf?.region, ip: c.req.header("CF-Connecting-IP") ?? null, location };
}

const deviceOf = (c: Context<App>) => deviceLine(c.req.header("User-Agent") ?? "", c.req.header("Accept-Language"));

/** Whether visitors see the owner as online (the inbox's presence setting and, in "auto", recent activity). */
function ownerOnline(env: Env): Promise<boolean> {
  return hub(env).ownerPresent();
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

  const { country, city, region, ip } = cfInfo(c);
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

  await db.upsertVisitor(env.DB, { id: vid, site: site.key, country, city, region, device: deviceOf(c) });

  const settings = await db.getSettings(env.DB);
  // The daily clean-up rides on the first chat of the day, so no cron trigger is needed (Workers Free allows 5 per account).
  c.executionCtx.waitUntil(dailyJobIfDue(env));
  let dev: SessionRequest["dev"];
  if (devOk && body.dev) {
    const { pass: _pass, ...rest } = body.dev;
    dev = {
      ...rest,
      ownerName: rest.ownerName?.slice(0, 60),
      cpuBurnMs: typeof rest.cpuBurnMs === "number" ? Math.min(5000, Math.max(0, rest.cpuBurnMs)) : undefined,
      cutoff: rest.cutoff === true || undefined,
      owner: rest.owner === true || undefined,
      model: typeof rest.model === "string" && /^[\w.~/:-]{3,120}$/.test(rest.model) ? rest.model : undefined,
      effort: typeof rest.effort === "string" && EFFORTS.includes(rest.effort) ? rest.effort : undefined,
    };
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
    ownerOnline: await ownerOnline(env),
  };
  return c.json(res);
});

// The visitor's own earlier chats on this site, for the widget's "Past chats" list.
app.use("/api/my-chats", cors({ origin: (o) => o, allowMethods: ["POST"], allowHeaders: ["Content-Type"], maxAge: 86400 }));
app.post("/api/my-chats", async (c) => {
  let body: { site?: string; visitorId?: string; visitorKey?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }
  const site = await siteFor(c.env, String(body.site ?? ""));
  if (!site) return c.json({ error: "unknown_site" }, 404);
  if (!originAllowed(c.env, site, c.req.header("Origin"))) return c.json({ error: "origin" }, 403);
  const vid = String(body.visitorId ?? "");
  const known = /^v_[\w]+$/.test(vid) && !!body.visitorKey && (await verifySig(c.env.TOKEN_SECRET, `visitor:${vid}`, body.visitorKey));
  if (!known) return c.json({ chats: [] });
  const chats = (await db.visitorChats(c.env.DB, vid)).filter((x) => x.site === site.key).map((x) => ({ id: x.id, preview: x.preview, updatedAt: x.updatedAt, ownerAt: x.ownerAt }));
  return c.json({ chats });
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
    test: !!t.dev || isDevOrigin(env, origin),
    location: cfInfo(c).location,
    page: q.page?.slice(0, 500),
    title: q.title?.slice(0, 200),
    referrer: q.ref?.slice(0, 500) || undefined,
    device: deviceOf(c),
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
  return c.json({ site: toPublic(site), aiEnabled: settings.aiEnabled }, 200, { "Cache-Control": "public, max-age=600", "Access-Control-Allow-Origin": "*" });
});

/** Whether visitors see the owner as online, before a chat starts. Never cached, unlike the site config. */
app.get("/api/presence", async (c) => c.json({ ownerOnline: await ownerOnline(c.env) }, 200, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }));

// ---------- machine API (kb-sync, Sitrep) ----------

const bearer = (c: Context<App>) => !!c.env.API_TOKEN && c.req.header("Authorization") === `Bearer ${c.env.API_TOKEN}`;

app.put("/api/sync/site", async (c) => {
  if (!bearer(c)) return c.text("unauthorized", 401);
  const body = await c.req.json<Partial<SiteConfig>>();
  const missing = (["key", "name", "assistantName", "ownerName", "storeName", "instruction", "ownerEmail", "emailFrom"] as const).filter((k) => !body[k]);
  if (missing.length) return c.json({ error: `missing: ${missing.join(", ")}` }, 400);
  // Optional fields get working defaults, so a minimal config gives a usable widget.
  const site = {
    talkLabel: "Talk to a person",
    greeting: `Hi! Ask me anything about ${body.name}.`,
    noticeText: "Chats are saved so you can pick up later.",
    contactEmail: body.ownerEmail,
    starters: [],
    theme: {},
    ui: {},
    proactive: { enabled: false, delaySec: 6, text: "" },
    origins: [],
    tools: [],
    ...body,
  } as SiteConfig;
  await db.putSite(c.env.DB, site);
  return c.json({ ok: true, key: site.key });
});

/** The owner's Playground pass for scripts holding the API token (same as /admin/api/dev-pass). */
app.get("/api/dev-pass", async (c) => {
  if (!bearer(c)) return c.text("unauthorized", 401);
  return c.json({ pass: await makeOwnerPass(c.env.TOKEN_SECRET, 1) });
});

/** Sends a test alert to a site's chat topic and to the system topic, to check delivery from Cloudflare. */
app.post("/api/test-alert/:key", async (c) => {
  if (!bearer(c)) return c.text("unauthorized", 401);
  const site = await siteFor(c.env, c.req.param("key"));
  if (!site) return c.json({ error: "unknown_site" }, 404);
  const base = { lines: ["🔔 Sent from the chatbot server to check that alerts arrive."], priority: 2 as const, tags: ["bell"], actions: [{ label: "Open inbox", url: `${c.env.PUBLIC_URL}/admin/` }] };
  const [chat, ops] = await Promise.all([
    ntfy(c.env, site, { ...base, title: `${site.alertName ?? site.name} chat - Test alert` }),
    ntfy(c.env, null, { ...base, title: "Chatbot - Test alert" }),
  ]);
  return c.json({ ok: !chat && !ops, chat, ops });
});

app.get("/api/summary", async (c) => {
  if (!bearer(c)) return c.text("unauthorized", 401);
  return c.json(await summary(c.env));
});

async function summary(env: Env) {
  const day = Date.now() - 86_400_000;
  const [settings, spend, stats, enquiries, chats, failedAnswers, failedAttempts, cutOffAnswers, failedAlerts, failedMails, answers24h] = await Promise.all([
    db.getSettings(env.DB),
    db.spendToday(env.DB),
    db.getSettings(env.DB).then((s) => db.stats(env.DB, 7, s.countTestChats)),
    db.listEnquiries(env.DB, 20),
    db.listChats(env.DB, { limit: 20 }),
    db.countIncidents(env.DB, "turn_failed", day),
    db.countIncidents(env.DB, "attempt_failed", day),
    db.countIncidents(env.DB, "turn_interrupted", day),
    db.countIncidents(env.DB, "alert_failed", day),
    db.countIncidents(env.DB, "mail_failed", day),
    db.getSettings(env.DB).then((s) => db.answerStats(env.DB, day, s.countTestChats)),
  ]);
  return {
    aiEnabled: settings.aiEnabled,
    presence: settings.presence,
    ownerOnline: await ownerOnline(env),
    problemsLast24h: { failedAnswers, failedAttempts, cutOffAnswers, failedAlerts, failedMails },
    answersLast24h: answers24h,
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
  const who = isDev(c.env) ? "dev" : await verifyAccess(c.env, c.req.raw);
  if (!who) return c.text("unauthorized", 401);
  // Service tokens may only read: no changes and no live chat sockets.
  if (who === "service" && (c.req.method !== "GET" || c.req.header("Upgrade"))) return c.text("read only", 403);
  return next();
});

app.get("/admin/api/overview", async (c) => {
  const env = c.env;
  const [settings, spend, sites, health, online] = await Promise.all([db.getSettings(env.DB, true), db.spendToday(env.DB), db.listSites(env.DB), db.modelHealth(env.DB), ownerOnline(env)]);
  const siteList = sites.map((s) => ({ key: s.key, name: s.name }));
  if (isDev(env) && !siteList.some((s) => s.key === "demo")) siteList.push({ key: "demo", name: "Demo (dev)" });
  return c.json({ settings, spendTodayUsd: spend, sites: siteList, modelHealth: health, ownerOnline: online });
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

/** The whole prompt a site's agents get, for checking it in the inbox. */
app.get("/admin/api/prompt/:key", async (c) => {
  const site = await siteFor(c.env, c.req.param("key"));
  if (!site) return c.json({ error: "unknown_site" }, 404);
  const prompt = buildInstruction(site);
  return c.json({ prompt, tokensApprox: Math.round(prompt.length / 3.5) });
});

/** Archive or restore one chat; nothing is deleted. */
app.post("/admin/api/chats/:id/archive", async (c) => {
  const { archived } = await c.req.json<{ archived?: boolean }>();
  await db.setArchived(c.env.DB, c.req.param("id"), archived !== false);
  // An archived chat no longer waits for the owner.
  if (archived !== false) await room(c.env, c.req.param("id")).clearWaiting();
  await hub(c.env).chat(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/admin/api/archive-test-chats", async (c) => c.json({ archived: await db.archiveTestChats(c.env.DB) }));

app.get("/admin/api/chats", async (c) => {
  const q = c.req.query();
  const filter = (["all", "live", "wants", "email", "test", "archived"] as const).find((f) => f === q.filter) ?? "all";
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
  const chatId = await db.setEnquiryStatus(c.env.DB, c.req.param("id"), status);
  // A message marked Replied or Closed means its chat no longer waits for the owner.
  if (chatId && status !== "new") await room(c.env, chatId).clearWaiting();
  return c.json({ ok: true });
});

app.get("/admin/api/stats", async (c) => {
  const days = Math.min(Number(c.req.query("days") ?? 14), 90);
  const settings = await db.getSettings(c.env.DB);
  return c.json(await db.stats(c.env.DB, days, settings.countTestChats));
});

app.get("/admin/api/summary", async (c) => c.json(await summary(c.env)));

const EFFORTS = ["max", "xhigh", "high", "medium", "low", "none", ""];

function sanitizeSettings(p: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
  for (const k of ["aiEnabled", "streaming", "alertOnNewChat", "countTestChats", "handBackWhenAway"] as const) if (typeof p[k] === "boolean") out[k] = p[k];
  if (p.visitorLabel === "number" || p.visitorLabel === "code" || p.visitorLabel === "name") out.visitorLabel = p.visitorLabel;
  if (p.presence === "auto" || p.presence === "available" || p.presence === "away") out.presence = p.presence;
  const ranges: [keyof Settings, number, number][] = [
    ["chatCapUsd", 0, 100],
    ["dailyBudgetUsd", 0, 1000],
    ["perVisitorDailyMessages", 1, 1000],
    ["visitorMessagesPerDay", 1, 100],
    ["visitorEmailsPerDay", 0, 10000],
    ["wantsYouAlertEveryMin", 0, 1440],
    ["maxMessageChars", 100, 10000],
    ["stallTimeoutSec", 5, 300],
    ["modelTimeoutSec", 5, 600],
    ["turnTimeoutSec", 10, 900],
    ["stillWorkingSec", 1, 120],
    ["awayAfterMin", 1, 240],
    ["handBackAfterMin", 0, 240],
    ["deltaBatchMs", 0, 1000],
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
      .map((t) => ({
        provider: t.provider,
        model: t.model,
        label: String(t.label || t.model),
        free: !!t.free,
        enabled: !!t.enabled,
        effort: EFFORTS.includes(String(t.effort ?? "high")) ? String(t.effort ?? "high") : "high",
      }));
  }
  return out;
}

// ---------- inbound email and the daily job ----------

/** Resend Receiving: Resend posts a signed email.received notice; the text is fetched from its API. */
app.post("/api/email/resend", async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return c.text("not configured", 404);
  const body = await c.req.text();
  const signed = await verifySvix(secret, { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") }, body);
  if (!signed) return c.text("bad signature", 400);
  const event = JSON.parse(body) as { type?: string; data?: { email_id?: string } };
  const id = event.data?.email_id;
  if (event.type !== "email.received" || !id) return c.text("ignored");
  // Deliver before answering: an error answer makes Resend send the notice again later, and the chat ignores a repeat.
  try {
    await receiveResend(c.env, id);
  } catch (e) {
    console.error("resend inbound", id, e);
    await db.logIncident(c.env.DB, { site: "-", kind: "inbound_failed", detail: `email ${id}: ${e instanceof Error ? e.message : String(e)}` }).catch(() => undefined);
    return c.text("retry later", 503);
  }
  return c.text("ok");
});

async function receiveResend(env: Env, id: string): Promise<void> {
  const res = await fetch(`https://api.resend.com/emails/receiving/${id}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
  if (!res.ok) throw new Error(`fetch received email: ${res.status}`);
  const mail = (await res.json()) as { from?: string; to?: string[]; text?: string | null; html?: string | null };
  const text = mail.text ?? htmlToText(mail.html ?? "");
  const result = await deliverReply(env, mail.to ?? [], mail.from ?? "", text, id);
  if (result !== "ok") console.log("resend inbound", id, result, mail.to);
}

/** A visitor's email reply, from either inbound path: the address holds the chat's signed tag. */
async function deliverReply(env: Env, to: string[], from: string, text: string, emailId?: string): Promise<"ok" | "unknown" | "empty"> {
  for (const raw of to) {
    const address = /<([^>]+)>/.exec(raw)?.[1] ?? raw;
    const local = address.trim().split("@")[0] ?? "";
    if (!local.toLowerCase().startsWith("chat+")) continue;
    const chatId = await readReplyTag(env.TOKEN_SECRET, local.slice(5));
    if (!chatId) continue;
    const body = stripQuoted(text);
    if (!body) return "empty";
    await room(env, chatId).emailReply(from, body, emailId);
    return "ok";
  }
  return "unknown";
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, "\n")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    // Gmail wraps a long "On <date> <sender> wrote:" header over two or three lines.
    if (/^On /.test(line) && lines.slice(i, i + 3).some((l) => /wrote:\s*$/.test(l))) break;
    if (/^-{2,}\s*Original Message/i.test(line) || /^From: /.test(line) || line.trim() === "---") break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export default {
  fetch: app.fetch,

  /** Cloudflare Email Routing: a literal rule for chat@<replyDomain> with subaddressing on hands replies here. */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const local = message.to.split("@")[0] ?? "";
    if (!local.toLowerCase().startsWith("chat+") || !(await readReplyTag(env.TOKEN_SECRET, local.slice(5)))) {
      message.setReject("Unknown address");
      return;
    }
    const parsed = await PostalMime.parse(message.raw);
    await deliverReply(env, [message.to], message.from, parsed.text ?? htmlToText(parsed.html ?? ""));
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
