// Dev-only: reads the shared Design widget's choices (data-d-* on <html>) and applies them.
// Never part of the production bundle (imported behind import.meta.env.DEV).
import { DEFAULT_UI, type ChatMessage, type ChatStatus, type WidgetUi } from "@website-chatbot/shared";
import type { ChatClient } from "./client";
import type { WidgetOptions } from "./main";
import { EMPTY_STATUS, forced, live, site, ui, type View } from "./store";

const OWNER_WORDING: Record<string, string> = {
  a: "Talk to a person",
  b: "Talk to the developer",
  c: "Contact support",
};

let baseTalkLabel: string | undefined;
let lastDev = "";

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
    };
    if (site.value) {
      baseTalkLabel ??= site.value.talkLabel;
      const word = d.dOwnerword && OWNER_WORDING[d.dOwnerword];
      const talkLabel = word || baseTalkLabel;
      if (site.value.talkLabel !== talkLabel) site.value = { ...site.value, talkLabel };
    }
    const state = d.dState ?? "live";
    forced.value = state === "live" ? null : sample(state);

    const dev = { brain: (d.dBrain ?? "scripted") as "real" | "scripted", scenario: d.dScenario ?? "none" };
    const key = JSON.stringify(dev);
    if (lastDev && key !== lastDev) {
      client.setDev(dev);
      if (live.value.open) void client.newChat();
    } else client.setDev(dev);
    lastDev = key;
  };
  apply();
  window.addEventListener("design-change", apply);
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
