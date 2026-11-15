import { DurableObject } from "cloudflare:workers";
import {
  isEmail,
  newId,
  splitSuggestions,
  type ChatMessage,
  type ChatMode,
  type ChatStatus,
  type ClientMsg,
  type DevOptions,
  type GetInTouchReason,
  type ModelTier,
  type OwnerMsg,
  type Role,
  type ServerMsg,
  type Settings,
  type SiteConfig,
  visitorLabel,
} from "@website-chatbot/shared";
import { replyTag } from "./auth";
import { OmnaraBrain } from "./brain/omnara-brain";
import { ScriptedBrain } from "./brain/scripted-brain";
import { BrainFailure, type Brain, type BrainState, type FailureKind } from "./brain/types";
import * as db from "./db";
import { DEMO_SITE } from "./demo-site";
import { isDev, type Env } from "./env";
import { inboxLink, ntfy, sendMail, settingsLink, type Alert, type Mail } from "./notify";
import { latestRelease } from "./tools";
import { referrerLine } from "./visitor-info";

/** Sent by the Worker (after checking the token) when a socket connects. */
export interface RoomInit {
  chatId: string;
  site: string;
  visitorId: string;
  dev?: DevOptions;
  /** The visitor is on a dev site, a local page or the Playground. */
  devHost?: boolean;
  /** Started from the owner's test pages (owner pass or a dev site): tagged, alerts go to the system topic. */
  test?: boolean;
  /** "City, Region, Country" from Cloudflare. */
  location?: string;
  page?: string;
  title?: string;
  referrer?: string;
  device?: string;
}

/** "AI failed" alerts at most this often; a "many failures" alert when this many answers failed within the window. */
const FAILED_ALERT_EVERY_MS = 30 * 60_000;
const UNRELIABLE_WINDOW_MS = 30 * 60_000;
const UNRELIABLE_AFTER = 3;
const UNRELIABLE_ALERT_EVERY_MS = 2 * 3600_000;
const STATS_LINK = (env: Env) => `${env.PUBLIC_URL}/admin/#/stats`;

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
  dev?: DevOptions;
  devHost?: boolean;
  test?: boolean;
  visitorNumber?: number;
  location?: string;
  /** Messages exchanged while the owner had the chat; given to the AI on hand-back. */
  handBack: string[];
  /** When a visitor message still unanswered by the owner hands the chat back to the AI. */
  handBackAt?: number;
  /** Set while an answer is being produced; still set after a restart means the answer was cut off. */
  turnDeadline?: number;
  /** The model and question of the answer in progress, for finishing it after a cut-off. */
  turnTier?: ModelTier;
  turnQuestion?: string;
  /** Recoveries of the current answer; stops a recovery that keeps getting cut off. */
  recoveries?: number;
  /** Set after a cut-off: this chat's answers arrive whole, without streaming. */
  noStreaming?: boolean;
  transcriptsSent: number;
}

type Socket = { role: "visitor" | "owner" };

/** Timing of the answer in progress (milliseconds since epoch), saved to the answers table when it ends. */
interface TurnStats {
  start: number;
  firstPiece?: number;
  firstWord?: number;
  lookups: number;
  failedAttempts: number;
  stillShown?: boolean;
  model?: string;
  costUsd?: number;
}

const RETRY_NOTE = "[The previous answer was interrupted. Please answer the visitor's last message again.]";

/** CPU test only: a fixed amount of work, since the clock doesn't move during pure computation in Workers. */
function burnCpu(ms: number): void {
  let x = 0;
  for (let i = 0; i < ms * 150_000; i++) x += Math.sqrt(i);
  if (x < 0) console.log(x);
}

