import { DEFAULT_SETTINGS, type ChatSummary, type Enquiry, type Settings, type SiteConfig } from "@website-chatbot/shared";

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// Settings and sites change rarely; a short per-isolate cache saves D1 reads on every message.
const CACHE_MS = 15_000;
let settingsCache: { at: number; value: Settings } | undefined;
const siteCache = new Map<string, { at: number; value: SiteConfig | null }>();

export async function getSettings(db: D1Database, fresh = false): Promise<Settings> {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < CACHE_MS) return settingsCache.value;
  const row = await db.prepare("SELECT value FROM settings WHERE id = 1").first<{ value: string }>();
  const value: Settings = { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<Settings>) : {}) };
  settingsCache = { at: Date.now(), value };
  return value;
}

export async function saveSettings(db: D1Database, patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings(db, true)), ...patch };
  await db
    .prepare("INSERT INTO settings (id, value, updated_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET value = ?1, updated_at = ?2")
    .bind(JSON.stringify(next), Date.now())
    .run();
  settingsCache = { at: Date.now(), value: next };
  return next;
}

export async function getSite(db: D1Database, key: string): Promise<SiteConfig | null> {
  const hit = siteCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = await db.prepare("SELECT config FROM sites WHERE key = ?").bind(key).first<{ config: string }>();
  const value = row ? (JSON.parse(row.config) as SiteConfig) : null;
  siteCache.set(key, { at: Date.now(), value });
  return value;
}

export async function listSites(db: D1Database): Promise<SiteConfig[]> {
  const { results } = await db.prepare("SELECT config FROM sites ORDER BY key").all<{ config: string }>();
  return results.map((r) => JSON.parse(r.config) as SiteConfig);
}

export async function putSite(db: D1Database, site: SiteConfig): Promise<void> {
  await db
    .prepare("INSERT INTO sites (key, config, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET config = ?2, updated_at = ?3")
    .bind(site.key, JSON.stringify(site), Date.now())
    .run();
  siteCache.delete(site.key);
}

