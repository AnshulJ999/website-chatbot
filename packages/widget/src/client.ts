import { newId, type AnalyticsEvent, type ChatMessage, type ClientMsg, type ServerMsg, type SessionRequest, type SessionResponse } from "@website-chatbot/shared";
import { flash, live, pageUrl, patch, site } from "./store";

export interface ClientOptions {
  server: string;
  siteKey: string;
  dev?: SessionRequest["dev"];
}

/** One streamed piece of an answer, as Omnara sends it. */
interface DeltaFrame {
  model_call_context_id?: string;
  event?: { kind?: string; delta?: string };
}

interface Saved {
  visitorId?: string;
  visitorKey?: string;
  chatId?: string;
}

const storeKey = (site: string) => `wcb:${site}`;
const cacheKey = (site: string) => `wcb:${site}:cache`;
const seenKey = (site: string) => `wcb:${site}:seen`;

/** A copy of the current chat, shown at once on the next page load while the server's copy loads. */
interface Cache {
  chatId: string;
  messages: ChatMessage[];
}

export interface PastChat {
  id: string;
  preview: string;
  updatedAt: number;
  /** When the owner last wrote in it. */
  ownerAt?: number;
}

function readCache(siteKey: string): Cache | null {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(siteKey)) ?? "null") as Cache | null;
  } catch {
    return null;
  }
}

