import { signal } from "@preact/signals";
import { DEFAULT_UI, type ChatMessage, type ChatStatus, type PublicSiteConfig, type WidgetUi } from "@website-chatbot/shared";

export type Conn = "idle" | "connecting" | "open" | "reconnecting" | "unreachable";

/** Everything the UI renders. The live chat fills it; the dev Design menu can replace it with a sample. */
export interface View {
  open: boolean;
  bubble: boolean;
  messages: ChatMessage[];
  preview: string;
  status: ChatStatus;
  conn: Conn;
  menu: boolean;
  /** The visitor closed the owner-away form for now. */
  formDismissed: boolean;
}

export const EMPTY_STATUS: ChatStatus = {
  mode: "ai",
  busy: false,
  ownerOnline: false,
  ownerJoined: false,
  wantsOwner: false,
  contactSent: false,
};

export const site = signal<PublicSiteConfig | null>(null);
export const ui = signal<WidgetUi>(DEFAULT_UI);
export const live = signal<View>({
  open: false,
  bubble: false,
  messages: [],
  preview: "",
  status: EMPTY_STATUS,
  conn: "idle",
  menu: false,
  formDismissed: false,
});
/** A sample view forced by the Playground (dev only). */
export const forced = signal<View | null>(null);
/** Playground only: stands in for the page the visitor is on. */
export const pageOverride = signal<string | null>(null);

export function currentPath(): string {
  return pageOverride.value ?? location.pathname;
}

export function pageUrl(): string {
  return pageOverride.value ? new URL(pageOverride.value, location.origin).href : location.href;
}
export const notice = signal<{ text: string; tone: "info" | "error" } | null>(null);

export function patch(p: Partial<View>): void {
  live.value = { ...live.value, ...p };
}

/** UI-only changes (open, menu…): they apply to the Design menu's sample view when one is shown, so it stays clickable. */
export function setView(p: Partial<Pick<View, "open" | "bubble" | "menu" | "formDismissed">>): void {
  if (forced.value) forced.value = { ...forced.value, ...p };
  else patch(p);
}

// Hot-swapping this module would orphan the live signals; reload the page instead.
import.meta.hot?.on("vite:beforeUpdate", (p: { updates: { path: string }[] }) => {
  if (p.updates.some((u) => u.path.endsWith("/store.ts"))) location.reload();
});

export function flash(text: string, tone: "info" | "error" = "info"): void {
  notice.value = { text, tone };
  setTimeout(() => {
    if (notice.value?.text === text) notice.value = null;
  }, 5000);
}
