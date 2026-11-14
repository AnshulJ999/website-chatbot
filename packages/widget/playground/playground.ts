import type { PublicSiteConfig, ThemeMap } from "@website-chatbot/shared";
import { applyTheme } from "../src/theme";
import { OWNER_NAMES, TALK_WORDING } from "../src/dev-wording";

// The Playground: the real widget on a plain page. Left panel = test setup (data-pg-* on <html>);
// Design menu = look choices (data-d-*). Optional review tools (Notes, Design menu) load from a notes
// server when VITE_NOTES_SERVER is set in a local, git-ignored .env.local.
const NOTES: string = import.meta.env.VITE_NOTES_SERVER ?? "";
const API = `${NOTES}/api/devnotes/website-chatbot`;
const FRAME = new URLSearchParams(location.search).has("pg-frame");
const HOSTED = location.pathname.startsWith("/playground");
const SERVER = HOSTED ? location.origin : "http://127.0.0.1:8790";
const INBOX = HOSTED ? `${location.origin}/admin/` : "http://127.0.0.1:5291/admin/";

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

type Opt = { id: string; label: string };
const opt = (id: string, label: string): Opt => ({ id, label });

// The demo site exists only on a local dev server.
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const SITES = [opt("kopialens", "KopiaLens"), opt("portfolio", "Portfolio"), ...(LOCAL ? [opt("demo", "Demo")] : [])];
const KL_THEMES = [opt("kl-dark", "KopiaLens dark"), opt("kl-light", "KopiaLens light")];
const PF_THEMES = [
  opt("pf-light", "Light"),
  opt("pf-dark", "Dark"),
  opt("pf-retro", "Retro"),
  opt("pf-cyberpunk", "Cyberpunk"),
  opt("pf-aurora", "Aurora"),
  opt("pf-synthwave", "Synthwave"),
  opt("pf-paper", "Paper"),
];
const ALL_THEMES = [...KL_THEMES, ...PF_THEMES.map((t) => opt(t.id, `Portfolio ${t.label.toLowerCase()}`))];
const STATES = [
  opt("live", "Normal (the live chat)"),
  opt("closed", "Closed"),
  opt("greeting", "Greeting bubble"),
  opt("welcomeback", "Greeting: welcome back"),
  opt("replied", "Greeting: owner replied"),
  opt("loading", "Loading a saved chat"),
  opt("welcome", "Welcome"),
  opt("thinking", "Looking things up"),
  opt("stillworking", "Still working on it"),
  opt("streaming", "Answer arriving"),
  opt("answer", "Answer + suggestions"),
  opt("rich", "Answer with code and a table"),
  opt("partial", "Answer stopped early"),
  opt("asking", "Asked for a person"),
  opt("joined", "Owner joined"),
  opt("handback", "Owner handed back to the AI"),
  opt("away", "Owner away (form)"),
  opt("getintouch", "Get in touch (AI unavailable)"),
  opt("aioff", "Get in touch (AI off or spending limit)"),
  opt("sent", "Message sent"),
  opt("limit", "Daily limit reached"),
  opt("reconnecting", "Reconnecting"),
  opt("unavailable", "Server unreachable"),
  opt("menu", "Menu open"),
  opt("emailing", "Email me this chat"),
  opt("past", "Past chats"),
];
const SCENARIOS = [opt("none", "Normal"), opt("fail_first", "First model fails"), opt("slow", "Reply stalls"), opt("omnara_down", "Omnara down"), opt("cap", "Chat over its cap")];
const CPU_TESTS = [opt("0", "Off"), opt("50", "About 50 ms"), opt("200", "About 200 ms"), opt("1000", "About 1 s")];
const CUTOFF_TESTS = [opt("0", "Off"), opt("1", "Cut off mid-answer")];
const MODELS = [
  opt("", "The model ladder (normal)"),
  opt("deepseek/deepseek-v4.1-flash-latest", "DeepSeek V4.1 Flash"),
  opt("openai/gpt-6-luna", "GPT-6 Luna"),
  opt("anthropic/claude-haiku-5.5", "Claude Haiku 5.5"),
];
const EFFORTS = [opt("high", "High"), opt("medium", "Medium"), opt("low", "Low"), opt("none", "None"), opt("", "Model's default")];

const capFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** A wording row whose default is the site's own value, shown by name rather than as "site setting". */
function wordingRow(key: string, label: string, note: string, table: Record<string, string>, current: string | undefined) {
  const options = Object.entries(table).map(([id, text]) => opt(id, capFirst(text)));
  const match = Object.entries(table).find(([, text]) => text.toLowerCase() === current?.toLowerCase())?.[0];
  if (!match && current) options.unshift(opt("site", capFirst(current)));
  return { key, label, note, options, fallback: match ?? "site" };
}

// Look choices only: the test setup lives in the panel. Defaults come from the site's config.
function designRows() {
  const cfg = siteConfig;
  const delays = ["3", "6", "10", "30"];
  const delay = String(cfg?.proactive.delaySec ?? 6);
  if (!delays.includes(delay)) delays.push(delay);
  return [
    ...BASE_ROWS,
    wordingRow("talkword", "\"Talk to\" wording", "Shows in the bar, menu or above the message box.", TALK_WORDING, cfg?.talkLabel),
    wordingRow("owner", "What the bot calls you", "Shows in the \"asked to join\", \"is here\", away-form, message-sent and offline texts, and in the AI's replies. Starts a new chat when changed.", OWNER_NAMES, cfg?.ownerName),
    { key: "greeting", label: "Pop-up greeting", note: "A small bubble above the closed chat button. Shows only while the chat is closed and empty.", options: [opt("off", "Off"), opt("on", "On")], fallback: cfg?.proactive.enabled ? "on" : "off" },
    { key: "greetdelay", label: "Greeting delay", note: "Seconds after the page loads.", options: delays.map((s) => opt(s, `${s} seconds`)), fallback: delay },
  ];
}

const BASE_ROWS = [
  { key: "launcher", label: "Launcher", options: [opt("icon", "Round icon"), opt("pill", "Pill with name")], fallback: "icon" },
  { key: "corner", label: "Corner", options: [opt("right", "Bottom right"), opt("left", "Bottom left")], fallback: "right" },
  { key: "panel", label: "Panel size", options: [opt("compact", "Compact"), opt("tall", "Tall"), opt("sheet", "Side sheet")], fallback: "compact" },
  { key: "suggestions", label: "Suggested replies", options: [opt("chips", "Chips in a row"), opt("list", "Stacked list")], fallback: "chips" },
  { key: "talk", label: "\"Talk to\" button", options: [opt("bar", "Bar under header"), opt("composer", "Above message box"), opt("menu", "Menu only")], fallback: "bar" },
  { key: "notice", label: "\"Chats are saved\" notice", options: [opt("welcome", "Once, in welcome"), opt("under", "Under the box"), opt("menu", "Menu only")], fallback: "welcome" },
  { key: "actions", label: "Answer buttons (copy, rate)", options: [opt("hover", "On hover"), opt("always", "Always shown")], fallback: "hover" },
];
let DESIGN_ROWS: unknown[] = [];

interface DesignApi {
  apply(rows: unknown[], o?: Record<string, unknown>): void;
  init(o: Record<string, unknown>): { place(): void };
}
interface NotesApi {
  setSide?(side: "left" | "right"): void;
}
type W = Window & {
  DesignWidget?: DesignApi;
  NotesWidget?: { init(o: Record<string, unknown>): NotesApi };
  NotesStarterConfig?: unknown;
};
const w = window as W;
const root = document.documentElement;

// ---- Test setup (panel) state ----

