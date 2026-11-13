import type { SiteConfig } from "@website-chatbot/shared";
import type { Env } from "./env";

export interface Alert {
  /** Plain text; ntfy titles are HTTP headers, so anything non-ASCII is dropped. */
  title: string;
  /** Body lines; emoji are fine here. */
  lines: string[];
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  /** Buttons on the notification; the first is also the tap target. */
  actions?: { label: string; url: string }[];
  /** Marks alerts from dev sites and the Playground. */
  dev?: boolean;
}

const RETRY_MS = 2000;

/** Headers are ASCII only; strip accents and anything else. */
export function asciiSafe(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

/** Sends one ntfy alert to the site's topic (or the default one), retrying once. Returns an error text on failure. */
export async function ntfy(env: Env, site: Pick<SiteConfig, "ntfy"> | null, a: Alert): Promise<string | null> {
  const secrets = env as unknown as Record<string, string | undefined>;
  const url = site?.ntfy ? secrets[site.ntfy.urlSecret] : env.NTFY_URL;
  if (!url) return site?.ntfy ? `secret ${site.ntfy.urlSecret} is not set` : null;
  const token = site?.ntfy ? (site.ntfy.tokenSecret ? secrets[site.ntfy.tokenSecret] : undefined) : env.NTFY_TOKEN;
  const headers: Record<string, string> = {
    Title: asciiSafe(`${a.dev ? "[DEV] " : ""}${a.title}`).slice(0, 250),
    Priority: String(a.priority ?? 3),
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (a.tags?.length) headers.Tags = a.tags.join(",");
  if (a.actions?.length) {
    headers.Click = a.actions[0]!.url;
    headers.Actions = a.actions.map((x) => `view, ${asciiSafe(x.label).replace(/[,;]/g, "")}, ${x.url}`).join("; ");
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = a.lines.filter(Boolean).join("\n").slice(0, 3000);
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, RETRY_MS));
    try {
      const res = await fetch(url, { method: "POST", headers, body });
      if (res.ok) return null;
      error = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  console.error("ntfy failed", url.replace(/\/[^/]+$/, "/<topic>"), error);
  return error;
}

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

/** Sends through Resend. Returns an error text instead of throwing, so a mail problem never breaks a chat. */
export async function sendMail(env: Env, m: Mail): Promise<string | null> {
  if (!env.RESEND_API_KEY) return "RESEND_API_KEY is not set";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
    });
    if (res.ok) return null;
    const error = `resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
    console.error(error);
    return error;
  } catch (e) {
    const error = `resend: ${e instanceof Error ? e.message : String(e)}`;
    console.error(error);
    return error;
  }
}

export const inboxLink = (env: Env, chatId: string) => `${env.PUBLIC_URL}/admin/#/chats/${chatId}`;
export const settingsLink = (env: Env) => `${env.PUBLIC_URL}/admin/#/settings`;
