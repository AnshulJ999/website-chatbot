import { BrainFailure, type Brain, type BrainState, type TurnCallbacks, type TurnRequest, type TurnResult } from "./types";

/**
 * Dev-only brain: canned answers shaped like real Omnara output, plus forced failures, so the
 * widget and every fallback path can be exercised for free. Scenarios:
 * omnara_down, slow (stalls), fail_first (first model fails), cap (chat cost jumps over the cap),
 * table (a slowly streamed answer with a table, bold, a link and code).
 */
export class ScriptedBrain implements Brain {
  /** fail_first: the first model asked, which keeps failing so the next one answers. */
  private failing?: string;

  constructor(private readonly scenario = "none") {}

  async turn(state: BrainState, req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    if (this.scenario === "omnara_down") throw new BrainFailure("unavailable", "scripted: Omnara down");
    if (this.scenario === "fail_first" && (this.failing ??= req.tier.model) === req.tier.model) throw new BrainFailure("error", "scripted: first model fails");
    if (!state.agentId) {
      state.agentId = "scripted";
      state.agentCostUsd = 0;
    }
    state.model = req.tier.model;
    const turnNo = ++state.lastSeq;

    await sleep(400, req.signal);
    cb.progress("Searching the knowledge base");
    if (this.scenario === "slow") await sleep(10 * 60_000, req.signal);
    await sleep(700, req.signal);
    cb.progress(`Reading "getting started"`);
    await sleep(600, req.signal);

    const lower = req.text.toLowerCase();
    if (/\b(human|person|talk to|real person)\b/.test(lower)) {
      const r = await cb.runTool("request_owner", { reason: "Visitor asked for a person" });
      const online = (r.value as { ownerOnline?: boolean }).ownerOnline;
      return this.reply(req, cb, online ? `I've asked ${req.site.ownerName} to join. They'll be with you shortly.` : `${req.site.ownerName} isn't online right now. Leave your email in the form below and they'll get back to you.`, turnNo);
    }

    if (this.scenario === "table") return this.reply(req, cb, TABLE_ANSWER, turnNo, 4, 120);

    const answer = [
      `Here's a scripted answer (turn ${turnNo}, model ${req.tier.label}). This is the **Playground's scripted brain**, so no Omnara credits were used.`,
      "",
      "- It shows how lists render",
      `- and how [a link](https://example.com/docs/getting-started) looks`,
      "",
      "SUGGESTIONS: Tell me more | How much does it cost? | Talk to a person",
    ].join("\n");
    return this.reply(req, cb, answer, turnNo);
  }

  /** Streams the text a word at a time, or in `chunk`-character pieces every `pieceMs` (the slow table answer). */
  private async reply(req: TurnRequest, cb: TurnCallbacks, text: string, turnNo: number, chunk = 0, pieceMs = 25): Promise<TurnResult> {
    if (req.streaming) {
      const pieces = chunk ? (text.match(new RegExp(`[\\s\\S]{1,${chunk}}`, "g")) ?? []) : text.split(/(?<=\s)/);
      for (const piece of pieces) {
        cb.delta(JSON.stringify({ model_call_context_id: `mcc_scripted_${turnNo}`, event: { kind: "text_delta", delta: piece } }));
        await sleep(pieceMs, req.signal);
      }
    }
    const totalCostUsd = this.scenario === "cap" ? 0.6 : 0.002 * turnNo;
    return { text, totalCostUsd };
  }

  async cancel(): Promise<void> {}
  async archive(): Promise<void> {}
}

/** The "table" scenario: bold, a table, a link and code, streamed slowly to show unfinished formatting. */
const TABLE_ANSWER = [
  "**Short answer:** most of it is free. Here's how the plans compare:",
  "",
  "| Plan | Price | What you get |",
  "| --- | --- | --- |",
  "| Free | $0 | Backups, restore and all the analysis |",
  "| Pro | $29 once | The clean-up tools and **priority support** |",
  "",
  "See [the pricing page](https://example.com/pricing) for details, or run `docker pull example/app` to try it.",
  "",
  "SUGGESTIONS: What's in Pro? | Is there a trial? | Talk to a person",
].join("\n");

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new BrainFailure("stall", "aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new BrainFailure("stall", "aborted"));
    });
  });
}
