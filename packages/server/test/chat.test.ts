// The risky server paths, through the public API and sockets: model fallback, the whole-answer
// time limit, the per-chat spending cap, and owner takeover. Uses the scripted brain (dev mode).
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ChatMessage, type ChatStatus, type ServerMsg, type SessionResponse, type Settings } from "@website-chatbot/shared";

const ORIGIN = "http://localhost:5290";

async function setSettings(patch: Partial<Settings>): Promise<void> {
  const res = await SELF.fetch("http://chatbot.test/admin/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  expect(res.status).toBe(200);
}

/** A live socket that records every message and status it receives. */
class Peer {
  messages: ChatMessage[] = [];
  statuses: ChatStatus[] = [];
  deltas = 0;
  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      const data = String(e.data);
      if (data.startsWith("D") || data.startsWith("B")) {
        this.deltas++;
        return;
      }
      const m = JSON.parse(data) as ServerMsg;
      if (m.t === "message") this.messages.push(m.message);
      if (m.t === "history") this.messages.push(...m.messages);
      if (m.t === "status" || m.t === "history") this.statuses.push(m.status);
    });
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  get status(): ChatStatus | undefined {
    return this.statuses.at(-1);
  }
  async until(check: () => boolean, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function openChat(scenario = "none"): Promise<{ visitor: Peer; chatId: string; reconnect: () => Promise<Peer> }> {
  const res = await SELF.fetch("http://chatbot.test/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      site: "demo",
      newChat: true,
      page: { url: `${ORIGIN}/`, title: "Test", referrer: "" },
      device: { width: 1280, touch: false, lang: "en", tz: "UTC" },
      dev: { brain: "scripted", scenario },
    }),
  });
  expect(res.status).toBe(200);
  const s = (await res.json()) as SessionResponse;
  const connect = async () => {
    const ws = await SELF.fetch(`http://chatbot.test/api/chat/ws?token=${encodeURIComponent(s.token)}&page=/`, { headers: { Upgrade: "websocket", Origin: ORIGIN } });
    expect(ws.webSocket).toBeTruthy();
    return new Peer(ws.webSocket!);
  };
  return { visitor: await connect(), chatId: s.chatId, reconnect: connect };
}

async function ownerSocket(chatId: string): Promise<Peer> {
  const res = await SELF.fetch(`http://chatbot.test/admin/api/chats/${chatId}/ws`, { headers: { Upgrade: "websocket" } });
  return new Peer(res.webSocket!);
}

async function incidents(chatId: string, kind: string): Promise<{ model: string | null }[]> {
  const { results } = await env.DB.prepare("SELECT model FROM incidents WHERE chat_id = ? AND kind = ?").bind(chatId, kind).all<{ model: string | null }>();
  return results;
}

const aiAnswers = (p: Peer) => p.messages.filter((m) => m.role === "ai");