function load(siteKey: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(storeKey(siteKey)) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

function persist(siteKey: string, s: Saved): void {
  try {
    localStorage.setItem(storeKey(siteKey), JSON.stringify(s));
  } catch {
    // storage blocked: the chat still works, it just won't resume
  }
}

export function emit(event: AnalyticsEvent, props: Record<string, unknown> = {}): void {
  const detail = { event, site: site.value?.key, ...props };
  window.dispatchEvent(new CustomEvent("website-chatbot", { detail }));
  const ph = (window as unknown as { posthog?: { capture?: (e: string, p: object) => void } }).posthog;
  try {
    ph?.capture?.(`chatbot_${event}`, detail);
  } catch {
    // analytics must never break the chat
  }
}

/** Waits between tries while the server can't be reached: about five minutes in all. */
const RETRY_DELAYS = [2000, 5000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000];

export class ChatClient {
  private ws?: WebSocket;
  private session?: SessionResponse;
  private outbox: ClientMsg[] = [];
  /** Visitor messages sent but not yet confirmed by the server; sent again after a reconnect. */
  private pending = new Map<string, { text: string; at: number }>();
  private retries = 0;
  private failures = 0;
  private retryTimer?: number;
  private pageTimer?: number;
  private lastPage = pageUrl();
  private previewCtx = "";
  private closedByUs = false;
  private starting?: Promise<boolean>;

  constructor(private readonly o: ClientOptions) {
    window.addEventListener("online", () => {
      const conn = live.value.conn;
      if (conn === "unreachable" || conn === "reconnecting") this.retryNow();
    });
  }

  /** Shows the saved chat straight away; the server's copy replaces it once connected. */
  hydrate(): void {
    const saved = load(this.o.siteKey);
    if (!saved.chatId) return;
    const cache = readCache(this.o.siteKey);
    if (cache?.chatId === saved.chatId && cache.messages.length) patch({ messages: cache.messages });
    else patch({ loading: true });
  }

  private saveCache(): void {
    const chatId = this.session?.chatId;
    if (!chatId) return;
    const messages = live.value.messages.filter((m) => m.seq !== Number.MAX_SAFE_INTEGER).slice(-60);
    try {
      localStorage.setItem(cacheKey(this.o.siteKey), JSON.stringify({ chatId, messages } satisfies Cache));
    } catch {
      // no copy kept; the chat still loads from the server
    }
  }

  /** Dev only: brain and scenario for the next session. */
  setDev(dev: ClientOptions["dev"]): void {
    this.o.dev = { ...dev, pass: this.o.dev?.pass };
  }

  /** Creates or resumes the session and opens the live connection. */
  start(newChat = false): Promise<boolean> {
    if (!newChat && this.ws && this.ws.readyState <= WebSocket.OPEN) return Promise.resolve(true);
    this.starting ??= this.doStart(newChat).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(newChat: boolean, turnstileToken?: string): Promise<boolean> {
    patch({ conn: live.value.conn === "open" ? "reconnecting" : "connecting" });
    const saved = load(this.o.siteKey);
    const body: SessionRequest = {
      site: this.o.siteKey,
      visitorId: saved.visitorId,
      visitorKey: saved.visitorKey,
      chatId: newChat ? undefined : saved.chatId,
      newChat,
      turnstileToken,
      page: { url: pageUrl(), title: document.title, referrer: document.referrer },
      device: { width: window.innerWidth, touch: matchMedia("(pointer: coarse)").matches, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      dev: this.o.dev,
    };
    let res: Response;
    try {
      res = await fetch(`${this.o.server}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      return this.unreachable(true);
    }
    if (res.status === 401 && !turnstileToken) {
      const { siteKey } = (await res.json().catch(() => ({}))) as { siteKey?: string };
      const token = siteKey ? await turnstile(siteKey) : null;
      if (token) return this.doStart(newChat, token);
      return this.unreachable(false);
    }
    // A server error or rate limit may pass; a refused site or origin won't.
    if (!res.ok) return this.unreachable(res.status >= 500 || res.status === 429);
    this.session = (await res.json()) as SessionResponse;
    site.value = this.session.site;
    persist(this.o.siteKey, { visitorId: this.session.visitorId, visitorKey: this.session.visitorKey, chatId: this.session.chatId });
    if (newChat) patch({ messages: [], preview: "", formDismissed: false, loading: false });
    this.connect();
    return true;
  }

  private connect(): void {
    if (!this.session) return;
    this.closedByUs = true;
    this.ws?.close();
    this.closedByUs = false;
    const q = new URLSearchParams({
      token: this.session.token,
      page: pathOf(pageUrl()),
      title: document.title,
      ref: document.referrer,
      device: `${matchMedia("(pointer: coarse)").matches ? "touch" : "mouse"} · ${window.innerWidth}px`,
    });
    const url = `${this.o.server.replace(/^http/, "ws")}${this.session.wsUrl}?${q}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.failures = 0;
      clearTimeout(this.retryTimer);
      patch({ conn: "open" });
      for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
      this.watchPage();
    };
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = () => {
      if (this.ws !== ws || this.closedByUs) return;
      clearInterval(this.pageTimer);
      const delay = [1000, 2000, 5000, 10000, 20000][Math.min(this.retries++, 4)]!;
      patch({ conn: this.retries > 4 ? "unreachable" : "reconnecting" });
      setTimeout(() => {
        // Tokens expire; a fresh session also covers a server restart.
        if (this.ws === ws) void this.doStart(false);
      }, delay);
    };
  }

  /** Shows "Chat isn't available" and, when it may pass, keeps trying in the background. */
  private unreachable(retry: boolean): false {
    patch({ conn: "unreachable" });
    clearTimeout(this.retryTimer);
    if (retry && this.failures < RETRY_DELAYS.length) {
      this.retryTimer = window.setTimeout(() => void this.start(), RETRY_DELAYS[this.failures++]);
    }
    return false;
  }

  /** "Try again", or the browser is back online: start over at once. */
  retryNow(): void {
    clearTimeout(this.retryTimer);
    this.failures = 0;
    this.retries = 0;
    void this.start();
  }

  /** Whether the owner is online now; the panel asks about once a minute so "Online now" can't go stale. */
  async checkPresence(): Promise<void> {
    try {
      const res = await fetch(`${this.o.server}/api/presence`, { cache: "no-store" });
      if (!res.ok) return;
      const { ownerOnline } = (await res.json()) as { ownerOnline: boolean };
      if (ownerOnline !== live.value.status.ownerOnline) patch({ status: { ...live.value.status, ownerOnline } });
    } catch {
      // keep the last known status
    }
  }

  private onMessage(data: string): void {
    const head = data.charCodeAt(0);
    if (head === 68 /* "D": one raw Omnara delta frame */ || head === 66 /* "B": a JSON array of them */) {
      try {
        const frames = (head === 68 ? [JSON.parse(data.slice(1))] : JSON.parse(data.slice(1))) as DeltaFrame[];
        let preview = live.value.preview;
        for (const f of frames) {
          if (f.event?.kind !== "text_delta" || !f.event.delta) continue;
          const ctx = f.model_call_context_id ?? "";
          if (ctx !== this.previewCtx) preview = "";
          this.previewCtx = ctx;
          preview += f.event.delta;
        }
        if (preview !== live.value.preview) patch({ preview });
      } catch {
        // ignore a malformed preview frame
      }
      return;
    }
    const msg = JSON.parse(data) as ServerMsg;
    switch (msg.t) {
      case "history": {
        // A message sent as the connection dropped never reached the server: send it again (the server ignores repeats).
        const have = new Set(msg.messages.map((m) => m.id));
        const resend = [...this.pending].filter(([id, p]) => !have.has(id) && Date.now() - p.at < 120_000);
        this.pending = new Map(resend);
        const mine = resend.map(([id, p]) => ({ id, seq: Number.MAX_SAFE_INTEGER, role: "visitor" as const, text: p.text, at: p.at }));
        patch({ messages: [...msg.messages, ...mine], status: mine.length ? { ...msg.status, busy: msg.status.mode === "ai" } : msg.status, preview: "", loading: false });
        for (const m of mine) this.ws?.send(JSON.stringify({ t: "send", id: m.id, text: m.text } satisfies ClientMsg));
        this.saveCache();
        return;
      }
      case "message": {
        if (msg.message.role === "visitor") this.pending.delete(msg.message.id);
        const list = live.value.messages.filter((m) => m.id !== msg.message.id);
        list.push(msg.message);
        list.sort((a, b) => a.seq - b.seq);
        patch({ messages: list, preview: msg.message.role === "ai" ? "" : live.value.preview });
        this.saveCache();
        return;
      }
      case "update":
        patch({ messages: live.value.messages.map((m) => (m.id === msg.message.id ? msg.message : m)) });
        this.saveCache();
        return;
      case "status":
        if (msg.status.reason === "owner_away" && live.value.status.reason !== "owner_away") patch({ formDismissed: false });
        patch({ status: msg.status, ...(msg.status.busy ? {} : { preview: "" }) });
        return;
      case "delta_reset":
        this.previewCtx = "";
        patch({ preview: "" });
        return;
      case "error":
        // A message refused while an answer was running is not stored, so it isn't sent again later.
        if (msg.code === "busy") this.pending.clear();
        flash(msg.text, msg.code.endsWith("_sent") ? "info" : "error");
        return;
      default:
        return;
    }
  }

  private send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else {
      this.outbox.push(m);
      void this.start();
    }
  }

  say(text: string): void {
    const id = newId("m");
    const first = !live.value.messages.some((m) => m.role === "visitor");
    patch({
      messages: [...live.value.messages, { id, seq: Number.MAX_SAFE_INTEGER, role: "visitor", text, at: Date.now() }],
      status: { ...live.value.status, busy: live.value.status.mode === "ai" },
    });
    this.pending.set(id, { text, at: Date.now() });
    this.send({ t: "send", id, text });
    if (first) emit("first_message");
  }

  /** "Try the assistant again" on the form shown after a failed answer. */
  retryAi(): void {
    this.send({ t: "retry_ai" });
  }

  talkToOwner(): void {
    this.send({ t: "talk_to_owner" });
    emit("talked_to_owner");
  }

  feedback(msgId: string, value: 1 | -1 | 0): void {
    patch({ messages: live.value.messages.map((m) => (m.id === msgId ? { ...m, feedback: value === 0 ? undefined : value } : m)) });
    this.send({ t: "feedback", msgId, value });
  }

  contact(name: string, email: string, message: string): void {
    this.send({ t: "contact", name, email, message });
    emit("enquiry_sent");
  }

  emailTranscript(email: string): void {
    this.send({ t: "email_transcript", email });
  }

  newChat(): Promise<boolean> {
    this.pending.clear();
    return this.start(true);
  }

  /** All of this browser's visitor's chats on this site. */
  private async myChats(): Promise<PastChat[]> {
    const saved = load(this.o.siteKey);
    if (!saved.visitorId || !saved.visitorKey) return [];
    try {
      const res = await fetch(`${this.o.server}/api/my-chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: this.o.siteKey, visitorId: saved.visitorId, visitorKey: saved.visitorKey }),
      });
      if (!res.ok) return [];
      return ((await res.json()) as { chats: PastChat[] }).chats;
    } catch {
      return [];
    }
  }

  /** The visitor's earlier chats, without the current one. */
  async pastChats(): Promise<PastChat[]> {
    const current = this.session?.chatId ?? load(this.o.siteKey).chatId;
    return (await this.myChats()).filter((c) => c.id !== current);
  }

  /** True when the owner has written in the saved chat since the visitor last had it open. */
  async ownerReplied(): Promise<boolean> {
    const chatId = load(this.o.siteKey).chatId;
    if (!chatId) return false;
    let seen = 0;
    try {
      seen = Number(localStorage.getItem(seenKey(this.o.siteKey))) || 0;
    } catch {
      // treat as never seen
    }
    const chat = (await this.myChats()).find((c) => c.id === chatId);
    return !!chat?.ownerAt && chat.ownerAt > seen;
  }

  /** Records that the visitor has seen the chat as it is now. */
  markSeen(): void {
    try {
      localStorage.setItem(seenKey(this.o.siteKey), String(Date.now()));
    } catch {
      // the reply notice may show once more
    }
  }

  /** Reopens one of the visitor's earlier chats. */
  switchTo(chatId: string): Promise<boolean> {
    persist(this.o.siteKey, { ...load(this.o.siteKey), chatId });
    this.pending.clear();
    patch({ messages: [], preview: "", formDismissed: false, loading: true });
    this.starting = this.doStart(false).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private watchPage(): void {
    clearInterval(this.pageTimer);
    // Single-page sites change URL without reloading; a cheap poll catches it.
    this.pageTimer = window.setInterval(() => {
      const url = pageUrl();
      if (url === this.lastPage) return;
      this.lastPage = url;
      this.send({ t: "page", url: pathOf(url), title: document.title });
    }, 1500);
  }
}

function pathOf(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

let turnstileLoading: Promise<void> | undefined;

/** Runs a Turnstile check in a small light-DOM box (Turnstile can't render inside a shadow root). */
async function turnstile(siteKey: string): Promise<string | null> {
  type TS = { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void };
  const w = window as unknown as { turnstile?: TS };
  turnstileLoading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile"));
    document.head.appendChild(s);
  });
  try {
    await turnstileLoading;
  } catch {
    return null;
  }
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;bottom:96px;right:24px;z-index:2147483647";
  document.body.appendChild(box);
  return new Promise((resolve) => {
    const id = w.turnstile!.render(box, {
      sitekey: siteKey,
      appearance: "interaction-only",
      callback: (token: string) => done(token),
      "error-callback": () => done(null),
      "expired-callback": () => done(null),
    });
    const done = (token: string | null) => {
      w.turnstile?.remove(id);
      box.remove();
      resolve(token);
    };
  });
}
