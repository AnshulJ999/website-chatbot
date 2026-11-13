import type { ThemeMap } from "@website-chatbot/shared";
import { applyTheme } from "../src/theme";

// Shared Notes + Design widgets come from the local notes server (Personal-Stuff/Widgets).
const NOTES = "http://127.0.0.1:7790";
const API = `${NOTES}/api/devnotes/website-chatbot`;

const KL_MAP: ThemeMap = {
  background: "var(--color-card)",
  surface: "var(--color-background-raised)",
  foreground: "var(--color-foreground)",
  muted: "var(--color-muted)",
  mutedForeground: "var(--color-muted-foreground)",
  border: "var(--color-border)",
  accent: "var(--color-primary)",
  accentForeground: "var(--color-primary-foreground)",
  font: "var(--font-sans)",
};
const PF_MAP: ThemeMap = {
  background: "hsl(var(--background))",
  surface: "hsl(var(--card))",
  foreground: "hsl(var(--foreground))",
  muted: "hsl(var(--muted))",
  mutedForeground: "hsl(var(--muted-foreground))",
  border: "hsl(var(--border))",
  accent: "hsl(var(--primary))",
  accentForeground: "hsl(var(--primary-foreground))",
  radius: "calc(var(--radius) * 1.5)",
};

const BACKDROPS = ["kl-dark", "kl-light", "pf-light", "pf-dark", "pf-retro", "pf-cyberpunk", "pf-aurora", "pf-synthwave", "pf-paper"];

interface Row {
  key: string;
  label: string;
  options: { id: string; label: string }[];
  fallback: string;
  note?: string;
}
const opt = (id: string, label: string) => ({ id, label });

const ROWS: Row[] = [
  {
    key: "backdrop",
    label: "Site theme",
    options: [
      opt("kl-dark", "KopiaLens dark"),
      opt("kl-light", "KopiaLens light"),
      opt("pf-light", "Portfolio light"),
      opt("pf-dark", "Portfolio dark"),
      opt("pf-retro", "Portfolio retro"),
      opt("pf-cyberpunk", "Portfolio cyberpunk"),
      opt("pf-aurora", "Portfolio aurora"),
      opt("pf-synthwave", "Portfolio synthwave"),
      opt("pf-paper", "Portfolio paper"),
    ],
    fallback: "kl-dark",
  },
  {
    key: "state",
    label: "Widget state",
    note: "Shows a sample of each state. Live = the real chat.",
    options: [
      opt("live", "Live"),
      opt("closed", "Closed"),
      opt("greeting", "Greeting bubble"),
      opt("welcome", "Welcome"),
      opt("thinking", "Looking things up"),
      opt("streaming", "Answer arriving"),
      opt("answer", "Answer + suggestions"),
      opt("asking", "Asked for a person"),
      opt("joined", "Owner joined"),
      opt("away", "Owner away (form)"),
      opt("getintouch", "Get in touch"),
      opt("sent", "Message sent"),
      opt("limit", "Daily limit"),
      opt("unavailable", "Server unreachable"),
      opt("menu", "Menu open"),
    ],
    fallback: "live",
  },
  { key: "launcher", label: "Launcher", options: [opt("icon", "Round icon"), opt("pill", "Pill with name")], fallback: "icon" },
  { key: "corner", label: "Corner", options: [opt("right", "Bottom right"), opt("left", "Bottom left")], fallback: "right" },
  { key: "panel", label: "Panel", options: [opt("compact", "Compact"), opt("tall", "Tall"), opt("sheet", "Side sheet")], fallback: "compact" },
  { key: "suggestions", label: "Suggested replies", options: [opt("chips", "Chips in a row"), opt("list", "Stacked list")], fallback: "chips" },
  { key: "talk", label: "Talk to owner", options: [opt("bar", "Bar under header"), opt("composer", "Above message box"), opt("menu", "Menu only")], fallback: "bar" },
  { key: "notice", label: "\"Chats are saved\"", options: [opt("welcome", "Once, in welcome"), opt("under", "Under the box"), opt("menu", "Menu only")], fallback: "welcome" },
  {
    key: "ownerword",
    label: "KopiaLens wording",
    options: [opt("site", "Site setting"), opt("a", "A: Talk to a person"), opt("b", "B: Talk to the developer"), opt("c", "C: Contact support")],
    fallback: "site",
  },
  { key: "brain", label: "Brain", note: "Scripted is free; Real uses Omnara credits.", options: [opt("scripted", "Scripted"), opt("real", "Real (Omnara)")], fallback: "scripted" },
  {
    key: "scenario",
    label: "Scenario (scripted)",
    options: [opt("none", "Normal"), opt("fail_first", "First model fails"), opt("slow", "Reply stalls"), opt("omnara_down", "Omnara down"), opt("cap", "Chat over its cap")],
    fallback: "none",
  },
];