export class ChatRoom extends DurableObject<Env> {
  private st!: RoomState;
  private busy = false;
  private progress?: string;
  private abort?: AbortController;
  /** Effective owner presence (toggle on and an inbox open), refreshed on each event. */
  private online = false;
  private recovering = false;
  /** Last sign of life from the brain; tells the alarm whether a turn is still running. */
  private lastTouch = 0;
  private deltaBuf: string[] = [];
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private turn?: TurnStats;
  /** Raw visible-text frames of the current attempt; parsed only when an unfinished answer is kept. */
  private partial: string[] = [];

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
    await this.refreshOnline(settings);
    this.sendTo(server, { t: "history", messages: this.messages(role === "owner"), status: this.status(settings) });
    if (role === "visitor") {
      if (init.location) this.st.location = init.location;
      if (init.devHost !== undefined) this.st.devHost = init.devHost;
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
    // An answer still marked in progress while nothing is running was cut off: finish it now.
    if (this.st.turnDeadline && !this.busy) void this.recover("reconnect");
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
    if (msg.t === "send" || msg.t === "talk_to_owner") await this.refreshOnline(settings);
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
    if (first && !this.st.visitorNumber) {
      this.st.visitorNumber = (await db.assignVisitorNumber(this.env.DB, this.st.visitorId)) ?? undefined;
      await this.save();
    }
    this.add({ id, role: "visitor", text, meta: { via: "widget" } });

    if (count > settings.perVisitorDailyMessages) return this.toForm("limit", settings);
    if (first && settings.alertOnNewChat) {
      this.alert(site, {
        title: `${siteTag(site)} - ${this.label(settings)} - ${this.where()}`,
        lines: [`💬 ${quote(text)}`, `📄 ${this.st.page ?? "/"}`, `🔗 ${referrerLine(this.st.referrer, site.origins)}`, `📱 ${this.device()}`],
        priority: 2,
        tags: ["speech_balloon"],
        actions: [{ label: "Open chat", url: inboxLink(this.env, this.st.chatId) }],
      });
    }
    if (this.st.mode === "owner") {
      this.st.handBack.push(`Visitor: ${text}`);
      if (settings.handBackWhenAway && !this.online) return this.autoHandBack("away", settings, site);
      if (settings.handBackAfterMin > 0 && !this.st.handBackAt) this.st.handBackAt = Date.now() + settings.handBackAfterMin * 60_000;
      await this.save();
      await this.scheduleAlarm();
      if (!this.ctx.getWebSockets("owner").length) {
        this.alert(site, {
          title: `${siteTag(site)} - ${this.who(settings)} replied`,
          lines: [`💬 ${quote(text)}`],
          priority: 3,
          tags: ["speech_balloon"],
          actions: [{ label: "Open chat", url: inboxLink(this.env, this.st.chatId) }],
        });
      }
      return;
    }
    await this.respond(id, text, settings, site);
  }

  /** The AI's reply to the visitor's message, within the cost limits. */
  private async respond(id: string, text: string, settings: Settings, site: SiteConfig): Promise<void> {
    if (this.st.mode === "form") return;
    if (!settings.aiEnabled) return this.toForm("ai_off", settings);

    // Cost limits decide which tiers may answer.
    let freeOnly = false;
    if (this.st.costUsd >= settings.chatCapUsd) {
      if (settings.capAction === "get_in_touch") return this.toForm("cap", settings);
      freeOnly = true;
    }
    if ((await db.spendToday(this.env.DB)) >= settings.dailyBudgetUsd) {
      if (await db.alertDue(this.env.DB, `budget:${new Date().toISOString().slice(0, 10)}`, 86_400_000)) {
        this.alert(
          site,
          {
            title: `Chatbot - daily budget reached ($${settings.dailyBudgetUsd.toFixed(2)})`,
            lines: [
              settings.budgetAction === "get_in_touch"
                ? `💸 New answers get "Get in touch" until midnight UTC.`
                : `💸 Answers use the free models until midnight UTC.`,
            ],
            priority: 4,
            tags: ["money_with_wings"],
            actions: [{ label: "Open settings", url: settingsLink(this.env) }],
          },
          true,
        );
      }
      if (settings.budgetAction === "get_in_touch") return this.toForm("budget", settings);
      freeOnly = true;
    }
    await this.answer(id, text, settings, site, freeOnly);
  }

  // ---------- the AI turn ----------

  private brain(): Brain {
    // dev options only reach the room in dev mode or for the signed-in owner (checked in /api/session).
    if (this.st.dev?.brain === "scripted") return new ScriptedBrain(this.st.dev.scenario);
    return new OmnaraBrain(this.env);
  }