describe("answers", () => {
  // A plain error is retried once on the same model, then the next model answers.
  it("falls back to the next model when the first one fails, and logs the failure", async () => {
    await setSettings({ aiEnabled: true, stallTimeoutSec: 30, turnTimeoutSec: 75, capAction: "get_in_touch", chatCapUsd: 0.5 });
    const { visitor, chatId } = await openChat("fail_first");
    visitor.send({ t: "send", id: "m1", text: "Hello" });
    await visitor.until(() => aiAnswers(visitor).length === 1);
    const [first, second] = DEFAULT_SETTINGS.ladder;
    expect(aiAnswers(visitor)[0]!.text).toContain(second!.label);
    expect((await incidents(chatId, "attempt_failed")).map((r) => r.model)).toEqual([first!.model, first!.model]);
    expect(await incidents(chatId, "turn_failed")).toEqual([]);
  });

  it("gives up within the whole-answer time limit when every model stalls", async () => {
    await setSettings({ stallTimeoutSec: 5, turnTimeoutSec: 12 });
    const { visitor, chatId } = await openChat("slow");
    const started = Date.now();
    visitor.send({ t: "send", id: "m1", text: "Hello" });
    await visitor.until(() => visitor.status?.mode === "form");
    expect(Date.now() - started).toBeLessThan(16_000);
    expect(visitor.status?.reason).toBe("ai_unavailable");
    expect(aiAnswers(visitor)).toEqual([]);
    expect(await incidents(chatId, "turn_failed")).toHaveLength(1);
    await setSettings({ stallTimeoutSec: 30, turnTimeoutSec: 75 });
  });

  it("switches a chat over its spending cap to Get in touch", async () => {
    await setSettings({ capAction: "get_in_touch", chatCapUsd: 0.5 });
    const { visitor } = await openChat("cap");
    visitor.send({ t: "send", id: "m1", text: "First question" });
    await visitor.until(() => aiAnswers(visitor).length === 1);
    visitor.send({ t: "send", id: "m2", text: "Second question" });
    await visitor.until(() => visitor.status?.mode === "form");
    expect(visitor.status?.reason).toBe("cap");
    expect(aiAnswers(visitor)).toHaveLength(1);
  });

  // A chat that got the contact form after a failed answer used to stay a form on every later visit.
  it("gives a failed chat back to the AI when the visitor comes back", async () => {
    const { visitor, reconnect } = await openChat("omnara_down");
    visitor.send({ t: "send", id: "m1", text: "Hello" });
    await visitor.until(() => visitor.status?.mode === "form");
    expect(visitor.status?.reason).toBe("ai_unavailable");
    visitor.ws.close();
    const again = await reconnect();
    await again.until(() => again.status !== undefined);
    expect(again.status?.mode).toBe("ai");
  });
});

describe("owner takeover", () => {
  it("shows the owner's reply to the visitor and stops the AI answering", async () => {
    const { visitor, chatId } = await openChat();
    visitor.send({ t: "send", id: "m1", text: "Hello" });
    await visitor.until(() => aiAnswers(visitor).length === 1);

    const owner = await ownerSocket(chatId);
    owner.send({ t: "owner_send", id: "o1", text: "Hi, it's me", email: false });
    await visitor.until(() => visitor.messages.some((m) => m.role === "owner" && m.text === "Hi, it's me"));
    expect(visitor.status?.mode).toBe("owner");

    visitor.send({ t: "send", id: "m2", text: "Great, thanks" });
    await owner.until(() => owner.messages.some((m) => m.id === "m2"));
    await new Promise((r) => setTimeout(r, 2500));
    expect(aiAnswers(visitor)).toHaveLength(1);
  });

  // Joining used to cut the answer off: half an answer, "The answer stopped early", and a logged failure.
  it("lets an answer in progress finish when the owner joins", async () => {
    const { visitor, chatId } = await openChat("table");
    visitor.send({ t: "send", id: "m1", text: "What does it cost?" });
    await visitor.until(() => visitor.deltas > 3);
    const owner = await ownerSocket(chatId);
    owner.send({ t: "owner_join" });
    await visitor.until(() => aiAnswers(visitor).length === 1);
    expect(aiAnswers(visitor)[0]!.text).toContain("| Pro |");
    expect(visitor.messages.some((m) => m.role === "system" && m.text.includes("stopped early"))).toBe(false);
    expect(await incidents(chatId, "answer_partial")).toEqual([]);
    expect(visitor.status?.mode).toBe("owner");
  });

  // "Waiting for you" used to stay set until the owner typed a reply in that chat.
  it("clears Waiting for you when the owner hands the chat back", async () => {
    const { visitor, chatId } = await openChat();
    visitor.send({ t: "talk_to_owner" });
    await visitor.until(() => visitor.status?.wantsOwner === true);
    const owner = await ownerSocket(chatId);
    owner.send({ t: "owner_join" });
    await visitor.until(() => visitor.status?.mode === "owner");
    owner.send({ t: "owner_hand_back" });
    await visitor.until(() => visitor.status?.mode === "ai");
    expect(visitor.status?.wantsOwner).toBe(false);
  });
});