interface DW {
  apply(rows: Row[], o?: { storage?: string }): void;
  init(o: { rows: Row[]; anchor?: string; isDark?: () => boolean; storage?: string }): void;
}
type W = Window & { DesignWidget?: DW; NotesWidget?: { init(o: Record<string, unknown>): void }; NotesStarterConfig?: unknown };
const w = window as W;

const isDark = () => !/(kl-light|pf-light|pf-retro|pf-paper)/.test(document.documentElement.className);

function setBackdrop(): void {
  const id = document.documentElement.dataset.dBackdrop ?? "kl-dark";
  document.documentElement.classList.remove(...BACKDROPS);
  document.documentElement.classList.add(BACKDROPS.includes(id) ? id : "kl-dark");
  const host = document.getElementById("website-chatbot");
  if (host) applyTheme(host, id.startsWith("kl") ? KL_MAP : PF_MAP);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(src));
    document.head.appendChild(s);
  });
}

function loadCss(href: string): void {
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  w.WebsiteChatbotOptions = {
    site: params.get("site") ?? "demo",
    server: params.get("server") ?? "http://127.0.0.1:8790",
    theme: KL_MAP,
  };

  try {
    loadCss(`${NOTES}/devnotes/design-widget.css`);
    await loadScript(`${NOTES}/devnotes/design-widget.js`);
    w.DesignWidget!.apply(ROWS, { storage: "wcb-dw-" });
  } catch {
    console.warn("Design widget unavailable: is the local notes server running on 7790?");
  }
  setBackdrop();
  window.addEventListener("design-change", setBackdrop);

  await import("../src/main");
  // The widget mounts asynchronously; re-apply the theme map once its host exists.
  const wait = setInterval(() => {
    if (document.getElementById("website-chatbot")) {
      clearInterval(wait);
      setBackdrop();
    }
  }, 100);

  let designReady = false;
  const initDesign = (anchor?: string) => {
    if (designReady || !w.DesignWidget) return;
    designReady = true;
    w.DesignWidget.init({ rows: ROWS, anchor, isDark, storage: "wcb-dw-" });
  };
  // If Notes is switched off for this app, the Design menu still appears.
  setTimeout(() => initDesign(), 2500);

  window.addEventListener("notes-loaded", () => {
    w.NotesWidget?.init({
      app: "Website Chatbot",
      endpoint: API,
      position: "bottom-left",
      instance: `Playground :${location.port}`,
      showInstance: true,
      screen: () => `Playground ▸ ${document.documentElement.dataset.dState ?? "live"}`,
      context: () => ({
        design: Object.fromEntries(
          Array.from(document.documentElement.attributes)
            .filter((a) => a.name.startsWith("data-d-"))
            .map((a) => [a.name.slice(7), a.value]),
        ),
      }),
      isDark,
      theme: () => document.documentElement.dataset.dBackdrop ?? "kl-dark",
    });
    initDesign(".nw-launcher");
  }, { once: true });
  w.NotesStarterConfig = { state: `${API}/state`, files: [`${NOTES}/devnotes/notes-widget.css`, `${NOTES}/devnotes/notes-widget.js`] };
  loadScript(`${NOTES}/devnotes/notes-starter.js`).catch(() => initDesign());
}

void main();
