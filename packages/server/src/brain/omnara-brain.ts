import type { Env } from "../env";
import { Omnara, OmnaraError, type Actor, type ContentBlock, type TimelineEvent } from "../omnara";
import { agentConfig } from "./agent-config";
import { BrainFailure, type Brain, type BrainState, type TurnCallbacks, type TurnRequest, type TurnResult } from "./types";

/** Events the turn reads in full. */
const PARSED = new Set(["agent_input", "model_output"]);
/** Events only counted for resuming; never parsed, since tool results carry whole knowledge files. */
const COUNTED = new Set(["tool_result", "context_checkpoint"]);
const SEQUENCE = /"sequence"\s*:\s*(\d+)/;

export class OmnaraBrain implements Brain {
  private readonly api: Omnara;
  private readonly useActor: boolean;

  constructor(env: Env) {
    this.api = new Omnara(env);
    // Omnara accepts an external actor only with a project API key, not a personal token.
    this.useActor = env.OMNARA_ACTOR === "1";
  }

  async turn(state: BrainState, req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    const actor: Actor | undefined = this.useActor ? { provider_tenant_id: req.site.key, provider_user_id: req.visitorId } : undefined;
    const config = agentConfig(req.site, req.tier, req.ownerTest);
    const fingerprint = hash(JSON.stringify(config));
    const launch = async () => {
      state.agentId = await this.api.launch({ name: `${req.site.key} chat`, config, text: req.text, actor, key: req.key });
      state.lastSeq = 0;
      state.model = req.tier.model;
      state.config = fingerprint;
      state.agentCostUsd = 0;
    };
    try {
      if (!state.agentId) await launch();
      else {
        try {
          // A model switch or edited rules, instructions or site brief reach chats already open.
          if (state.config !== fingerprint || state.model !== req.tier.model) {
            await this.api.updateConfig(state.agentId, config);
            state.model = req.tier.model;
            state.config = fingerprint;
          }
          await this.api.sendInput(state.agentId, req.text, actor, req.key);
        } catch (e) {
          // The chat's agent is gone (e.g. it lived in another Omnara project): carry on with a new one.
          if (!(e instanceof OmnaraError && e.status === 404)) throw e;
          await launch();
        }
      }
    } catch (e) {
      throw this.failure(e);
    }
    await cb.saveState();
    cb.touch();
    return this.follow(state, req, cb, false);
  }

  async resume(state: BrainState, req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    if (!state.agentId) throw new BrainFailure("error", "no agent to resume");
    return this.follow(state, req, cb, true);
  }

