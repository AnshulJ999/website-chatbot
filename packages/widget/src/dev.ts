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
  switch (state) {
    case "closed":
      return { ...base, open: false };
    case "greeting":
      return { ...base, open: false, bubble: true };
    case "welcome":
      return base;
    case "thinking":
      return { ...base, messages: [q], status: st({ busy: true, progress: `Reading "getting started"` }) };
    case "streaming":
      return { ...base, messages: [q], preview: "Yes. Point it at your existing repository and it reads your snapshots", status: st({ busy: true }) };
    case "answer":
      return { ...base, messages: [q, a] };
    case "asking":
      return { ...base, messages: [q, a, msg("visitor", "Can I talk to someone?")], status: st({ wantsOwner: true }) };
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
    case "unavailable":
      return { ...base, conn: "unreachable" };
    case "menu":
      return { ...base, messages: [q, a], menu: true };
    default:
      return base;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