const PG_KEYS = ["site", "page", "theme", "device", "brain", "owner", "model", "effort", "scenario", "cpu", "cutoff", "state"] as const;
type PgKey = (typeof PG_KEYS)[number];
const PG_DEFAULTS: Record<PgKey, string> = { site: "kopialens", page: "", theme: "", device: "desktop", brain: "scripted", owner: "0", model: "", effort: "high", scenario: "none", cpu: "0", cutoff: "0", state: "live" };
const pgStore = (k: PgKey) => `wcb-pg-${k}`;

function readPg(k: PgKey): string {
  try {
    return localStorage.getItem(pgStore(k)) ?? PG_DEFAULTS[k];
  } catch {
    return PG_DEFAULTS[k];
  }
}

function setPg(k: PgKey, v: string, quiet = false): void {
  try {
    if (v === PG_DEFAULTS[k]) localStorage.removeItem(pgStore(k));
    else localStorage.setItem(pgStore(k), v);
  } catch {
    // this page view only
  }
  root.setAttribute(`data-pg-${k}`, v);
  if (!quiet) window.dispatchEvent(new CustomEvent("pg-change", { detail: { key: k, value: v } }));
}

function applyPg(): void {
  const fromUrl = new URLSearchParams(location.search).get("site");
  if (fromUrl && SITES.some((s) => s.id === fromUrl)) setPg("site", fromUrl, true);
  for (const k of PG_KEYS) root.setAttribute(`data-pg-${k}`, readPg(k));
  root.setAttribute("data-pg-site", site());
}

const site = () => {
  const s = root.dataset.pgSite;
  return s && SITES.some((o) => o.id === s) ? s : "kopialens";
};
const themesFor = (s: string) => (s === "kopialens" ? KL_THEMES : s === "portfolio" ? PF_THEMES : ALL_THEMES);
const defaultTheme = (s: string) => (s === "portfolio" ? "pf-light" : "kl-dark");
const theme = () => {
  const t = root.dataset.pgTheme;
  return t && themesFor(site()).some((o) => o.id === t) ? t : defaultTheme(site());
};
const isDark = () => !/^(kl-light|pf-light|pf-retro|pf-paper)$/.test(theme());

function setBackdrop(): void {
  const id = theme();
  root.classList.remove(...ALL_THEMES.map((t) => t.id));
  root.classList.add(id);
  const host = document.getElementById("website-chatbot");
  if (host) applyTheme(host, id.startsWith("kl") ? KL_MAP : PF_MAP);
}

// ---- Shared widgets ----

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

const noteContext = () => ({
  setup: Object.fromEntries(PG_KEYS.map((k) => [k, root.getAttribute(`data-pg-${k}`) ?? ""])),
  design: Object.fromEntries(
    Array.from(root.attributes)
      .filter((a) => a.name.startsWith("data-d-"))
      .map((a) => [a.name.slice(7), a.value]),
  ),
});

function startNotes(onReady: (api: NotesApi | null) => void): void {
  if (!NOTES) return onReady(null);
  window.addEventListener(
    "notes-loaded",
    () => {
      const api =
        w.NotesWidget?.init({
          app: "Website Chatbot",
          endpoint: API,
          position: "bottom-left",
          instance: FRAME ? "Playground phone" : `Playground${HOSTED ? "" : ` :${location.port}`}`,
          showInstance: true,
          screen: () => `Playground ▸ ${site()} ▸ ${root.dataset.pgState ?? "live"}`,
          context: noteContext,
          isDark,
          theme,
        }) ?? null;
      onReady(api);
    },
    { once: true },
  );
  w.NotesStarterConfig = { state: `${API}/state`, files: [`${NOTES}/devnotes/notes-widget.css`, `${NOTES}/devnotes/notes-widget.js`] };
  loadScript(`${NOTES}/devnotes/notes-starter.js`).catch(() => onReady(null));
}

