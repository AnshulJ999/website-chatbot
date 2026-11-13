import { DurableObject } from "cloudflare:workers";
import {
  isEmail,
  newId,
  splitSuggestions,
  type ChatMessage,
  type ChatMode,
  type ChatStatus,
  type ClientMsg,
  type GetInTouchReason,
  type ModelTier,
  type OwnerMsg,
  type Role,
  type ServerMsg,
  type Settings,
  type SiteConfig,
} from "@website-chatbot/shared";
import { replyTag } from "./auth";
import { OmnaraBrain } from "./brain/omnara-brain";
import { ScriptedBrain } from "./brain/scripted-brain";
import { BrainFailure, type Brain, type BrainState } from "./brain/types";
import * as db from "./db";
import { DEMO_SITE } from "./demo-site";
import { isDev, type Env } from "./env";
import { inboxLink, ntfy, sendMail } from "./notify";
import { latestRelease } from "./tools";

/** Sent by the Worker (after checking the token) when a socket connects. */
export interface RoomInit {
  chatId: string;
  site: string;
  visitorId: string;
  dev?: { brain?: string; scenario?: string };
  page?: string;
  title?: string;
  referrer?: string;
  device?: string;
}

interface RoomState {
  chatId: string;
  site: string;
  visitorId: string;
  mode: ChatMode;
  reason?: GetInTouchReason;
  ownerJoined: boolean;
  wantsOwner: boolean;
  contactSent: boolean;
  visitorEmail?: string;
  visitorName?: string;
  brain: BrainState;
  costUsd: number;
  seq: number;
  page?: string;
  pageTitle?: string;
  referrer?: string;
  device?: string;
  pageChanged: boolean;
  dev?: { brain?: string; scenario?: string };
  /** Messages exchanged while the owner had the chat; given to the AI on hand-back. */
  handBack: string[];
  /** Set while an answer is being produced; the alarm uses it to recover from an evicted object. */
  turnDeadline?: number;
  transcriptsSent: number;
}

type Socket = { role: "visitor" | "owner" };

const RETRY_NOTE = "[The previous answer was interrupted. Please answer the visitor's last message again.]";