  private async answer(inputId: string, text: string, settings: Settings, site: SiteConfig, freeOnly: boolean): Promise<void> {
    const cooling = await db.coolingModels(this.env.DB);
    let tiers = settings.ladder.filter((t) => t.enabled && !cooling.has(t.model));
    if (freeOnly) tiers = tiers.filter((t) => t.free);
    const pick = this.st.dev?.model;
    if (pick) {
      // Model test (Playground or test script): this one model only.
      const known = settings.ladder.find((t) => t.model === pick);
      tiers = [{ provider: known?.provider ?? "omnara-openrouter", model: pick, label: known?.label ?? pick, free: false, enabled: true, effort: this.st.dev?.effort ?? known?.effort ?? "high" }];
    }
    if (!tiers.length) {
      // Every tier is cooling down or disabled: try the enabled ones anyway before giving up.
      tiers = settings.ladder.filter((t) => t.enabled && (!freeOnly || t.free));
    }
    if (!tiers.length) return this.toForm(freeOnly ? "cap" : "ai_unavailable", settings);

    const brain = this.brain();
    let input = this.composeInput(text);
    this.busy = true;
    this.progress = undefined;
    this.turn = { start: Date.now(), lookups: 0, failedAttempts: 0 };
    let outcome = "failed";
    // The visitor's whole wait, however many models it tries; each model also has its own limit.
    const deadline = Date.now() + settings.turnTimeoutSec * 1000;
    this.st.turnDeadline = deadline + 30_000;
    await this.save();
    await this.scheduleAlarm();
    this.broadcastStatus(settings);

    const failures: string[] = [];
    try {
      let attempt = 0;
      tiers: for (const tier of tiers) {
        for (let retry = 0; retry < 2; retry++) {
          if (this.st.mode !== "ai") {
            outcome = "owner"; // the owner took over mid-answer
            return;
          }
          if (Date.now() >= deadline) break tiers;
          this.st.turnTier = tier;
          this.st.turnQuestion = text.slice(0, 2000);
          await this.save();
          const attemptDeadline = Math.min(deadline, Date.now() + settings.modelTimeoutSec * 1000);
          try {
            const result = await this.runAttempt(brain, tier, `${inputId}-${attempt++}`, input, settings, site, attemptDeadline);
            this.turn.model = tier.label;
            this.turn.costUsd = await this.finishTurn(result.text, result.totalCostUsd, tier, site);
            void db.recordModelSuccess(this.env.DB, tier.model);
            outcome = "ok";
            return;
          } catch (e) {
            if (!(e instanceof BrainFailure)) throw e;
            const kind: FailureKind = Date.now() >= attemptDeadline ? "stall" : e.kind;
            console.error("attempt failed", tier.model, kind, e.message);
            failures.push(`${tier.label}: ${kind}`);
            this.turn.failedAttempts++;
            this.incident(site, "attempt_failed", `${kind}: ${e.message}`, tier.model);
            await brain.cancel(this.st.brain);
            if (e.kind !== "rejected") await db.recordModelFailure(this.env.DB, tier.model, settings);
            // Words the visitor already saw stay; they can ask again or talk to a person.
            const shown = this.partialText();
            if (shown) {
              this.turn.model = tier.label;
              await this.keepPartial(shown, tier, site, text, failures);
              outcome = "partial";
              return;
            }
            this.broadcast({ t: "delta_reset" });
            input = `${RETRY_NOTE}\n\nThe visitor's message: ${text}`;
            // A stalled or unreachable model rarely recovers within seconds: move to the next one.
            if (e.kind === "stall" || e.kind === "unavailable" || e.kind === "rejected") break;
          }
        }
      }
      outcome = "form";
      await this.toForm("ai_unavailable", settings);
      await this.turnFailed(site, text, failures.length ? failures : ["no model answered in time"]);
    } catch (e) {
      console.error("answer", e);
      outcome = "form";
      await this.toForm("ai_unavailable", settings);
      await this.turnFailed(site, text, [...failures, `server error: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      this.recordTurn(site, outcome);
      await this.endTurn(settings);
    }
  }

  /** Ends an answer that stopped after the visitor saw part of it: keeps those words and offers the next step. */
  private async keepPartial(shown: string, tier: ModelTier, site: SiteConfig, question: string, failures: string[]): Promise<void> {
    this.add({ id: newId("m"), role: "ai", text: splitSuggestions(shown).text, meta: { model: tier.label, costUsd: 0 } });
    const talk = site.talkLabel.charAt(0).toLowerCase() + site.talkLabel.slice(1);
    this.add({ id: newId("m"), role: "system", text: `The answer stopped early. Ask again, or ${talk}.` });
    await db.logIncident(this.env.DB, { site: site.key, chatId: this.st.chatId, kind: "answer_partial", model: tier.model, detail: `${failures.join("; ")} | ${question.slice(0, 300)}` });
  }

  /** Visible words of the current attempt, rebuilt from the raw frames kept while streaming. */
  private partialText(): string {
    let text = "";
    let ctx: string | undefined;
    for (const raw of this.partial) {
      try {
        const f = JSON.parse(raw) as { model_call_context_id?: string; event?: { kind?: string; delta?: string } };
        if (f.event?.kind !== "text_delta" || !f.event.delta) continue;
        if (f.model_call_context_id !== ctx) text = "";
        ctx = f.model_call_context_id;
        text += f.event.delta;
      } catch {
        // skip a malformed frame
      }
    }
    return text.trim();
  }

  /** Saves the timing of the answer that just ended; never blocks the chat. */
  private recordTurn(site: SiteConfig, outcome: string): void {
    const t = this.turn;
    this.turn = undefined;
    this.partial = [];
    if (!t) return;
    const since = (at?: number) => (at ? at - t.start : null);
    const p = db
      .recordAnswer(this.env.DB, {
        site: site.key,
        chatId: this.st.chatId,
        model: t.model ?? null,
        outcome,
        firstPieceMs: since(t.firstPiece),
        firstWordMs: since(t.firstWord),
        totalMs: Date.now() - t.start,
        lookups: t.lookups,
        failedAttempts: t.failedAttempts,
        costUsd: t.costUsd ?? null,
      })
      .catch((e) => console.error("answers", e));
    this.ctx.waitUntil(p);
  }

  private async endTurn(settings: Settings): Promise<void> {
    this.busy = false;
    this.progress = undefined;
    this.abort = undefined;
    this.st.turnDeadline = undefined;
    this.st.turnTier = undefined;
    this.st.turnQuestion = undefined;
    this.st.recoveries = 0;
    await this.save();
    await this.scheduleAlarm();
    this.broadcastStatus(settings);
  }

  /**
   * Finishes an answer that was cut off (Cloudflare stopped the object mid-answer): logs it, alerts,
   * and reads the answer from Omnara without streaming. This chat streams no more after a cut-off.
   */
  private async recover(trigger: "reconnect" | "alarm"): Promise<void> {
    if (this.recovering || this.busy || !this.st.turnDeadline) return;
    this.recovering = true;
    this.busy = true;
    const settings = await db.getSettings(this.env.DB);
    try {
      const site = await this.site();
      const tier = this.st.turnTier;
      const question = this.st.turnQuestion ?? "";
      this.st.noStreaming = true;
      this.st.recoveries = (this.st.recoveries ?? 0) + 1;
      const deadline = Date.now() + settings.turnTimeoutSec * 1000;
      this.st.turnDeadline = deadline + 30_000;
      await this.save();
      await this.scheduleAlarm();
      this.broadcastStatus(settings);
      await this.interrupted(site, tier, question, trigger);
      try {
        const brain = this.brain();
        if (!tier || !brain.resume || !this.st.brain.agentId) throw new BrainFailure("error", "nothing to resume");
        if (this.st.recoveries > 2) throw new BrainFailure("error", "cut off again while recovering");
        const result = await this.runAttempt(brain, tier, `resume-${Date.now()}`, question, settings, site, deadline, true);
        if (this.st.mode === "ai") await this.finishTurn(result.text, result.totalCostUsd, tier, site);
      } catch (e) {
        console.error("recover", e);
        const why = e instanceof Error ? e.message : String(e);
        if (this.st.mode === "ai") await this.toForm("ai_unavailable", settings);
        await this.turnFailed(site, question, [`answer cut off, recovery failed: ${why}`]);
      }
    } finally {
      this.recovering = false;
      await this.endTurn(settings);
    }
  }

  /** Logs a cut-off answer (no alert: it recovers itself and shows in Stats) and feeds the failures check. */
  private async interrupted(site: SiteConfig, tier: ModelTier | undefined, question: string, trigger: string): Promise<void> {
    await db.logIncident(this.env.DB, {
      site: site.key,
      chatId: this.st.chatId,
      kind: "turn_interrupted",
      model: tier?.model,
      detail: `found on ${trigger}, recovery ${this.st.recoveries ?? 1} | ${question.slice(0, 300)}`,
    });
    await this.checkUnreliable(site);
  }

  /** One "many failures" alert when failed answers pile up within the window: counts by model and site, latest question. */
  private async checkUnreliable(site: SiteConfig): Promise<void> {
    const since = Date.now() - UNRELIABLE_WINDOW_MS;
    const rows = await db.incidentsSince(this.env.DB, ["turn_failed", "turn_interrupted"], since);
    if (rows.length < UNRELIABLE_AFTER || !(await db.alertDue(this.env.DB, "unreliable", UNRELIABLE_ALERT_EVERY_MS))) return;
    const failed = rows.filter((r) => r.kind === "turn_failed");
    const cut = rows.length - failed.length;
    const causes = new Map<string, number>();
    for (const r of failed) {
      for (const f of (r.detail.split(" | ")[0] ?? "").split("; ").filter(Boolean)) causes.set(f, (causes.get(f) ?? 0) + 1);
    }
    const sites = new Map<string, number>();
    for (const r of rows) sites.set(r.site, (sites.get(r.site) ?? 0) + 1);
    const siteNames = await Promise.all([...sites].map(async ([key, n]) => `${(await db.getSite(this.env.DB, key))?.name ?? key} ${n}`));
    const latestQ = rows[0]?.detail.split(" | ").slice(1).join(" | ");
    this.alert(
      site,
      {
        title: `Chatbot - ${failed.length} failed answers in 30 min`,
        lines: [
          causes.size ? `⚠️ ${[...causes].map(([f, n]) => `${f} ×${n}`).join(" · ")}` : "",
          cut ? `✂️ ${cut} answer${cut === 1 ? "" : "s"} cut off` : "",
          `🌐 ${siteNames.join(" · ")}`,
          latestQ ? `❓ Latest: ${quote(latestQ)}` : "",
        ],
        priority: 4,
        tags: ["rotating_light"],
        actions: [{ label: "Open Stats", url: STATS_LINK(this.env) }],
      },
      true,
    );
  }

  /** Logs a failed answer and alerts (throttled), plus a "many failures" alert when failures pile up. */
  private async turnFailed(site: SiteConfig, question: string, failures: string[]): Promise<void> {
    await db.logIncident(this.env.DB, { site: site.key, chatId: this.st.chatId, kind: "turn_failed", detail: `${failures.join("; ")} | ${question.slice(0, 300)}` });
    const link = inboxLink(this.env, this.st.chatId);
    if (await db.alertDue(this.env.DB, "turn_failed", FAILED_ALERT_EVERY_MS)) {
      const settings = await db.getSettings(this.env.DB);
      this.alert(
        site,
        {
          title: `Chatbot - AI failed - ${site.name}`,
          lines: [`❓ ${quote(question)}`, `⚠️ ${failures.join(" · ")}`, `👤 ${this.who(settings)} got the contact form`],
          priority: 2,
          tags: ["warning"],
          actions: [{ label: "Open chat", url: link }],
        },
        true,
      );
    }
    await this.checkUnreliable(site);
  }

  private async runAttempt(brain: Brain, tier: ModelTier, key: string, text: string, settings: Settings, site: SiteConfig, deadline: number, resume = false) {
    const abort = new AbortController();
    this.abort = abort;
    let last = Date.now();
    this.lastTouch = last;
    this.partial = [];
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - last > settings.stallTimeoutSec * 1000 || now >= deadline) abort.abort();
      const t = this.turn;
      if (t && !t.firstWord && !t.stillShown && now - t.start >= settings.stillWorkingSec * 1000) {
        t.stillShown = true;
        this.progress = "Still working on it";
        this.broadcastStatus(settings);
      }
    }, 1000);
    if (this.env.CPU_TEST === "1" && this.st.dev?.cpuBurnMs) burnCpu(this.st.dev.cpuBurnMs);
    const req = { text, key, visitorId: this.st.visitorId, site, tier, streaming: settings.streaming && !this.st.noStreaming, signal: abort.signal, ownerTest: this.st.dev?.owner === true };
    let deltas = 0;
    const cb = {
      touch: () => {
        last = this.lastTouch = Date.now();
        if (this.turn) this.turn.firstPiece ??= last;
      },
      progress: (p: string) => {
        this.progress = p;
        if (this.turn) this.turn.lookups++;
        this.broadcastStatus(settings);
      },
      delta: (raw: string) => {
        this.partial.push(raw);
        if (this.turn) this.turn.firstWord ??= Date.now();
        this.queueDelta(raw, settings.deltaBatchMs);
        // Cut-off test: restart this object mid-answer, the way a CPU-limit kill would.
        if (!resume && this.st.dev?.cutoff && ++deltas === 15) this.ctx.abort("cut-off test");
      },
      deltaReset: () => {
        this.partial = [];
        this.dropDeltas();
        this.broadcast({ t: "delta_reset" });
      },
      runTool: (name: string, input: Record<string, unknown>) => this.runTool(name, input, settings, site),
      saveState: () => this.save(),
    };
    try {
      return await (resume && brain.resume ? brain.resume(this.st.brain, req, cb) : brain.turn(this.st.brain, req, cb));
    } finally {
      clearInterval(timer);
      // The finished answer replaces the preview, so words still waiting to be sent are dropped.
      this.dropDeltas();
    }
  }

  /** Streams words to the browser, one message per piece or in batches of `ms`. */
  private queueDelta(raw: string, ms: number): void {
    if (ms <= 0) return this.sendRaw("D" + raw);
    this.deltaBuf.push(raw);
    this.deltaTimer ??= setTimeout(() => {
      this.deltaTimer = undefined;
      const batch = this.deltaBuf;
      this.deltaBuf = [];
      // Each piece is already JSON, so joining them makes a JSON array without parsing anything.
      if (batch.length) this.sendRaw(batch.length === 1 ? "D" + batch[0] : `B[${batch.join(",")}]`);
    }, ms);
  }

  private dropDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    this.deltaBuf = [];
  }

  /** Saves the finished answer; returns what this answer cost. */
  private async finishTurn(raw: string, totalCost: number, tier: ModelTier, site: SiteConfig): Promise<number> {
    const { text, suggestions } = splitSuggestions(raw);
    const delta = Number.isFinite(totalCost) ? Math.max(0, totalCost - this.st.costUsd) : 0;
    if (Number.isFinite(totalCost)) this.st.costUsd = Math.max(this.st.costUsd, totalCost);
    this.st.pageChanged = false;
    this.add({ id: newId("m"), role: "ai", text, suggestions, meta: { model: tier.label, costUsd: delta } });
    await db.addSpend(this.env.DB, site.key, delta);
    this.index({ cost_usd: this.st.costUsd, model: tier.label, agent_id: this.st.brain.agentId ?? null });
    return delta;
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
    await this.refreshOnline(settings);
    const online = this.online;
    this.st.wantsOwner = true;
    if (!online) this.st.reason = "owner_away";
    await this.save();
    this.index({ wants_owner: 1 });
    this.broadcastStatus(settings);
    const lastQuestion = this.rows("WHERE role = 'visitor' ORDER BY seq DESC LIMIT 1")[0]?.text;
    this.alert(site, {
      title: `${siteTag(site)} - Wants you - ${this.who(settings)}`,
      lines: [
        `💬 ${quote(lastQuestion ?? reason ?? "Asked for a person")}`,
        `📄 ${this.st.page ?? "/"} · ${this.visitorMessages()} messages`,
        `📍 ${this.where()}`,
        `📱 ${this.device()}`,
        online ? "🟢 You're online: they're waiting" : "⚪ You're away: they got the message form",
      ],
      priority: 4,
      tags: ["raising_hand"],
      actions: [{ label: "Open chat", url: inboxLink(this.env, this.st.chatId) }],
    });
    return online;
  }

  private async onOwner(msg: OwnerMsg): Promise<void> {
    const settings = await db.getSettings(this.env.DB);
    const site = await this.site();
    await this.refreshOnline(settings);
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
        emailed = await this.mail(site, {
          from: site.emailFrom,
          to: this.st.visitorEmail,
          subject: `Reply from ${site.name}`,
          text: `${text}\n\n---\nYou can reply to this email, or continue the chat on ${site.name}'s website.`,
          replyTo: await this.replyAddress(site),
        });
      }
      this.add({ id: msg.id, role: "owner", text, meta: { via: "inbox", emailed } });
      this.st.handBack.push(`Owner: ${text}`);
      this.st.handBackAt = undefined;
      this.st.wantsOwner = false;
      await db.markEnquiriesReplied(this.env.DB, this.st.chatId);
    }
    if (msg.t === "owner_hand_back" && this.st.mode === "owner") {
      this.st.mode = "ai";
      this.st.ownerJoined = false;
      this.st.handBackAt = undefined;
      this.add({ id: newId("m"), role: "system", text: `${cap(site.ownerName)} has left the chat. You're chatting with the AI assistant.` });
    }
    await this.save();
    await this.scheduleAlarm();
    this.index({ mode: this.st.mode, wants_owner: this.st.wantsOwner ? 1 : 0, unread: 0 });
    this.broadcastStatus(settings);
  }

  /** Gives a taken-over chat back to the AI, which then answers the visitor's messages since the owner's last reply. */
  private async autoHandBack(why: "quiet" | "away", settings: Settings, site: SiteConfig): Promise<void> {
    if (this.st.mode !== "owner") return;
    const owner = cap(site.ownerName);
    this.st.mode = "ai";
    this.st.ownerJoined = false;
    this.st.handBackAt = undefined;
    const reason = why === "away" ? `handed back automatically: ${owner} is away` : `handed back automatically: no reply for ${settings.handBackAfterMin} min`;
    this.add({ id: newId("m"), role: "system", text: `${owner} stepped away. You're chatting with the AI assistant.`, meta: { reason } });
    const lastOwner = this.st.handBack.map((l) => l.startsWith("Owner: ")).lastIndexOf(true);
    const waiting = this.st.handBack.slice(lastOwner + 1).map((l) => l.replace(/^Visitor: /, ""));
    this.st.handBack = this.st.handBack.slice(0, lastOwner + 1);
    await this.save();
    await this.scheduleAlarm();
    this.index({ mode: "ai" });
    this.broadcastStatus(settings);
    if (waiting.length) await this.respond(newId("m"), waiting.join("\n\n"), settings, site);
  }

  /** One alarm serves both the answer deadline and the hand-back timer: the sooner one still ahead. */
  private async scheduleAlarm(): Promise<void> {
    const next = [this.st.turnDeadline, this.st.handBackAt].filter((t): t is number => !!t && t > Date.now());
    if (next.length) await this.ctx.storage.setAlarm(Math.min(...next));
    else await this.ctx.storage.deleteAlarm();
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
    this.alert(site, {
      title: `${siteTag(site)} - Message from ${name || email}`,
      lines: [
        name ? `👤 ${name}` : "",
        `✉️ ${email}`,
        `💬 ${quote(message, 400)}`,
        `📄 ${this.st.page ?? "/"} · ${Math.max(0, this.visitorMessages() - 1)} messages before this`,
        `📍 ${this.where()}`,
        `📱 ${this.device()}`,
      ],
      priority: 4,
      tags: ["envelope"],
      actions: [
        { label: "Open chat", url: link },
        { label: "Reply", url: `mailto:${email}` },
      ],
    });
    const replyTo = await this.replyAddress(site);
    void this.mail(site, {
      from: site.emailFrom,
      to: site.ownerEmail,
      subject: `${site.name} chat: message from ${name || email}`,
      text: `${name} <${email}> (via ${via}):\n\n${message}\n\nOpen the chat: ${link}`,
      replyTo: email,
    });
    void this.mail(site, {
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
    const ok = await this.mail(site, { from: site.emailFrom, to: email, subject: `Your chat with ${site.name}`, text: body, replyTo: await this.replyAddress(site) });
    this.sendTo(ws, ok ? { t: "error", code: "transcript_sent", text: `Sent to ${email}.` } : { t: "error", code: "transcript_failed", text: "Couldn't send the email. Please try again later." });
  }

  /** Where a visitor's email reply goes: back into this chat when reply-by-email is set up, else the site's inbox. */
  private async replyAddress(site: SiteConfig): Promise<string | undefined> {
    const domain = site.replyDomain || this.env.REPLY_DOMAIN;
    if (!domain) return site.ownerEmail;
    return `chat+${await replyTag(this.env.TOKEN_SECRET, this.st.chatId)}@${domain}`;
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
    const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
    this.alert(site, {
      title: `${siteTag(site)} - Email reply from ${this.st.visitorName || address}`,
      lines: [`💬 ${quote(text, 300)}`, `✉️ ${address}`],
      priority: 4,
      tags: ["incoming_envelope"],
      actions: [
        { label: "Open chat", url: inboxLink(this.env, this.st.chatId) },
        { label: "Reply", url: `mailto:${address}` },
      ],
    });
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
    if (!this.st) return;
    if (this.st.handBackAt && Date.now() >= this.st.handBackAt - 1000) {
      await this.autoHandBack("quiet", await db.getSettings(this.env.DB), await this.site());
      return;
    }
    // Otherwise an answer outlived its deadline: the object was cut off or reset mid-answer.
    if (this.st.turnDeadline && !(this.busy && Date.now() - this.lastTouch < 60_000)) {
      // Still "busy" with no sign of life for a minute: the code running the answer is gone.
      this.busy = false;
      this.recovering = false;
      await this.recover("alarm");
    }
    if (this.st.handBackAt) await this.scheduleAlarm();
  }

  // ---------- helpers ----------

  private async ensureState(init: RoomInit): Promise<void> {
    if (this.st) {
      if (init.dev) {
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
      dev: init.dev,
      devHost: init.devHost,
      test: init.test,
      location: init.location,
      handBack: [],
      transcriptsSent: 0,
    };
    await this.save();
    this.index({ page: init.page ?? null, referrer: init.referrer ?? null, test: init.test ? 1 : 0 });
  }

  private async site(): Promise<SiteConfig> {
    let s = await db.getSite(this.env.DB, this.st.site);
    if (!s && isDev(this.env) && this.st.site === "demo") s = DEMO_SITE;
    if (!s) throw new Error(`unknown site ${this.st.site}`);
    // Playground: compare what the bot calls the owner.
    return this.st.dev?.ownerName ? { ...s, ownerName: this.st.dev.ownerName } : s;
  }

  private async refreshOnline(settings: Settings): Promise<void> {
    this.online = await this.hub().ownerPresent();
  }

  /** Sends an alert without blocking the chat; a failed one is logged. System alerts and every alert from a test chat go to the system topic. */
  private alert(site: SiteConfig, a: Alert, system = false): void {
    const test = !!(this.st.test || this.st.devHost);
    const target = system || test ? null : site;
    const p = ntfy(this.env, target, { ...a, dev: test, priority: test ? 2 : a.priority }).then((error) => {
      if (error) return this.incidentNow(site, "alert_failed", `${a.title}: ${error}`);
    });
    this.ctx.waitUntil(p.catch((e) => console.error("alert", e)));
  }

  /** Sends an email; a failure is logged and returns false. */
  private async mail(site: SiteConfig, m: Mail): Promise<boolean> {
    const error = await sendMail(this.env, m);
    if (error) await this.incidentNow(site, "mail_failed", `${m.subject} -> ${m.to}: ${error}`);
    return !error;
  }

  private incident(site: SiteConfig, kind: db.IncidentKind, detail: string, model?: string): void {
    this.ctx.waitUntil(this.incidentNow(site, kind, detail, model));
  }

  private incidentNow(site: SiteConfig, kind: db.IncidentKind, detail: string, model?: string): Promise<void> {
    return db.logIncident(this.env.DB, { site: site.key, chatId: this.st.chatId, kind, detail, model }).catch((e) => console.error("incident", e));
  }

  private where(): string {
    return this.st.location ?? "Unknown location";
  }

  private device(): string {
    return this.st.device ?? "Unknown device";
  }

  /** "Visitor #42" (or the code or friendly name, per Settings). */
  private label(settings: Settings): string {
    return visitorLabel(settings.visitorLabel, { visitorId: this.st.visitorId, number: this.st.visitorNumber });
  }

  private who(settings: Settings): string {
    return this.st.visitorName || this.st.visitorEmail || this.label(settings);
  }

  private visitorMessages(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE role = 'visitor'").one().n;
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

  private status(_settings: Settings): ChatStatus {
    return {
      mode: this.st.mode,
      busy: this.busy,
      progress: this.progress,
      ownerOnline: this.online,
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
    const owner = m.role === "owner" ? { owner_at: msg.at } : {};
    this.index({ message_count: this.st.seq, preview: `${label(m.role)}: ${m.text}`.slice(0, 160), ...unread, ...owner });
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

/** "KopiaLens chat", the start of every alert title. */
function siteTag(site: SiteConfig): string {
  return `${site.alertName ?? site.name} chat`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function quote(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

function label(role: Role, site?: SiteConfig): string {
  if (role === "visitor") return "Visitor";
  if (role === "ai") return site?.assistantName ?? "Assistant";
  if (role === "owner") return site ? cap(site.ownerName) : "Owner";
  return "Note";
}