// ---- Panel ----

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, kids: (Node | string | null)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") e.textContent = String(v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v as EventListener);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function select(key: PgKey, label: string, options: Opt[], value: string, onPick: (v: string) => void, hint?: string): HTMLElement {
  const sel = h("select", { id: `pg-${key}`, onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value) });
  for (const o of options) sel.append(h("option", { value: o.id, selected: o.id === value, text: o.label }));
  return h("div", { class: "pg-field" }, [h("label", { for: `pg-${key}`, text: label }), sel, hint ? h("p", { class: "pg-hint", text: hint }) : null]);
}

function segmented(label: string, options: Opt[], value: string, onPick: (v: string) => void, hint?: string): HTMLElement {
  const group = h("div", { class: "pg-seg", role: "radiogroup", "aria-label": label });
  for (const o of options) {
    group.append(h("button", { type: "button", role: "radio", "aria-checked": String(o.id === value), class: o.id === value ? "on" : "", text: o.label, onclick: () => onPick(o.id) }));
  }
  return h("div", { class: "pg-field" }, [h("span", { class: "pg-label", text: label }), group, hint ? h("p", { class: "pg-hint", text: hint }) : null]);
}

let siteConfig: PublicSiteConfig | null = null;

async function loadSiteConfig(): Promise<void> {
  try {
    const res = await fetch(`${SERVER}/api/site/${encodeURIComponent(site())}`);
    if (res.ok) siteConfig = ((await res.json()) as { site: PublicSiteConfig }).site;
  } catch {
    siteConfig = null;
  }
}

function resetVisitor(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("wcb:")) localStorage.removeItem(k);
    sessionStorage.removeItem("wcb:bubble");
  } catch {
    // nothing stored
  }
  location.reload();
}

const SCROLL_KEY = "wcb-pg-scroll";

function resetSetup(): void {
  try {
    for (const k of PG_KEYS) localStorage.removeItem(pgStore(k));
  } catch {
    // nothing stored
  }
  location.reload();
}

