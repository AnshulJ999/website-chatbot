import type { Env } from "./env";

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, k);
  }
  return k;
}

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

export async function sign(secret: string, data: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data)));
}

export async function verifySig(secret: string, data: string, sig: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(data));
  } catch {
    return false;
  }
}

export interface ChatToken {
  chatId: string;
  visitorId: string;
  site: string;
  exp: number;
  dev?: { brain?: string; scenario?: string };
}

export async function makeToken(secret: string, t: ChatToken): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(t)));
  return `${body}.${await sign(secret, body)}`;
}

export async function readToken(secret: string, token: string): Promise<ChatToken | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig || !(await verifySig(secret, body, sig))) return null;
  const t = JSON.parse(new TextDecoder().decode(fromB64url(body))) as ChatToken;
  return t.exp > Date.now() ? t : null;
}

/** Proves a browser owns a visitor id, so returning visitors skip Turnstile. */
export const visitorKey = (secret: string, visitorId: string) => sign(secret, `visitor:${visitorId}`);

/** Signed reply-to address part for a chat: "<chatId>.<sig>". */
export async function replyTag(secret: string, chatId: string): Promise<string> {
  return `${chatId}.${(await sign(secret, `reply:${chatId}`)).slice(0, 16)}`;
}

export async function readReplyTag(secret: string, tag: string): Promise<string | null> {
  const i = tag.lastIndexOf(".");
  if (i < 0) return null;
  const chatId = tag.slice(0, i);
  const expected = (await sign(secret, `reply:${chatId}`)).slice(0, 16);
  return expected === tag.slice(i + 1) ? chatId : null;
}

export async function verifyTurnstile(env: Env, token: string | undefined, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const body = new FormData();
  body.set("secret", env.TURNSTILE_SECRET);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = (await res.json()) as { success?: boolean };
  return !!data.success;
}

// Cloudflare Access: verify the Cf-Access-Jwt-Assertion header against the team's public keys.

let certs: { at: number; keys: Map<string, CryptoKey> } | undefined;

async function accessKeys(team: string): Promise<Map<string, CryptoKey>> {
  if (certs && Date.now() - certs.at < 3_600_000) return certs.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const data = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of data.keys) {
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  certs = { at: Date.now(), keys };
  return keys;
}

export async function verifyAccess(env: Env, req: Request): Promise<string | null> {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64url(h))) as { kid: string };
    const key = (await accessKeys(env.ACCESS_TEAM_DOMAIN)).get(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(p))) as { aud: string | string[]; exp: number; email?: string };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD) || claims.exp * 1000 < Date.now()) return null;
    return claims.email ?? "owner";
  } catch {
    return null;
  }
}