export async function upsertVisitor(
  db: D1Database,
  v: { id: string; site: string; country?: string; city?: string; device?: string },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO visitors (id, site, first_seen, last_seen, country, city, device) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET last_seen = ?3, country = COALESCE(?4, country), city = COALESCE(?5, city), device = COALESCE(?6, device)`,
    )
    .bind(v.id, v.site, now, v.country ?? null, v.city ?? null, v.device ?? null)
    .run();
}

/** Counts one visitor message for today; returns the new count. */
export async function countVisitorMessage(db: D1Database, visitorId: string): Promise<number> {
  const day = today();
  const row = await db
    .prepare(
      `UPDATE visitors SET msg_count = CASE WHEN msg_day = ?2 THEN msg_count + 1 ELSE 1 END, msg_day = ?2
       WHERE id = ?1 RETURNING msg_count`,
    )
    .bind(visitorId, day)
    .first<{ msg_count: number }>();
  return row?.msg_count ?? 1;
}

export async function setVisitorContact(db: D1Database, visitorId: string, name: string | null, email: string | null): Promise<void> {
  await db
    .prepare("UPDATE visitors SET name = COALESCE(?2, name), email = COALESCE(?3, email) WHERE id = ?1")
    .bind(visitorId, name, email)
    .run();
}

export async function visitorLastChat(db: D1Database, visitorId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM chats WHERE visitor_id = ? ORDER BY updated_at DESC LIMIT 1")
    .bind(visitorId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export interface ChatRow {
  id: string;
  site: string;
  visitor_id: string;
  status: string;
  mode: string;
  wants_owner: number;
  visitor_online: number;
  message_count: number;
  cost_usd: number;
  model: string | null;
  preview: string;
  page: string | null;
  referrer: string | null;
  unread: number;
  agent_id: string | null;
  agent_archived: number;
  thumbs_up: number;
  thumbs_down: number;
  created_at: number;
  updated_at: number;
}

const SUMMARY_SQL = `SELECT c.*, v.country, v.city, v.device, v.email, v.name FROM chats c LEFT JOIN visitors v ON v.id = c.visitor_id`;

export function toSummary(r: ChatRow & { country?: string | null; city?: string | null; device?: string | null; email?: string | null; name?: string | null }): ChatSummary {
  return {
    id: r.id,
    site: r.site,
    visitorId: r.visitor_id,
    status: r.status === "closed" ? "closed" : "open",
    mode: r.mode as ChatSummary["mode"],
    wantsOwner: !!r.wants_owner,
    visitorOnline: !!r.visitor_online,
    messageCount: r.message_count,
    costUsd: r.cost_usd,
    model: r.model ?? undefined,
    preview: r.preview,
    page: r.page ?? undefined,
    referrer: r.referrer ?? undefined,
    country: r.country ?? undefined,
    city: r.city ?? undefined,
    device: r.device ?? undefined,
    email: r.email ?? undefined,
    name: r.name ?? undefined,
    unread: r.unread,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getChatSummary(db: D1Database, id: string): Promise<ChatSummary | null> {
  const row = await db.prepare(`${SUMMARY_SQL} WHERE c.id = ?`).bind(id).first<ChatRow>();
  return row ? toSummary(row) : null;
}

export async function listChats(
  db: D1Database,
  q: { site?: string; filter?: "all" | "live" | "wants" | "email"; before?: number; limit?: number },
): Promise<ChatSummary[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.site) {
    where.push(`c.site = ?${args.length + 1}`);
    args.push(q.site);
  }
  if (q.filter === "live") where.push("c.visitor_online = 1");
  if (q.filter === "wants") where.push("c.wants_owner = 1");
  if (q.filter === "email") where.push("v.email IS NOT NULL");
  if (q.before) {
    where.push(`c.updated_at < ?${args.length + 1}`);
    args.push(q.before);
  }
  const sql = `${SUMMARY_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY c.visitor_online DESC, c.updated_at DESC LIMIT ${Math.min(q.limit ?? 50, 200)}`;
  const { results } = await db.prepare(sql).bind(...args).all<ChatRow>();
  return results.map(toSummary);
}

export async function visitorChats(db: D1Database, visitorId: string): Promise<ChatSummary[]> {
  const { results } = await db.prepare(`${SUMMARY_SQL} WHERE c.visitor_id = ? ORDER BY c.updated_at DESC LIMIT 20`).bind(visitorId).all<ChatRow>();
  return results.map(toSummary);
}

/** Partial update of a chat's index row; creates it when missing. */
export async function upsertChat(
  db: D1Database,
  id: string,
  base: { site: string; visitorId: string },
  patch: Partial<Omit<ChatRow, "id" | "site" | "visitor_id" | "created_at">>,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare("INSERT OR IGNORE INTO chats (id, site, visitor_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
    .bind(id, base.site, base.visitorId, now)
    .run();
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = ?${i + 2}`);
  const vals = keys.map((k) => {
    const v = patch[k];
    return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null);
  });
  if (!keys.includes("updated_at")) {
    sets.push(`updated_at = ?${keys.length + 2}`);
    vals.push(now);
  }
  await db.prepare(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?1`).bind(id, ...vals).run();
}

export async function addSpend(db: D1Database, site: string, usd: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO spend_daily (day, site, usd, turns) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(day, site) DO UPDATE SET usd = usd + ?3, turns = turns + 1`,
    )
    .bind(today(), site, usd)
    .run();
}

export async function spendToday(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM spend_daily WHERE day = ?").bind(today()).first<{ usd: number }>();
  return row?.usd ?? 0;
}

