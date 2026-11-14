// Playground-only: applies the Design menu's look choices (data-d-* on <html>) and the Playground
// panel's test setup (data-pg-*). Never part of the production widget bundle.
import { DEFAULT_UI, type ChatMessage, type ChatStatus, type PublicSiteConfig, type WidgetUi } from "@website-chatbot/shared";
import type { ChatClient } from "./client";
import type { WidgetOptions } from "./main";
import { OWNER_NAMES, TALK_WORDING } from "./dev-wording";
import { EMPTY_STATUS, forced, live, pageOverride, patch, site, ui, type View } from "./store";

let base: Pick<PublicSiteConfig, "talkLabel" | "ownerName" | "proactive"> | null = null;
let lastDev = "";
let bubbleTimer = 0;

export function initDev(_host: HTMLElement, opts: WidgetOptions, client: ChatClient): void {
  const apply = () => {
    const d = document.documentElement.dataset;
    const pick = <K extends keyof WidgetUi>(key: K, value: string | undefined) => (value ?? opts.ui?.[key] ?? site.value?.ui[key] ?? DEFAULT_UI[key]) as WidgetUi[K];
    ui.value = {
      launcher: pick("launcher", d.dLauncher),
      corner: pick("corner", d.dCorner),
      panel: pick("panel", d.dPanel),
      suggestions: pick("suggestions", d.dSuggestions),
      talkPlacement: pick("talkPlacement", d.dTalk),
      notice: pick("notice", d.dNotice),
      actions: pick("actions", d.dActions),
    };

    const ownerName = d.dOwner && OWNER_NAMES[d.dOwner];
    if (site.value) {
      base ??= { talkLabel: site.value.talkLabel, ownerName: site.value.ownerName, proactive: site.value.proactive };
      const talkLabel = (d.dTalkword && TALK_WORDING[d.dTalkword]) || base.talkLabel;
      const greetOn = d.dGreeting ? d.dGreeting === "on" : base.proactive.enabled;
      const delaySec = Number(d.dGreetdelay) || base.proactive.delaySec;
      const proactive = { ...base.proactive, enabled: greetOn, delaySec, text: base.proactive.text || `Questions about ${site.value.name}? Ask here.` };
      const next = { ...site.value, talkLabel, ownerName: ownerName || base.ownerName, proactive };
      const p = site.value.proactive;
      if (next.talkLabel !== site.value.talkLabel || next.ownerName !== site.value.ownerName || p.enabled !== greetOn || p.delaySec !== delaySec || p.text !== proactive.text) site.value = next;
      clearTimeout(bubbleTimer);
      if (greetOn && !live.value.open && !live.value.messages.length) bubbleTimer = window.setTimeout(() => patch({ bubble: true }), delaySec * 1000);
      else if (!greetOn) patch({ bubble: false });
    }

    pageOverride.value = d.pgPage || null;
    const state = d.pgState ?? "live";
    forced.value = state === "live" ? null : sample(state);

    const dev = {
      brain: (d.pgBrain ?? "scripted") as "real" | "scripted",
      scenario: d.pgScenario ?? "none",
      ...(d.pgBrain === "real" && Number(d.pgCpu) > 0 ? { cpuBurnMs: Number(d.pgCpu) } : {}),
      ...(d.pgBrain === "real" && d.pgCutoff === "1" ? { cutoff: true } : {}),
      ...(d.pgBrain === "real" && d.pgModel ? { model: d.pgModel, effort: d.pgEffort ?? "high" } : {}),
      ...(d.pgBrain === "real" && d.pgOwner === "1" ? { owner: true } : {}),
      ...(ownerName ? { ownerName } : {}),
    };
    const key = JSON.stringify(dev);
    client.setDev(dev);
    // A different brain or scenario starts a fresh chat so the next answer uses it.
    if (lastDev && key !== lastDev && live.value.open) void client.newChat();
    lastDev = key;
  };
  apply();
  window.addEventListener("design-change", apply);
  window.addEventListener("pg-change", apply);
}

const t0 = Date.now() - 5 * 60_000;
let seq = 0;
const msg = (role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `s${++seq}`,
  seq,
  role,
  text,
  at: t0 + seq * 20_000,
  ...extra,
});

