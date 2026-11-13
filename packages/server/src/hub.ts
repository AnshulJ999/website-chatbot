import { DurableObject } from "cloudflare:workers";
import type { HubMsg } from "@website-chatbot/shared";
import { getChatSummary } from "./db";
import type { Env } from "./env";

/** How long after the last open inbox tab goes quiet the owner still counts as present. */
const PRESENCE_GRACE_MS = 10 * 60_000;

/** One instance ("hub"): pushes chat and enquiry changes to open inbox tabs, and knows whether one is open. */
export class Hub extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    await this.seen();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (data === '{"t":"ping"}') {
      ws.send(JSON.stringify({ t: "pong" } satisfies HubMsg));
      await this.seen();
    }
  }

  override async webSocketClose(): Promise<void> {
    await this.seen();
  }

  /** True while an inbox tab is open, or was within the grace period (a phone that just locked). */
  async ownerPresent(): Promise<boolean> {
    if (this.ctx.getWebSockets().length) return true;
    const last = (await this.ctx.storage.get<number>("lastSeen")) ?? 0;
    return Date.now() - last < PRESENCE_GRACE_MS;
  }

  async chat(id: string): Promise<void> {
    if (!this.ctx.getWebSockets().length) return;
    const chat = await getChatSummary(this.env.DB, id);
    if (chat) this.send({ t: "chat", chat });
  }

  async enquiry(id: string): Promise<void> {
    this.send({ t: "enquiry", id });
  }

  async settings(): Promise<void> {
    this.send({ t: "settings" });
  }

  private seen(): Promise<void> {
    return this.ctx.storage.put("lastSeen", Date.now());
  }

  private send(msg: HubMsg): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {
        // closed
      }
    }
  }
}