export async function insertEnquiry(db: D1Database, e: Enquiry): Promise<void> {
  await db
    .prepare("INSERT INTO enquiries (id, chat_id, site, name, email, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(e.id, e.chatId, e.site, e.name, e.email, e.message, e.status, e.createdAt)
    .run();
}

export async function listEnquiries(db: D1Database, limit = 100): Promise<Enquiry[]> {
  const { results } = await db
    .prepare("SELECT * FROM enquiries ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<{ id: string; chat_id: string; site: string; name: string; email: string; message: string; status: Enquiry["status"]; created_at: number }>();
  return results.map((r) => ({ id: r.id, chatId: r.chat_id, site: r.site, name: r.name, email: r.email, message: r.message, status: r.status, createdAt: r.created_at }));
}

export async function setEnquiryStatus(db: D1Database, id: string, status: Enquiry["status"]): Promise<void> {
  await db.prepare("UPDATE enquiries SET status = ? WHERE id = ?").bind(status, id).run();
}

export async function markEnquiriesReplied(db: D1Database, chatId: string): Promise<void> {
  await db.prepare("UPDATE enquiries SET status = 'replied' WHERE chat_id = ? AND status = 'new'").bind(chatId).run();
}

// Model health: failures across chats put a model on cooldown.

export async function coolingModels(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT model FROM model_health WHERE cooldown_until > ?").bind(Date.now()).all<{ model: string }>();
  return new Set(results.map((r) => r.model));
}

export async function recordModelFailure(db: D1Database, model: string, settings: Settings): Promise<void> {
  const now = Date.now();
  // Failures more than an hour apart don't count as "continuous".
  const row = await db
    .prepare(
      `INSERT INTO model_health (model, failures, last_failure) VALUES (?1, 1, ?2)
       ON CONFLICT(model) DO UPDATE SET failures = CASE WHEN last_failure > ?2 - 3600000 THEN failures + 1 ELSE 1 END, last_failure = ?2
       RETURNING failures`,
    )
    .bind(model, now)
    .first<{ failures: number }>();
  if ((row?.failures ?? 0) >= settings.cooldownAfterFailures) {
    await db
      .prepare("UPDATE model_health SET cooldown_until = ?2, failures = 0 WHERE model = ?1")
      .bind(model, now + settings.cooldownMinutes * 60_000)
      .run();
  }
}

export async function recordModelSuccess(db: D1Database, model: string): Promise<void> {
  await db.prepare("UPDATE model_health SET failures = 0 WHERE model = ? AND failures > 0").bind(model).run();
}

export async function modelHealth(db: D1Database) {
  const { results } = await db.prepare("SELECT * FROM model_health").all<{ model: string; failures: number; last_failure: number | null; cooldown_until: number | null }>();
  return results;
}

export async function stats(db: D1Database, days = 14) {
  const since = Date.now() - days * 86_400_000;
  const sinceDay = today(since);
  const [spend, chats, enquiries, thumbs] = await db.batch([
    db.prepare("SELECT day, site, usd, turns FROM spend_daily WHERE day >= ? ORDER BY day").bind(sinceDay),
    db.prepare("SELECT date(created_at / 1000, 'unixepoch') AS day, site, COUNT(*) AS n, SUM(message_count) AS messages FROM chats WHERE created_at >= ? GROUP BY day, site ORDER BY day").bind(since),
    db.prepare("SELECT date(created_at / 1000, 'unixepoch') AS day, site, COUNT(*) AS n FROM enquiries WHERE created_at >= ? GROUP BY day, site ORDER BY day").bind(since),
    db.prepare("SELECT COALESCE(SUM(thumbs_up), 0) AS up, COALESCE(SUM(thumbs_down), 0) AS down FROM chats WHERE created_at >= ?").bind(since),
  ]);
  return { spend: spend?.results ?? [], chats: chats?.results ?? [], enquiries: enquiries?.results ?? [], thumbs: thumbs?.results?.[0] ?? { up: 0, down: 0 } };
}

export async function idleAgents(db: D1Database, olderThan: number): Promise<{ id: string; agent_id: string }[]> {
  const { results } = await db
    .prepare("SELECT id, agent_id FROM chats WHERE agent_id IS NOT NULL AND agent_archived = 0 AND updated_at < ? LIMIT 40")
    .bind(olderThan)
    .all<{ id: string; agent_id: string }>();
  return results;
}
