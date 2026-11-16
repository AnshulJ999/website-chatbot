// The chat's look choices for the Design menu, shared by the Playground and the preview widget on
// sites' dev pages. Defaults come from the site's config, so "default" marks what visitors get today.
import type { PublicSiteConfig } from "@website-chatbot/shared";
import { CREDIT_WORDING, OWNER_NAMES, TALK_WORDING } from "./dev-wording";

type Opt = { id: string; label: string };
const opt = (id: string, label: string): Opt => ({ id, label });
const capFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export interface DesignRow {
  key: string;
  label: string;
  options: Opt[];
  fallback: string;
  note?: string;
  pages?: string[];
  needs?: { key: string; value: string; hint: string };
}

/** A wording row whose default is the site's own value, shown by name rather than as "site setting". */
function wordingRow(key: string, label: string, note: string, table: Record<string, string>, current: string | undefined): DesignRow {
  const options = Object.entries(table).map(([id, text]) => opt(id, capFirst(text)));
  const match = Object.entries(table).find(([, text]) => text.toLowerCase() === current?.toLowerCase())?.[0];
  if (!match && current) options.unshift(opt("site", capFirst(current)));
  return { key, label, note, options, fallback: match ?? "site" };
}

/**
 * On a site (`onSite`), keys get a "chat-" prefix and labels a "Chat: " one, so they sit apart from the site's
 * own rows; the "What the bot calls you" row is Playground-only (it changes the AI's replies too).
 */
export function chatDesignRows(cfg: PublicSiteConfig | null, onSite = false): DesignRow[] {
  const ui = cfg?.ui ?? {};
  const delays = ["3", "6", "10", "30"];
  const delay = String(cfg?.proactive.delaySec ?? 6);
  if (!delays.includes(delay)) delays.push(delay);
  const rows: DesignRow[] = [
    { key: "launcher", label: "Launcher", options: [opt("icon", "Round icon"), opt("pill", "Pill with name")], fallback: ui.launcher ?? "icon" },
    { key: "corner", label: "Corner", options: [opt("right", "Bottom right"), opt("left", "Bottom left")], fallback: ui.corner ?? "right" },
    { key: "panel", label: "Panel size", options: [opt("compact", "Compact"), opt("tall", "Tall"), opt("sheet", "Side sheet")], fallback: ui.panel ?? "compact" },
    { key: "suggestions", label: "Suggested replies", options: [opt("chips", "Chips in a row"), opt("list", "Stacked list")], fallback: ui.suggestions ?? "chips" },
    { key: "talk", label: "\"Talk to\" button", options: [opt("bar", "Bar under header"), opt("composer", "Above message box"), opt("menu", "Menu only")], fallback: ui.talkPlacement ?? "bar" },
    { key: "notice", label: "\"Chats are saved\" notice", options: [opt("welcome", "Once, in welcome"), opt("under", "Under the box"), opt("menu", "Menu only")], fallback: ui.notice ?? "welcome" },
    { key: "actions", label: "Answer buttons (copy, rate)", options: [opt("hover", "On hover"), opt("always", "Always shown")], fallback: ui.actions ?? "hover" },
    wordingRow("talkword", "\"Talk to\" wording", "Shows in the bar, menu or above the message box.", TALK_WORDING, cfg?.talkLabel),
    ...(onSite
      ? []
      : [wordingRow("owner", "What the bot calls you", "Shows in the \"asked to join\", \"is here\", away-form, message-sent and offline texts, and in the AI's replies. Starts a new chat when changed.", OWNER_NAMES, cfg?.ownerName)]),
    { key: "greeting", label: "Pop-up greeting", note: "Shows only while the chat is closed and empty.", options: [opt("off", "Off"), opt("on", "On")], fallback: cfg?.proactive.enabled ? "on" : "off" },
    {
      key: "greetstyle",
      label: "Greeting style",
      note: "Open the chat: on computers only (phones get the bubble), once per visit, and not again that day if the visitor closes it.",
      options: [opt("bubble", "Small bubble"), opt("open", "Open the chat")],
      fallback: cfg?.proactive.style ?? "bubble",
      needs: { key: "greeting", value: "on", hint: "Turn the greeting on first." },
    },
    {
      key: "openafter",
      label: "Open the chat after",
      note: onSite ? "The visitor must also scroll or open a second page. Clear this site's storage to see it again." : "On a site the visitor must also scroll or open a second page. Here it waits for time only. New visitor resets it.",
      options: ["10", "30", "45", "60", "90"].map((s) => opt(s, `${s} seconds`)),
      fallback: String(cfg?.proactive.openAfterSec ?? 45),
      needs: { key: "greetstyle", value: "open", hint: "Only for \"Open the chat\"." },
    },
    { key: "greetdelay", label: "Greeting delay", note: "Bubble: seconds after the page loads.", options: delays.map((s) => opt(s, `${s} seconds`)), fallback: delay },
    {
      key: "greetrepeat",
      label: "Greeting shows",
      note: "How often one visitor sees the bubble.",
      options: [opt("session", "Once per tab"), opt("day", "Once a day"), opt("page", "Every page load")],
      fallback: cfg?.proactive.repeat ?? "session",
    },
    {
      key: "away",
      label: "When you're away",
      note: "What the bar under the header shows while you're away.",
      options: [opt("status", "\"Away, replies by email\""), opt("link", "\"Leave a message\" link"), opt("menu", "In the menu only")],
      fallback: ui.away ?? "status",
    },
    {
      key: "stream",
      label: "Streaming text",
      note: "Tidy holds back half-written tables, bold and links while an answer arrives.",
      options: [opt("raw", "As it arrives"), opt("tidy", "Tidy")],
      fallback: ui.stream ?? "raw",
    },
    { key: "starters", label: "Starter questions shown", note: "More than three show as a list.", options: ["3", "4", "5", "6"].map((n) => opt(n, n)), fallback: String(ui.starters ?? 4) },
    { key: "morestarters", label: "\"More questions\" link", note: "Shows the next starters from the page's list, in order.", options: [opt("off", "Off"), opt("on", "On")], fallback: ui.moreStarters ?? "off" },
    { key: "credit", label: "Credit link", options: [opt("off", "Off"), opt("menu", "In the menu"), opt("footer", "Under the message box")], fallback: ui.credit ?? "off" },
    {
      key: "creditword",
      label: "Credit wording",
      note: "Links to the project page.",
      options: Object.entries(CREDIT_WORDING).map(([id, text]) => opt(id, text)),
      fallback: Object.entries(CREDIT_WORDING).find(([, text]) => text === cfg?.credit?.text)?.[0] ?? "isopen",
    },
  ];
  if (!onSite) return rows;
  const key = (k: string) => `chat-${k}`;
  return rows.map((r) => ({ ...r, key: key(r.key), label: `Chat: ${r.label}`, pages: ["all"], ...(r.needs ? { needs: { ...r.needs, key: key(r.needs.key) } } : {}) }));
}