function renderPanel(): void {
  const body = document.querySelector("#pg-panel .pg-panel-body")!;
  let keep = body.scrollTop;
  try {
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved !== null) {
      keep = Number(saved) || 0;
      sessionStorage.removeItem(SCROLL_KEY);
    }
  } catch {
    // no saved position
  }
  const reload = (k: PgKey) => (v: string) => {
    setPg(k, v);
    try {
      sessionStorage.setItem(SCROLL_KEY, String(body.scrollTop));
    } catch {
      // position not kept
    }
    location.reload();
  };
  const live = (k: PgKey) => (v: string) => {
    setPg(k, v);
    renderPanel();
    renderBanner();
    setBackdrop();
  };
  const pages = [opt("", "Home (/)"), ...(siteConfig?.starters ?? []).filter((s) => s.path !== "/").map((s) => opt(s.path, s.path))];
  const scripted = root.dataset.pgBrain !== "real";
  body.replaceChildren(
    h("p", { class: "pg-group", text: "Visitor" }),
    select("site", "Site", SITES, site(), (v) => {
      setPg("page", "", true);
      setPg("theme", "", true);
      reload("site")(v);
    }),
    select("page", "Page they're on", pages, root.dataset.pgPage ?? "", live("page"), "Changes the starter prompts and what the bot sees."),
    select("theme", "Site theme", themesFor(site()), theme(), live("theme")),
    segmented("Screen", [opt("desktop", "Desktop"), opt("phone", "Phone")], root.dataset.pgDevice ?? "desktop", reload("device")),
    h("p", { class: "pg-group", text: "Answers" }),
    segmented("Brain", [opt("scripted", "Scripted"), opt("real", "Real (Omnara)")], root.dataset.pgBrain ?? "scripted", live("brain"), "Scripted is free and repeatable. Real uses Omnara credits."),
    segmented("Owner mode", [opt("0", "Off"), opt("1", "On")], scripted ? "0" : (root.dataset.pgOwner ?? "0"), live("owner"), scripted ? "Only with the real brain." : "The bot knows it's you and talks openly about its instructions, tools and files. A change starts a new chat."),
    select("model", "Model", MODELS, scripted ? "" : (root.dataset.pgModel ?? ""), live("model"), scripted ? "Only with the real brain." : "Answer with one model only, to compare how each feels. A change starts a new chat."),
    select("effort", "Effort", EFFORTS, root.dataset.pgEffort ?? "high", live("effort"), "How hard the chosen model thinks. DeepSeek supports High and Low only."),
    select("scenario", "Scenario", SCENARIOS, scripted ? (root.dataset.pgScenario ?? "none") : "none", live("scenario"), scripted ? "Forces a failure on the next answer." : "Only with the scripted brain."),
    select("cpu", "CPU test", CPU_TESTS, scripted ? "0" : (root.dataset.pgCpu ?? "0"), live("cpu"), scripted ? "Only with the real brain." : "Burns this much server CPU once per answer, to see what Cloudflare does past its limit. Works only while the server has CPU_TEST=1."),
    select("cutoff", "Cut-off test", CUTOFF_TESTS, scripted ? "0" : (root.dataset.pgCutoff ?? "0"), live("cutoff"), scripted ? "Only with the real brain." : "Drops the chat on the server partway through the next answer, like a Cloudflare cut-off. The full answer should still arrive."),
    h("p", { class: "pg-group", text: "View" }),
    select("state", "Widget state", STATES, root.dataset.pgState ?? "live", live("state"), "Shows a sample of each state. Normal = the real chat."),
    h("div", { class: "pg-actions" }, [
      h("button", { type: "button", class: "pg-btn", text: "New visitor", title: "Forget this browser's chats and start as a new visitor", onclick: resetVisitor }),
      h("button", { type: "button", class: "pg-btn", text: "Reset setup", title: "Put every option in this panel back to its default", onclick: resetSetup }),
      h("a", { class: "pg-btn", href: INBOX, target: "_blank", rel: "noopener", text: "Open inbox" }),
    ]),
  );
  body.scrollTop = keep;
  const scenario = body.querySelector<HTMLSelectElement>("#pg-scenario");
  if (scenario) scenario.disabled = !scripted;
  const effort = body.querySelector<HTMLSelectElement>("#pg-effort");
  if (effort) effort.disabled = scripted || !root.dataset.pgModel;
  for (const id of ["#pg-cpu", "#pg-cutoff", "#pg-model"]) {
    const el = body.querySelector<HTMLSelectElement>(id);
    if (el) el.disabled = scripted;
  }
}

function renderBanner(): void {
  const banner = document.getElementById("pg-banner")!;
  const state = root.dataset.pgState ?? "live";
  banner.hidden = state === "live";
  if (state === "live") return;
  const label = STATES.find((s) => s.id === state)?.label ?? state;
  banner.replaceChildren(
    h("span", {}, ["Showing a sample: ", h("strong", { text: label }), ". The chat isn't live."]),
    h("button", {
      type: "button",
      text: "Back to normal",
      onclick: () => {
        setPg("state", "live");
        renderPanel();
        renderBanner();
      },
    }),
  );
}

function setupPanelToggle(): void {
  const panel = document.getElementById("pg-panel")!;
  const toggle = document.getElementById("pg-toggle")!;
  const key = "wcb-pg-collapsed";
  const narrow = matchMedia("(max-width: 760px)").matches;
  let collapsed = narrow;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null && !narrow) collapsed = saved === "1";
  } catch {
    // default
  }
  const apply = () => {
    root.toggleAttribute("data-pg-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    panel.toggleAttribute("inert", collapsed);
  };
  const flip = (next: boolean) => {
    collapsed = next;
    try {
      if (!narrow) localStorage.setItem(key, collapsed ? "1" : "0");
    } catch {
      // fine
    }
    apply();
  };
  toggle.addEventListener("click", () => flip(!collapsed));
  panel.querySelector(".pg-collapse")?.addEventListener("click", () => flip(true));
  apply();
}

