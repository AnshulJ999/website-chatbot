import type { ModelTier, SiteConfig } from "@website-chatbot/shared";

/** "rejected" = Omnara refused the request (4xx): a setup problem, not a sign the model is unhealthy. */
export type FailureKind = "stall" | "error" | "empty" | "unavailable" | "rejected";

export class BrainFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}

/** What a brain keeps between turns; stored by the ChatRoom. */
export interface BrainState {
  agentId?: string;
  lastSeq: number;
  model?: string;
  /** Fingerprint of the config the agent last got; a change (rules, instructions, site brief) updates the agent. */
  config?: string;
  /** This agent's total cost so far; starts at 0 with each new agent. */
  agentCostUsd?: number;
}

export interface TurnRequest {
  text: string;
  /** Unique per attempt; used as the Omnara Idempotency-Key. */
  key: string;
  visitorId: string;
  site: SiteConfig;
  tier: ModelTier;
  streaming: boolean;
  signal: AbortSignal;
  /** The signed-in owner is testing from the Playground: the agent may talk openly about its setup. */
  ownerTest?: boolean;
}

export interface TurnCallbacks {
  /** Any sign of life from the brain; feeds the stall watchdog. */
  touch(): void;
  progress(text: string): void;
  delta(raw: string): void;
  deltaReset(): void;
  runTool(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; value: unknown }>;
  saveState(): Promise<void>;
}

export interface TurnResult {
  text: string;
  /** Total cost of this chat's agent so far, in USD. */
  totalCostUsd: number;
}

export interface Brain {
  turn(state: BrainState, req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult>;
  /** Finishes a turn already sent (e.g. after the server was cut off mid-answer); req.text is not sent again. */
  resume?(state: BrainState, req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult>;
  /** Stops any work in progress; safe to call when idle. */
  cancel(state: BrainState): Promise<void>;
  archive(state: BrainState): Promise<void>;
}