function sample(state: string): View {
  seq = 0;
  const owner = site.value?.ownerName ?? "Anshul";
  const q = msg("visitor", "Does it work with an existing Kopia repository?");
  const a = msg("ai", "Yes. Point it at your existing repository and it reads your snapshots and policies as they are. Nothing is converted.\n\n- Works with local, SFTP and S3 repositories\n- See [Getting started](https://example.com/docs/getting-started) for the steps", {
    suggestions: ["How do I connect it?", "Is it free?", "Talk to a person"],
  });
  const st = (p: Partial<ChatStatus>): ChatStatus => ({ ...EMPTY_STATUS, ownerOnline: true, ...p });
  const base: View = { open: true, bubble: false, messages: [], preview: "", status: st({}), conn: "open", menu: false, formDismissed: false };
  const ask = () => msg("visitor", "Can I talk to someone?");
  switch (state) {
    case "closed":
      return { ...base, open: false };
    case "greeting":
      return { ...base, open: false, bubble: true };
    case "welcomeback":
      return { ...base, open: false, bubble: true, bubbleText: "Welcome back! Pick up where you left off?", messages: [q, a] };
    case "replied":
      return { ...base, open: false, bubble: true, bubbleText: `${cap(owner)} replied to your message`, messages: [q, a] };
    case "loading":
      return { ...base, loading: true };
    case "welcome":
      return base;
    case "thinking":
      return { ...base, messages: [q], status: st({ busy: true, progress: `Reading "getting started"` }) };
    case "stillworking":
      return { ...base, messages: [q], status: st({ busy: true, progress: "Still working on it" }) };
    case "partial":
      return {
        ...base,
        messages: [q, msg("ai", "Yes. Point it at your existing repository and it reads your snapshots and policies as they are."), msg("system", "The answer stopped early. Ask again, or talk to a person.")],
      };
    case "rich":
      return {
        ...base,
        messages: [
          msg("visitor", "How do I run it in Docker, and what's free?"),
          msg("ai", "Run this on your server:\n\n```bash\ndocker run -d -p 8080:8080 -v kopialens:/data kopialens/kopialens:latest\n```\n\n| Plan | What you get |\n| --- | --- |\n| Free | Backups, restore, all the analysis |\n| Pro | The clean-up tools |\n\nSee [Running in Docker](https://example.com/docs/docker).", {
            suggestions: ["Which port does it use?", "How do I update it?"],
          }),
        ],
      };
    case "streaming":
      return { ...base, messages: [q], preview: "Yes. Point it at your existing repository and it reads your snapshots", status: st({ busy: true }) };
    case "answer":
      return { ...base, messages: [q, a] };
    case "asking":
      return { ...base, messages: [q, a, ask()], status: st({ wantsOwner: true }) };
    case "handback":
      return {
        ...base,
        messages: [q, a, ask(), msg("system", `${cap(owner)} joined the chat`), msg("owner", "Hi! Happy to help. What are you trying to set up?"), msg("system", `${cap(owner)} has left the chat. You're chatting with the AI assistant.`)],
      };
    case "joined":
      return {
        ...base,
        messages: [q, a, msg("visitor", "Can I talk to someone?"), msg("system", `${cap(owner)} joined the chat`), msg("owner", "Hi! Happy to help. What are you trying to set up?")],
        status: st({ mode: "owner", ownerJoined: true }),
      };
    case "away":
      return { ...base, messages: [q, a, msg("visitor", "Can I talk to someone?")], status: st({ ownerOnline: false, wantsOwner: true, reason: "owner_away" }) };
    case "getintouch":
      return { ...base, messages: [q], status: st({ mode: "form", reason: "ai_unavailable" }) };
    case "sent":
      return {
        ...base,
        messages: [q, msg("visitor", "Please email me about team pricing."), msg("system", `Message sent. ${cap(owner)} will reply to sam@example.com.`)],
        status: st({ mode: "form", reason: "ai_unavailable", contactSent: true, visitorEmail: "sam@example.com" }),
      };
    case "limit":
      return { ...base, messages: [q, a], status: st({ mode: "form", reason: "limit" }) };
    case "aioff":
      return { ...base, messages: [q], status: st({ mode: "form", reason: "ai_off" }) };
    case "reconnecting":
      return { ...base, messages: [q, a], conn: "reconnecting" };
    case "unavailable":
      return { ...base, conn: "unreachable" };
    case "menu":
      return { ...base, messages: [q, a], menu: true };
    case "emailing":
      return { ...base, messages: [q, a], menu: true, sampleEmailing: true };
    case "past":
      return {
        ...base,
        messages: [q, a],
        samplePast: [
          { id: "p1", preview: "Visitor: Does it work with an existing Kopia repository?", updatedAt: Date.now() - 3_600_000 },
          { id: "p2", preview: "Visitor: Can I get a refund on the lifetime licence?", updatedAt: Date.now() - 2 * 86_400_000, ownerAt: Date.now() - 86_400_000 },
          { id: "p3", preview: "Visitor: Which download do I need for my NAS?", updatedAt: Date.now() - 9 * 86_400_000 },
        ],
      };
    default:
      return base;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
