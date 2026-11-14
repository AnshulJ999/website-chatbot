import { DurableObject } from "cloudflare:workers";
import type { HubIn, HubMsg } from "@website-chatbot/shared";
import { getChatSummary, getSettings } from "./db";
import type { Env } from "./env";

/** What an inbox tab last reported: when the owner was last active on that device (0 = idle or locked). */
type Attachment = { lastActive: number };

/**
 * One instance ("hub"): pushes chat and enquiry changes to open inbox tabs, and tracks whether the owner is around.
 * Each tab reports activity; a closed tab's last activity still counts until it expires (a phone that just locked).
 */
export class Hub extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ lastActive: 0 } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let m: HubIn;
    try {
      m = JSON.parse(data) as HubIn;
    } catch {
      return;
    }
    if (m.t === "ping") ws.send(JSON.stringify({ t: "pong" } satisfies HubMsg));
    if (m.t === "activity") {
      ws.serializeAttachment({ lastActive: m.state === "active" ? Date.now() : 0 } satisfies Attachment);
      await this.broadcastPresence();
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const last = (ws.deserializeAttachment() as Attachment | null)?.lastActive ?? 0;
    const kept = (await this.ctx.storage.get<number>("closedActive")) ?? 0;
    if (last > kept) await this.ctx.storage.put("closedActive", last);
  }

  /** Whether visitors see the owner as online: "available" or "away" as set in the inbox, or in "auto" recent activity on any device. */
  async ownerPresent(): Promise<boolean> {
    const s = await getSettings(this.env.DB);
    if (s.presence !== "auto") return s.presence === "available";
    let last = (await this.ctx.storage.get<number>("closedActive")) ?? 0;
    for (const ws of this.ctx.getWebSockets()) last = Math.max(last, (ws.deserializeAttachment() as Attachment | null)?.lastActive ?? 0);
    return Date.now() - last < s.awayAfterMin * 60_000;
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
    await this.broadcastPresence();
  }

  private async broadcastPresence(): Promise<void> {
    this.send({ t: "presence", online: await this.ownerPresent() });
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
