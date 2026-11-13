import type { Env } from "./env";

export class OmnaraError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Actor {
  provider_tenant_id: string;
  provider_user_id: string;
  display_name?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  tool_call_id?: string;
  tool_type?: string;
  value?: unknown;
}

export interface TimelineEvent {
  id: string;
  sequence: number;
  event_kind: "agent_input" | "model_output" | "tool_result" | "context_checkpoint";
  turn_id?: string;
  stop_reason?: string;
  content_blocks?: ContentBlock[];
  tool_call_id?: string;
  outcome?: string;
  input_kind?: string;
}

export interface ToolCall {
  id: string;
  agent_id?: string;
  name: string;
  input: Record<string, unknown>;
  state: string;
  type: string;
}

export interface SseFrame {
  event: string;
  id?: string;
  data: string;
}

export class Omnara {
  private readonly base: string;

  constructor(private readonly env: Env) {
    this.base = `${env.OMNARA_API}/orgs/${env.OMNARA_ORG_ID}/projects/${env.OMNARA_PROJECT_ID}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.env.OMNARA_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "website-chatbot/0.1",
      ...extra,
    };
  }

  async req<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(extra),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let code = "http_" + res.status;
      let msg = res.statusText;
      try {
        const err = (await res.json()) as { code?: string; error?: string };
        code = err.code ?? code;
        msg = err.error ?? msg;
      } catch {
        // non-JSON error body
      }
      throw new OmnaraError(res.status, code, `${method} ${path}: ${msg}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async launch(o: { name: string; config: unknown; text: string; actor?: Actor; key: string }): Promise<string> {
    const res = await this.req<{ agent: { id: string } }>(
      "POST",
      "/agents",
      {
        name: o.name,
        config_source: { source: JSON.stringify(o.config), source_format: "json" },
        initial_input: { content_blocks: [{ type: "text", text: o.text }], ...(o.actor ? { actor: o.actor } : {}) },
      },
      { "Idempotency-Key": o.key },
    );
    return res.agent.id;
  }

  async sendInput(agentId: string, text: string, actor: Actor | undefined, key: string): Promise<void> {
    await this.req("POST", `/agents/${agentId}/inputs`, { content_blocks: [{ type: "text", text }], ...(actor ? { actor } : {}) }, { "Idempotency-Key": key });
  }

  updateConfig(agentId: string, config: unknown): Promise<unknown> {
    return this.req("POST", `/agents/${agentId}/config`, { source: JSON.stringify(config), source_format: "json" });
  }

  cancel(agentId: string): Promise<unknown> {
    return this.req("POST", `/agents/${agentId}/cancel`);
  }

  archive(agentId: string): Promise<unknown> {
    return this.req("POST", `/agents/${agentId}/archive`);
  }

  async costUsd(agentId: string): Promise<number> {
    const u = await this.req<{ totals?: { cost?: { provider_reported_usd?: number | string } } }>("GET", `/agents/${agentId}/usage`);
    return Number(u.totals?.cost?.provider_reported_usd ?? 0);
  }

  async eventsAfter(agentId: string, after: number): Promise<TimelineEvent[]> {
    const out: TimelineEvent[] = [];
    let cursor = after;
    for (let page = 0; page < 10; page++) {
      const r = await this.req<{ data: TimelineEvent[]; next_after_sequence: number; has_more: boolean }>(
        "GET",
        `/agents/${agentId}/events?after_sequence=${cursor}&limit=100`,
      );
      out.push(...r.data);
      if (!r.has_more) break;
      cursor = r.next_after_sequence;
    }
    return out;
  }

  async readyToolCalls(agentId: string): Promise<ToolCall[]> {
    const r = await this.req<{ data: ToolCall[] }>("GET", `/agents/${agentId}/tool-calls?state=ready&type=custom`);
    return r.data;
  }

  getToolCall(agentId: string, id: string): Promise<ToolCall> {
    return this.req<ToolCall>("GET", `/agents/${agentId}/tool-calls/${id}`);
  }

  async submitToolResult(agentId: string, id: string, ok: boolean, value: unknown): Promise<void> {
    const content_blocks = typeof value === "string" ? [{ type: "text", text: value }] : [{ type: "structured_data", value }];
    try {
      await this.req("POST", `/agents/${agentId}/tool-calls/${id}/result`, { outcome: ok ? "succeeded" : "failed", content_blocks });
    } catch (e) {
      if (!(e instanceof OmnaraError && e.status === 409)) throw e;
    }
  }

  /**
   * Opens the agent's event stream. Frames are split but not parsed: callers JSON-parse only the
   * few saved events they need, which keeps CPU low on the Workers free plan.
   */
  async *stream(agentId: string, o: { lastEventId: number; deltas: boolean; signal: AbortSignal }): AsyncGenerator<SseFrame> {
    const res = await fetch(`${this.base}/agents/${agentId}/events/stream?stream_deltas=${o.deltas}`, {
      headers: this.headers({ Accept: "text/event-stream", "Last-Event-ID": String(o.lastEventId) }),
      signal: o.signal,
    });
    if (!res.ok || !res.body) throw new OmnaraError(res.status, "stream_" + res.status, "event stream failed");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const frame = parseFrame(block);
          if (frame) yield frame;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}

function parseFrame(block: string): SseFrame | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, id, data: data.join("\n") } : null;
}