export class ChatRoom extends DurableObject<Env> {
  private st!: RoomState;
  private busy = false;
  private progress?: string;
  private abort?: AbortController;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
        suggestions TEXT, feedback INTEGER, meta TEXT)`);
      const saved = await ctx.storage.get<RoomState>("state");
      if (saved) this.st = saved;
    });
  }

  // ---------- connections ----------

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const role = new URL(req.url).searchParams.get("role") === "owner" ? "owner" : "visitor";
    const init = JSON.parse(decodeURIComponent(req.headers.get("X-Init") ?? "%7B%7D")) as RoomInit;
    await this.ensureState(init);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role } satisfies Socket);

    const settings = await db.getSettings(this.env.DB);
    this.sendTo(server, { t: "history", messages: this.messages(role === "owner"), status: this.status(settings) });
    if (role === "visitor") {
      if (init.page && init.page !== this.st.page) {
        this.st.page = init.page;
        this.st.pageTitle = init.title;
        this.st.pageChanged = true;
      }
      await this.save();
      this.index({ visitor_online: 1, page: this.st.page ?? null });
      this.broadcast({ t: "presence", visitorOnline: true, page: this.st.page }, "owner");
    } else {
      this.sendTo(server, { t: "presence", visitorOnline: this.ctx.getWebSockets("visitor").length > 0, page: this.st.page });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || data.length > 20_000) return;
    const { role } = ws.deserializeAttachment() as Socket;
    let msg: ClientMsg | OwnerMsg;
    try {
      msg = JSON.parse(data) as ClientMsg | OwnerMsg;
    } catch {
      return;
    }
    if (msg.t === "ping") return this.sendTo(ws, { t: "pong" });
    if (role === "owner") return this.onOwner(msg as OwnerMsg);
    return this.onVisitor(ws, msg as ClientMsg);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const { role } = ws.deserializeAttachment() as Socket;
    if (role !== "visitor") return;
    const left = this.ctx.getWebSockets("visitor").filter((s) => s !== ws).length === 0;
    if (left) {
      this.index({ visitor_online: 0 });
      this.broadcast({ t: "presence", visitorOnline: false, page: this.st.page }, "owner");
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ---------- visitor ----------

  private async onVisitor(ws: WebSocket, msg: ClientMsg): Promise<void> {
    const settings = await db.getSettings(this.env.DB);
    const site = await this.site();
    switch (msg.t) {
      case "send":
        return this.onVisitorSend(ws, msg.id, msg.text, settings, site);
      case "talk_to_owner":
        await this.requestOwner("Visitor pressed the button", settings, site);
        return;
      case "feedback": {
        const v = msg.value === 0 ? null : msg.value;
        this.ctx.storage.sql.exec("UPDATE messages SET feedback = ? WHERE id = ? AND role = 'ai'", v, msg.msgId);
        const updated = this.message(msg.msgId);
        if (updated) this.broadcast({ t: "update", message: updated }, "owner");
        const counts = this.ctx.storage.sql
          .exec<{ up: number; down: number }>("SELECT SUM(feedback = 1) AS up, SUM(feedback = -1) AS down FROM messages")
          .one();
        this.index({ thumbs_up: counts.up ?? 0, thumbs_down: counts.down ?? 0 });
        return;
      }
      case "contact":
        return this.onContact(ws, msg.name, msg.email, msg.message, settings, site);
      case "email_transcript":
        return this.onEmailTranscript(ws, msg.email, site);
      case "page":
        if (msg.url !== this.st.page) {
          this.st.page = msg.url.slice(0, 500);
          this.st.pageTitle = msg.title.slice(0, 200);
          this.st.pageChanged = true;
          await this.save();
          this.index({ page: this.st.page });
          this.broadcast({ t: "presence", visitorOnline: true, page: this.st.page }, "owner");
        }
        return;
    }
  }

  private async onVisitorSend(ws: WebSocket, id: string, raw: string, settings: Settings, site: SiteConfig): Promise<void> {
    const text = raw.trim().slice(0, settings.maxMessageChars);
    if (!text) return;
    if (this.busy) return this.sendTo(ws, { t: "error", code: "busy", text: "Please wait for the answer to finish." });
    if (this.message(id)) return; // resent after a reconnect

    const count = await db.countVisitorMessage(this.env.DB, this.st.visitorId);
    const first = this.st.seq === 0 || !this.hasRole("visitor");
    this.add({ id, role: "visitor", text, meta: { via: "widget" } });

    if (count > settings.perVisitorDailyMessages) return this.toForm("limit", settings);
    if (first && settings.alertOnNewChat) {
      void ntfy(this.env, { title: `New chat on ${site.name}`, message: text, url: inboxLink(this.env, this.st.chatId), tags: ["speech_balloon"] });
    }
    if (this.st.mode === "owner") {
      this.st.handBack.push(`Visitor: ${text}`);
      await this.save();
      if (!this.ctx.getWebSockets("owner").length) {
        void ntfy(this.env, { title: `Reply in ${site.name} chat`, message: text, url: inboxLink(this.env, this.st.chatId), priority: 4 });
      }
      return;
    }
    if (this.st.mode === "form") return;
    if (!settings.aiEnabled) return this.toForm("ai_off", settings);

    // Cost limits decide which tiers may answer.
    let freeOnly = false;
    if (this.st.costUsd >= settings.chatCapUsd) {
      if (settings.capAction === "get_in_touch") return this.toForm("cap", settings);
      freeOnly = true;
    }
    if ((await db.spendToday(this.env.DB)) >= settings.dailyBudgetUsd) {
      if (settings.budgetAction === "get_in_touch") return this.toForm("budget", settings);
      freeOnly = true;
    }
    await this.answer(id, text, settings, site, freeOnly);
  }

  // ---------- the AI turn ----------

  private brain(): Brain {
    if (isDev(this.env) && this.st.dev?.brain === "scripted") return new ScriptedBrain(this.st.dev.scenario);
    return new OmnaraBrain(this.env);
  }

  private async answer(inputId: string, text: string, settings: Settings, site: SiteConfig, freeOnly: boolean): Promise<void> {
    const cooling = await db.coolingModels(this.env.DB);
    let tiers = settings.ladder.filter((t) => t.enabled && !cooling.has(t.model));
    if (freeOnly) tiers = tiers.filter((t) => t.free);
    if (!tiers.length) {
      // Every tier is cooling down or disabled: try the enabled ones anyway before giving up.
      tiers = settings.ladder.filter((t) => t.enabled && (!freeOnly || t.free));
    }
    if (!tiers.length) return this.toForm(freeOnly ? "cap" : "ai_unavailable", settings);

    const brain = this.brain();
    let input = this.composeInput(text);
    this.busy = true;
    this.progress = undefined;
    this.st.turnDeadline = Date.now() + (settings.turnTimeoutSec + 30) * 1000;
    await this.save();
    await this.ctx.storage.setAlarm(this.st.turnDeadline);
    this.broadcastStatus(settings);

    try {
      let attempt = 0;
      for (const tier of tiers) {
        for (let retry = 0; retry < 2; retry++) {
          if (this.st.mode !== "ai") return; // the owner took over mid-answer
          try {
            const result = await this.runAttempt(brain, tier, `${inputId}-${attempt++}`, input, settings, site);
            await this.finishTurn(result.text, result.totalCostUsd, tier, site);
            void db.recordModelSuccess(this.env.DB, tier.model);
            return;
          } catch (e) {
            if (!(e instanceof BrainFailure)) throw e;
            console.error("turn failed", tier.model, e.kind, e.message);
            this.broadcast({ t: "delta_reset" });
            await brain.cancel(this.st.brain);
            if (e.kind !== "rejected") await db.recordModelFailure(this.env.DB, tier.model, settings);
            input = `${RETRY_NOTE}\n\nThe visitor's message: ${text}`;
            if (e.kind === "unavailable" && retry === 0) break; // Omnara itself is failing: next tier won't help much, but try once
          }
        }
      }
      await this.toForm("ai_unavailable", settings);
      void ntfy(this.env, { title: `AI failed on ${site.name}`, message: `Every model failed for: ${text}`, url: inboxLink(this.env, this.st.chatId), priority: 4, tags: ["warning"] });
    } catch (e) {
      console.error("answer", e);
      await this.toForm("ai_unavailable", settings);
    } finally {
      this.busy = false;
      this.progress = undefined;
      this.abort = undefined;
      this.st.turnDeadline = undefined;
      await this.save();
      await this.ctx.storage.deleteAlarm();
      this.broadcastStatus(settings);
    }
  }

  private async runAttempt(brain: Brain, tier: ModelTier, key: string, text: string, settings: Settings, site: SiteConfig) {
    const abort = new AbortController();
    this.abort = abort;
    let last = Date.now();
    const started = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - last > settings.stallTimeoutSec * 1000 || now - started > settings.turnTimeoutSec * 1000) abort.abort();
    }, 1000);
    try {
      return await brain.turn(
        this.st.brain,
        { text, key, visitorId: this.st.visitorId, site, tier, streaming: settings.streaming, signal: abort.signal },
        {
          touch: () => (last = Date.now()),
          progress: (p) => {
            this.progress = p;
            this.broadcastStatus(settings);
          },
          delta: (raw) => this.sendRaw("D" + raw),
          deltaReset: () => this.broadcast({ t: "delta_reset" }),
          runTool: (name, input) => this.runTool(name, input, settings, site),
          saveState: () => this.save(),
        },
      );
    } finally {
      clearInterval(timer);
    }
  }

  private async finishTurn(raw: string, totalCost: number, tier: ModelTier, site: SiteConfig): Promise<void> {
    const { text, suggestions } = splitSuggestions(raw);
    const delta = Number.isFinite(totalCost) ? Math.max(0, totalCost - this.st.costUsd) : 0;
    if (Number.isFinite(totalCost)) this.st.costUsd = Math.max(this.st.costUsd, totalCost);
    this.st.pageChanged = false;
    this.add({ id: newId("m"), role: "ai", text, suggestions, meta: { model: tier.label, costUsd: delta } });
    await db.addSpend(this.env.DB, site.key, delta);
    this.index({ cost_usd: this.st.costUsd, model: tier.label, agent_id: this.st.brain.agentId ?? null });
  }

  /** Visitor text plus the context the agent should know about, or a recap when the agent is new. */
  private composeInput(text: string): string {
    const lines: string[] = [];
    const isNewAgent = !this.st.brain.agentId;
    if (isNewAgent || this.st.pageChanged) {
      const ctx = [`page "${this.st.pageTitle ?? ""}" (${this.st.page ?? "unknown"})`];
      if (isNewAgent && this.st.referrer) ctx.push(`came from ${this.st.referrer}`);
      if (isNewAgent && this.st.device) ctx.push(this.st.device);
      lines.push(`[Visitor context: ${ctx.join("; ")}]`);
    }
    if (isNewAgent) {
      const earlier = this.messages(false).filter((m) => m.role !== "system").slice(-11, -1);
      if (earlier.length) lines.push(`[Earlier in this chat:\n${earlier.map((m) => `${label(m.role)}: ${m.text}`).join("\n")}]`);
    }
    if (this.st.handBack.length) {
      lines.push(`[While you were away, the site owner talked with the visitor:\n${this.st.handBack.join("\n")}]`);
      this.st.handBack = [];
    }
    lines.push(text);
    return lines.join("\n\n");
  }

  private async runTool(name: string, input: Record<string, unknown>, settings: Settings, site: SiteConfig): Promise<{ ok: boolean; value: unknown }> {
    switch (name) {
      case "request_owner": {
        const online = await this.requestOwner(String(input.reason ?? ""), settings, site);
        return { ok: true, value: { ownerOnline: online, note: online ? "The owner was alerted and can join this chat." : "The owner is offline; the visitor now sees a form to leave their email." } };
      }
      case "save_enquiry": {
        const name = String(input.name ?? "").trim();
        const email = String(input.email ?? "").trim();
        const message = String(input.message ?? "").trim();
        if (!name || !isEmail(email) || !message) return { ok: false, value: "A name, a valid email address and a message are all required." };
        await this.saveEnquiry(name, email, message, site, "the AI");
        return { ok: true, value: { saved: true, note: `${site.ownerName} will reply by email.` } };
      }
      case "get_latest_release":
        return latestRelease(this.env, site.releasesRepo);
      default:
        return { ok: false, value: `Unknown tool ${name}` };
    }
  }

  // ---------- owner ----------

  private async requestOwner(reason: string, settings: Settings, site: SiteConfig): Promise<boolean> {
    const online = settings.ownerOnline;
    this.st.wantsOwner = true;
    if (!online) this.st.reason = "owner_away";
    await this.save();
    this.index({ wants_owner: 1 });
    this.broadcastStatus(settings);
    void ntfy(this.env, {
      title: `${site.name}: a visitor wants you`,
      message: reason || "Visitor asked for a person",
      url: inboxLink(this.env, this.st.chatId),
      priority: online ? 5 : 4,
      tags: ["raising_hand"],
    });
    return online;
  }

  private async onOwner(msg: OwnerMsg): Promise<void> {
    const settings = await db.getSettings(this.env.DB);
    const site = await this.site();
    if (msg.t === "owner_join" || (msg.t === "owner_send" && this.st.mode !== "owner")) {
      this.abort?.abort();
      await this.brain().cancel(this.st.brain);
      this.st.mode = "owner";
      this.st.ownerJoined = true;
      this.st.reason = undefined;
      this.add({ id: newId("m"), role: "system", text: `${cap(site.ownerName)} joined the chat` });
    }
    if (msg.t === "owner_send") {
      const text = msg.text.trim().slice(0, 5000);
      if (!text || this.message(msg.id)) return;
      let emailed = false;
      if (msg.email && this.st.visitorEmail) {
        emailed = await sendMail(this.env, {
          from: site.emailFrom,
          to: this.st.visitorEmail,
          subject: `Reply from ${site.name}`,
          text: `${text}\n\n---\nYou can reply to this email, or continue the chat on ${site.name}'s website.`,
          replyTo: await this.replyAddress(),
        });
      }
      this.add({ id: msg.id, role: "owner", text, meta: { via: "inbox", emailed } });
      this.st.handBack.push(`Owner: ${text}`);
      this.st.wantsOwner = false;
      await db.markEnquiriesReplied(this.env.DB, this.st.chatId);
    }
    if (msg.t === "owner_hand_back" && this.st.mode === "owner") {
      this.st.mode = "ai";
      this.st.ownerJoined = false;
      this.add({ id: newId("m"), role: "system", text: `${site.assistantName} is back` });
    }
    await this.save();
    this.index({ mode: this.st.mode, wants_owner: this.st.wantsOwner ? 1 : 0, unread: 0 });
    this.broadcastStatus(settings);
  }

  // ---------- forms and email ----------

  private async onContact(ws: WebSocket, name: string, email: string, message: string, settings: Settings, site: SiteConfig): Promise<void> {
    name = name.trim().slice(0, 200);
    email = email.trim().slice(0, 254);
    message = message.trim().slice(0, 5000);
    if (!isEmail(email) || !message) return this.sendTo(ws, { t: "error", code: "contact_invalid", text: "Please add a valid email and a message." });
    if (this.st.contactSent && this.st.visitorEmail === email && this.messages(false).some((m) => m.text === message)) return;
    this.add({ id: newId("m"), role: "visitor", text: message, meta: { via: "widget" } });
    await this.saveEnquiry(name, email, message, site, "the form");
    if (this.st.reason === "owner_away" || this.st.reason === "asked") this.st.reason = undefined;
    await this.save();
    this.broadcastStatus(settings);
  }

  private async saveEnquiry(name: string, email: string, message: string, site: SiteConfig, via: string): Promise<void> {
    const id = newId("e");
    await db.insertEnquiry(this.env.DB, { id, chatId: this.st.chatId, site: site.key, name, email, message, status: "new", createdAt: Date.now() });
    await db.setVisitorContact(this.env.DB, this.st.visitorId, name || null, email);
    this.st.contactSent = true;
    this.st.visitorEmail = email;
    this.st.visitorName = name || undefined;
    await this.save();
    this.add({ id: newId("m"), role: "system", text: `Message sent. ${cap(site.ownerName)} will reply to ${email}.` });
    this.index({ wants_owner: 1 });
    void this.hub().enquiry(id);
    const link = inboxLink(this.env, this.st.chatId);
    void ntfy(this.env, { title: `New message on ${site.name}`, message: `${name} <${email}>: ${message}`, url: link, priority: 4, tags: ["envelope"] });
    const replyTo = await this.replyAddress();
    void sendMail(this.env, {
      from: site.emailFrom,
      to: site.ownerEmail,
      subject: `${site.name} chat: message from ${name || email}`,
      text: `${name} <${email}> (via ${via}):\n\n${message}\n\nOpen the chat: ${link}`,
      replyTo: email,
    });
    void sendMail(this.env, {
      from: site.emailFrom,
      to: email,
      subject: `We got your message - ${site.name}`,
      text: `Hi${name ? " " + name : ""},\n\nThanks for your message. ${cap(site.ownerName)} will reply to this address soon.\n\nYour message:\n${message}\n\nYou can reply to this email to add anything.`,
      replyTo,
    });
  }

  private async onEmailTranscript(ws: WebSocket, email: string, site: SiteConfig): Promise<void> {
    if (!isEmail(email)) return this.sendTo(ws, { t: "error", code: "email_invalid", text: "That email address doesn't look right." });
    if (this.st.transcriptsSent >= 3) return this.sendTo(ws, { t: "error", code: "transcript_limit", text: "This chat was already emailed a few times." });
    this.st.transcriptsSent++;
    await this.save();
    const body = this.messages(false)
      .map((m) => `${label(m.role, site)} (${new Date(m.at).toISOString().slice(0, 16).replace("T", " ")} UTC):\n${m.text}`)
      .join("\n\n");
    const ok = await sendMail(this.env, { from: site.emailFrom, to: email, subject: `Your chat with ${site.name}`, text: body, replyTo: await this.replyAddress() });
    this.sendTo(ws, ok ? { t: "error", code: "transcript_sent", text: `Sent to ${email}.` } : { t: "error", code: "transcript_failed", text: "Couldn't send the email. Please try again later." });
  }

  private async replyAddress(): Promise<string | undefined> {
    if (!this.env.REPLY_DOMAIN) return undefined;
    return `chat+${await replyTag(this.env.TOKEN_SECRET, this.st.chatId)}@${this.env.REPLY_DOMAIN}`;
  }

  // ---------- RPC from the Worker ----------

  /** A visitor replied to one of our emails. */
  async emailReply(from: string, text: string): Promise<void> {
    if (!this.st) return;
    const site = await this.site();
    this.add({ id: newId("m"), role: "visitor", text: text.slice(0, 10_000), meta: { via: "email" } });
    if (this.st.mode !== "owner") {
      this.st.mode = "owner";
      this.st.ownerJoined = true;
    }
    this.st.wantsOwner = true;
    if (!this.st.visitorEmail) this.st.visitorEmail = from;
    await this.save();
    this.index({ mode: this.st.mode, wants_owner: 1 });
    this.broadcastStatus(await db.getSettings(this.env.DB));
    void ntfy(this.env, { title: `Email reply on ${site.name}`, message: `${from}: ${text.slice(0, 500)}`, url: inboxLink(this.env, this.st.chatId), priority: 4, tags: ["envelope"] });
  }

  async transcript(): Promise<ChatMessage[]> {
    return this.st ? this.messages(true) : [];
  }

  async state(): Promise<{ mode: ChatMode; ownerJoined: boolean; visitorEmail?: string; agentId?: string; costUsd: number } | null> {
    if (!this.st) return null;
    return { mode: this.st.mode, ownerJoined: this.st.ownerJoined, visitorEmail: this.st.visitorEmail, agentId: this.st.brain.agentId, costUsd: this.st.costUsd };
  }

  /** The Omnara agent was archived for idleness; a later message starts a new one with a recap. */
  async archiveAgent(): Promise<void> {
    if (!this.st?.brain.agentId) return;
    if (this.st.brain.agentId !== "scripted") await this.brain().archive(this.st.brain);
    this.st.brain = { lastSeq: 0 };
    await this.save();
  }

  override async alarm(): Promise<void> {
    // Only fires if a turn outlived its deadline, e.g. the object was evicted mid-answer.
    if (!this.st?.turnDeadline || this.busy) return;
    this.st.turnDeadline = undefined;
    await this.save();
    this.add({ id: newId("m"), role: "system", text: "Sorry, that answer didn't come through. Please ask again." });
    this.broadcastStatus(await db.getSettings(this.env.DB));
  }

  // ---------- helpers ----------

  private async ensureState(init: RoomInit): Promise<void> {
    if (this.st) {
      if (isDev(this.env) && init.dev) {
        // Switching between the scripted and real brain mid-chat starts a fresh agent.
        if (init.dev.brain !== this.st.dev?.brain) this.st.brain = { lastSeq: 0 };
        this.st.dev = init.dev;
        await this.save();
      }
      return;
    }
    this.st = {
      chatId: init.chatId,
      site: init.site,
      visitorId: init.visitorId,
      mode: "ai",
      ownerJoined: false,
      wantsOwner: false,
      contactSent: false,
      brain: { lastSeq: 0 },
      costUsd: 0,
      seq: 0,
      page: init.page,
      pageTitle: init.title,
      referrer: init.referrer,
      device: init.device,
      pageChanged: true,
      dev: isDev(this.env) ? init.dev : undefined,
      handBack: [],
      transcriptsSent: 0,
    };
    await this.save();
    this.index({ page: init.page ?? null, referrer: init.referrer ?? null });
  }

  private async site(): Promise<SiteConfig> {
    const s = await db.getSite(this.env.DB, this.st.site);
    if (s) return s;
    if (isDev(this.env) && this.st.site === "demo") return DEMO_SITE;
    throw new Error(`unknown site ${this.st.site}`);
  }

  private save(): Promise<void> {
    return this.ctx.storage.put("state", this.st);
  }

  private hub() {
    return this.env.HUB.get(this.env.HUB.idFromName("hub"));
  }

  /** Updates the chat's D1 index row and tells the live inbox. Never blocks the chat. */
  private index(patch: Parameters<typeof db.upsertChat>[3]): void {
    const p = db
      .upsertChat(this.env.DB, this.st.chatId, { site: this.st.site, visitorId: this.st.visitorId }, patch)
      .then(() => this.hub().chat(this.st.chatId))
      .catch((e) => console.error("index", e));
    this.ctx.waitUntil(p);
  }

  private status(settings: Settings): ChatStatus {
    return {
      mode: this.st.mode,
      busy: this.busy,
      progress: this.progress,
      ownerOnline: settings.ownerOnline,
      ownerJoined: this.st.ownerJoined,
      wantsOwner: this.st.wantsOwner,
      reason: this.st.mode === "form" ? this.st.reason : this.st.reason === "owner_away" ? "owner_away" : undefined,
      contactSent: this.st.contactSent,
      visitorEmail: this.st.visitorEmail,
    };
  }

  private broadcastStatus(settings: Settings): void {
    this.broadcast({ t: "status", status: this.status(settings) });
  }

  private async toForm(reason: GetInTouchReason, settings: Settings): Promise<void> {
    this.st.mode = "form";
    this.st.reason = reason;
    await this.save();
    this.index({ mode: "form" });
    this.broadcastStatus(settings);
  }

  private add(m: { id: string; role: Role; text: string; suggestions?: string[]; meta?: ChatMessage["meta"] }): ChatMessage {
    const msg: ChatMessage = { ...m, seq: ++this.st.seq, at: Date.now() };
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, seq, role, text, at, suggestions, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
      msg.id,
      msg.seq,
      msg.role,
      msg.text,
      msg.at,
      msg.suggestions?.length ? JSON.stringify(msg.suggestions) : null,
      msg.meta ? JSON.stringify(msg.meta) : null,
    );
    void this.save();
    this.broadcast({ t: "message", message: msg });
    const ownerWatching = this.ctx.getWebSockets("owner").length > 0;
    const unread = m.role === "visitor" && !ownerWatching ? { unread: this.unreadCount() } : {};
    this.index({ message_count: this.st.seq, preview: `${label(m.role)}: ${m.text}`.slice(0, 160), ...unread });
    return msg;
  }

  private unreadCount(): number {
    const lastOwner = this.ctx.storage.sql.exec<{ s: number | null }>("SELECT MAX(seq) AS s FROM messages WHERE role = 'owner'").one().s ?? 0;
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE role = 'visitor' AND seq > ?", lastOwner).one().n;
  }

  private hasRole(role: Role): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM messages WHERE role = ? LIMIT 1", role).toArray().length > 0;
  }

  private message(id: string): ChatMessage | undefined {
    return this.rows("WHERE id = ?", id)[0];
  }

  private messages(forOwner: boolean): ChatMessage[] {
    const all = this.rows("ORDER BY seq");
    return forOwner ? all : all.map(({ meta: _meta, ...m }) => m);
  }

  private rows(where: string, ...args: unknown[]): ChatMessage[] {
    type Row = { id: string; seq: number; role: Role; text: string; at: number; suggestions: string | null; feedback: number | null; meta: string | null };
    return this.ctx.storage.sql
      .exec<Row>(`SELECT * FROM messages ${where}`, ...args)
      .toArray()
      .map((r) => ({
        id: r.id,
        seq: r.seq,
        role: r.role,
        text: r.text,
        at: r.at,
        ...(r.suggestions ? { suggestions: JSON.parse(r.suggestions) as string[] } : {}),
        ...(r.feedback ? { feedback: r.feedback as 1 | -1 } : {}),
        ...(r.meta ? { meta: JSON.parse(r.meta) as ChatMessage["meta"] } : {}),
      }));
  }

  private sendTo(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket already closed
    }
  }

  private sendRaw(frame: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        // socket already closed
      }
    }
  }

  /** Visitor sockets never see owner-only meta (model, cost). */
  private broadcast(msg: ServerMsg, only?: "owner" | "visitor"): void {
    const full = JSON.stringify(msg);
    let visitorCopy = full;
    if ((msg.t === "message" || msg.t === "update") && msg.message.meta) {
      const { meta: _meta, ...m } = msg.message;
      visitorCopy = JSON.stringify({ ...msg, message: m });
    }
    for (const ws of this.ctx.getWebSockets(only)) {
      const { role } = ws.deserializeAttachment() as Socket;
      try {
        ws.send(role === "owner" ? full : visitorCopy);
      } catch {
        // socket already closed
      }
    }
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function label(role: Role, site?: SiteConfig): string {
  if (role === "visitor") return "Visitor";
  if (role === "ai") return site?.assistantName ?? "Assistant";
  if (role === "owner") return site ? cap(site.ownerName) : "Owner";
  return "Note";
}