  /**
   * Reads the agent's events until the turn ends. When resuming, events replay from the last saved
   * place, so tool calls are taken from Omnara's list of open calls rather than from replayed frames.
   */
  private async follow(state: BrainState, req: TurnRequest, cb: TurnCallbacks, resuming: boolean): Promise<TurnResult> {
    const agentId = state.agentId!;
    const handled = new Set<string>();
    const tools: Promise<void>[] = [];
    const runTool = (id: string, name: string, input: Record<string, unknown> | undefined) => {
      if (handled.has(id)) return;
      handled.add(id);
      cb.progress(progressFor(name));
      tools.push(
        (async () => {
          const call = input ? { input } : await this.api.getToolCall(agentId, id);
          const r = await cb.runTool(name, (call.input ?? {}) as Record<string, unknown>);
          await this.api.submitToolResult(agentId, id, r.ok, r.value);
          cb.touch();
        })().catch((e) => console.error("tool", name, e)),
      );
    };

    // Replay starts after the previous turn's end, so a resumed turn already has its input.
    let sawInput = resuming;
    let reconnects = 0;
    for (;;) {
      if (req.signal.aborted) throw new BrainFailure("stall", "turn timed out");
      try {
        // Catch up on custom calls that became ready while we were not listening.
        for (const c of await this.api.readyToolCalls(agentId)) runTool(c.id, c.name, c.input);

        for await (const f of this.api.stream(agentId, { lastEventId: state.lastSeq, deltas: req.streaming, signal: req.signal })) {
          cb.touch();
          if (f.event === "model_output_delta") {
            // Forward only visible text; reasoning and tool-argument previews stay on the server.
            if (f.data.includes('"text_delta"')) cb.delta(f.data);
            continue;
          }
          if (f.event === "tool_call_update") {
            const u = JSON.parse(f.data) as { tool_call_id: string; agent_id: string; state: string; name?: string; input?: Record<string, unknown> };
            if (u.state !== "ready" || !u.name || u.agent_id !== agentId) continue;
            if (resuming) for (const c of await this.api.readyToolCalls(agentId)) runTool(c.id, c.name, c.input);
            else runTool(u.tool_call_id, u.name, u.input);
            continue;
          }
          if (f.event === "error") {
            const err = JSON.parse(f.data) as { code?: string };
            if (err.code === "service_unavailable") break;
            throw new BrainFailure("error", `stream error ${err.code}`);
          }
          if (COUNTED.has(f.event)) {
            const seq = Number(SEQUENCE.exec(f.data)?.[1]);
            if (seq) state.lastSeq = Math.max(state.lastSeq, seq);
            continue;
          }
          if (!PARSED.has(f.event)) continue;
          const ev = JSON.parse(f.data) as TimelineEvent;
          state.lastSeq = Math.max(state.lastSeq, ev.sequence);
          const done = this.onEvent(ev, cb, () => (sawInput = true), sawInput);
          if (done !== null) {
            await Promise.all(tools);
            await cb.saveState();
            const totalCostUsd = await this.api.costUsd(agentId).catch(() => NaN);
            return { text: done, totalCostUsd };
          }
        }
      } catch (e) {
        if (e instanceof BrainFailure) throw e;
        if (req.signal.aborted) throw new BrainFailure("stall", "turn timed out");
        if (++reconnects > 3) throw this.failure(e);
      }
      // Stream ended without finishing the turn: reconnect from the last saved event.
      if (++reconnects > 5) throw new BrainFailure("error", "stream kept closing");
    }
  }

  /** Returns the final answer text when this event ends the turn, else null. */
  private onEvent(ev: TimelineEvent, cb: TurnCallbacks, markInput: () => void, sawInput: boolean): string | null {
    if (ev.event_kind === "agent_input") {
      if (ev.input_kind === "content") markInput();
      return null;
    }
    if (ev.event_kind !== "model_output") return null;
    const blocks = ev.content_blocks ?? [];
    for (const b of blocks) if (b.type === "tool_call" && b.name) cb.progress(progressFor(b.name, b));
    if (ev.stop_reason !== "end_turn") {
      cb.deltaReset();
      if (ev.stop_reason && !["tool_use", "max_tokens", "pause_turn"].includes(ev.stop_reason) && !textOf(blocks)) {
        throw new BrainFailure("error", `model stopped: ${ev.stop_reason}`);
      }
      return null;
    }
    if (!sawInput) return null;
    const text = textOf(blocks);
    if (!text.trim()) throw new BrainFailure("empty", "empty answer");
    return text;
  }

  private failure(e: unknown): BrainFailure {
    if (e instanceof BrainFailure) return e;
    if (e instanceof OmnaraError && (e.status >= 500 || e.status === 429)) return new BrainFailure("unavailable", e.message);
    if (e instanceof OmnaraError) return new BrainFailure("rejected", e.message);
    return new BrainFailure("unavailable", String(e));
  }

  async cancel(state: BrainState): Promise<void> {
    if (state.agentId) await this.api.cancel(state.agentId).catch(() => {});
  }

  async archive(state: BrainState): Promise<void> {
    if (state.agentId) await this.api.archive(state.agentId);
  }
}

/** FNV-1a: a short, stable fingerprint of a string. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n\n");
}

function progressFor(name: string, block?: ContentBlock): string {
  const input = (block?.input ?? {}) as Record<string, unknown>;
  if (name.includes("search")) return "Searching the knowledge base";
  if (name.includes("read")) {
    const path = typeof input.path === "string" ? input.path : "";
    const file = path.split("/").pop()?.replace(/\.(md|mdx|txt)$/i, "").replace(/[-_]+/g, " ");
    return file ? `Reading "${file}"` : "Reading the docs";
  }
  if (name.includes("list")) return "Looking through the docs";
  if (name === "get_latest_release") return "Checking the latest release";
  if (name === "request_owner") return "Calling a person";
  if (name === "save_enquiry") return "Saving your message";
  return "Working on it";
}
