import { BrainFailure, type Brain, type BrainState, type TurnCallbacks, type TurnRequest, type TurnResult } from "./types";

/**
 * Dev-only brain: canned answers shaped like real Omnara output, plus forced failures, so the
 * widget and every fallback path can be exercised for free. Scenarios:
 * omnara_down, slow (stalls), fail_first (first model fails), cap (chat cost jumps over the cap).
 */
export class ScriptedBrain implements Brain {
  /** fail_first: the first model asked, which keeps failing so the next one answers. */
  private failing?: string;

  constructor(private readonly scenario = "none") {}

  async turn(state: BrainState, req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    if (this.scenario === "omnara_down") throw new BrainFailure("unavailable", "scripted: Omnara down");
    if (this.scenario === "fail_first" && (this.failing ??= req.tier.model) === req.tier.model) throw new BrainFailure("error", "scripted: first model fails");
    state.agentId ??= "scripted";
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

  private async reply(req: TurnRequest, cb: TurnCallbacks, text: string, turnNo: number): Promise<TurnResult> {
    if (req.streaming) {
      for (const word of text.split(/(?<=\s)/)) {
        cb.delta(JSON.stringify({ model_call_context_id: `mcc_scripted_${turnNo}`, event: { kind: "text_delta", delta: word } }));
        await sleep(25, req.signal);
      }
    }
    const totalCostUsd = this.scenario === "cap" ? 0.6 : 0.002 * turnNo;
    return { text, totalCostUsd };
  }

  async cancel(): Promise<void> {}
  async archive(): Promise<void> {}
}

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