// Keep Notes and Design on the side away from the chat.
function placeDevButtons(notes: NotesApi | null): void {
  const side = root.dataset.dCorner === "left" ? "right" : "left";
  notes?.setSide?.(side);
  root.setAttribute("data-pg-devside", side);
}

// ---- Boot ----

/** On the deployed server, the signed-in owner's pass unlocks the test options. */
async function ownerPass(): Promise<string | undefined> {
  if (!HOSTED) return undefined;
  try {
    const res = await fetch("/admin/api/dev-pass", { credentials: "same-origin" });
    return res.ok ? ((await res.json()) as { pass: string }).pass : undefined;
  } catch {
    return undefined;
  }
}

async function bootWidget(): Promise<void> {
  const pass = await ownerPass();
  window.WebsiteChatbotOptions = { site: site(), server: SERVER, theme: theme().startsWith("kl") ? KL_MAP : PF_MAP, dev: pass ? { pass } : undefined };
  await import("../src/main");
  // The widget mounts asynchronously; re-apply the theme map once its host exists.
  const wait = setInterval(() => {
    if (document.getElementById("website-chatbot")) {
      clearInterval(wait);
      setBackdrop();
    }
  }, 100);
}

async function main(): Promise<void> {
  applyPg();
  await loadSiteConfig();
  DESIGN_ROWS = designRows();
  if (NOTES) {
    try {
      loadCss(`${NOTES}/devnotes/design-widget.css`);
      await loadScript(`${NOTES}/devnotes/design-widget.js`);
      w.DesignWidget!.apply(DESIGN_ROWS, { storage: "wcb-dw-" });
    } catch {
      console.warn(`Design menu unavailable: no notes server at ${NOTES}`);
    }
  }
  setBackdrop();

  if (FRAME) {
    // Phone frame: follows the parent page's choices through storage events.
    root.setAttribute("data-pg-frame", "");
    window.addEventListener("storage", (e) => {
      if (!e.key) return;
      if (e.key.startsWith("wcb-dw-")) {
        w.DesignWidget?.apply(DESIGN_ROWS, { storage: "wcb-dw-" });
        window.dispatchEvent(new CustomEvent("design-change", { detail: {} }));
      } else if (e.key.startsWith("wcb-pg-")) {
        applyPg();
        setBackdrop();
        window.dispatchEvent(new CustomEvent("pg-change", { detail: {} }));
      }
    });
    await bootWidget();
    startNotes(() => undefined);
    return;
  }

  setupPanelToggle();
  renderPanel();
  renderBanner();
  document.getElementById("pg-links")!.replaceChildren(
    h("a", { href: INBOX, target: "_blank", rel: "noopener", text: "Inbox" }),
    " · ",
    h("a", { href: `${SERVER}/api/health`, target: "_blank", rel: "noopener", text: "Server health" }),
  );

  if (root.dataset.pgDevice === "phone") {
    const frame = document.getElementById("pg-phone") as HTMLIFrameElement;
    const url = new URL(location.href);
    url.searchParams.set("pg-frame", "1");
    frame.src = url.toString();
    frame.hidden = false;
  } else {
    await bootWidget();
  }

  let notesApi: NotesApi | null = null;
  let designReady = false;
  const initDesign = (anchor?: string) => {
    if (designReady || !w.DesignWidget) return;
    designReady = true;
    w.DesignWidget.init({ rows: DESIGN_ROWS, anchor, isDark, storage: "wcb-dw-" });
  };
  window.addEventListener("design-change", () => placeDevButtons(notesApi));
  startNotes((api) => {
    notesApi = api;
    placeDevButtons(api);
    initDesign(api ? ".nw-launcher" : undefined);
  });
  // If Notes is switched off for this app, the Design menu still appears.
  setTimeout(() => initDesign(), 2500);
}

void main();
