import type { AnswerStats, ChatMessage, ChatStatus, ChatSummary, Enquiry, HubMsg, OwnerMsg, ServerMsg, Settings } from "@website-chatbot/shared";

const BASE = `${import.meta.env.BASE_URL}api`;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) throw new Error("Your sign-in has expired. Reload the page to sign in again.");
  if (!res.ok) throw new Error(`Request failed (${res.status}). Try again.`);
  return (await res.json()) as T;
}

export interface Overview {
  settings: Settings;
  spendTodayUsd: number;
  sites: { key: string; name: string }[];
  modelHealth: { model: string; failures: number; last_failure: number | null; cooldown_until: number | null }[];
  ownerOnline: boolean;
}

export interface ChatDetail {
  chat: ChatSummary;
  messages: ChatMessage[];
  visitorChats: ChatSummary[];
}

export interface Stats {
  spend: { day: string; site: string; usd: number; turns: number }[];
  chats: { day: string; site: string; n: number; messages: number }[];
  enquiries: { day: string; site: string; n: number }[];
  thumbs: { up: number; down: number };
  answers: AnswerStats;
}

export const api = {
  overview: () => call<Overview>("GET", "/overview"),
  chats: (filter: string, site: string) => call<ChatSummary[]>("GET", `/chats?filter=${filter}&site=${encodeURIComponent(site)}`),
  chat: (id: string) => call<ChatDetail>("GET", `/chats/${id}`),
  markRead: (id: string) => call("POST", `/chats/${id}/read`),
  settings: (patch: Partial<Settings>) => call<Settings>("PATCH", "/settings", patch),
  enquiries: () => call<Enquiry[]>("GET", "/enquiries"),
  enquiryStatus: (id: string, status: Enquiry["status"]) => call("PATCH", `/enquiries/${id}`, { status }),
  stats: (days: number) => call<Stats>("GET", `/stats?days=${days}`),
};

const wsUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${BASE}${path}`;

/** A WebSocket that reconnects with backoff until closed. */
export function socket<In>(path: string, onMessage: (m: In) => void, onState?: (open: boolean) => void): { send(m: unknown): void; close(): void } {
  let ws: WebSocket | undefined;
  let closed = false;
  let tries = 0;
  let ping: number | undefined;
  const open = () => {
    ws = new WebSocket(wsUrl(path));
    ws.onopen = () => {
      tries = 0;
      onState?.(true);
      ping = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 30_000);
    };
    ws.onmessage = (e) => {
      const data = String(e.data);
      if (data.charCodeAt(0) === 68) return; // live answer preview frames: the inbox shows finished answers only
      onMessage(JSON.parse(data) as In);
    };
    ws.onclose = () => {
      clearInterval(ping);
      onState?.(false);
      if (!closed) setTimeout(open, Math.min(30_000, 1000 * 2 ** tries++));
    };
  };
  open();
  return {
    send: (m) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)),
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}

export const hubSocket = (on: (m: HubMsg) => void, onState?: (open: boolean) => void) => socket<HubMsg>("/hub/ws", on, onState);
export const chatSocket = (id: string, on: (m: ServerMsg) => void, onState?: (open: boolean) => void) =>
  socket<ServerMsg>(`/chats/${id}/ws`, on, onState) as { send(m: OwnerMsg): void; close(): void };

export type { ChatStatus };

export const usd = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
