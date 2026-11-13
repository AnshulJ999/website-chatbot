import type { Env } from "./env";

export async function ntfy(
  env: Env,
  n: { title: string; message: string; url?: string; priority?: 1 | 2 | 3 | 4 | 5; tags?: string[] },
): Promise<void> {
  if (!env.NTFY_URL) return;
  const headers: Record<string, string> = { Title: n.title, Priority: String(n.priority ?? 3) };
  if (n.url) headers.Click = n.url;
  if (n.tags?.length) headers.Tags = n.tags.join(",");
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  try {
    const res = await fetch(env.NTFY_URL, { method: "POST", headers, body: n.message.slice(0, 3000) });
    if (!res.ok) console.error("ntfy", res.status);
  } catch (e) {
    console.error("ntfy", e);
  }
}

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

/** Sends through Resend. Returns false (and logs) instead of throwing, so a mail problem never breaks a chat. */
export async function sendMail(env: Env, m: Mail): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.log("mail (no RESEND_API_KEY):", m.to, m.subject);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
    });
    if (!res.ok) console.error("resend", res.status, await res.text());
    return res.ok;
  } catch (e) {
    console.error("resend", e);
    return false;
  }
}

export const inboxLink = (env: Env, chatId: string) => `${env.PUBLIC_URL}/admin/#/chats/${chatId}`;
