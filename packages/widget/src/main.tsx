import { render } from "preact";
import { DEFAULT_UI, type PublicSiteConfig, type SessionRequest, type ThemeMap, type WidgetUi } from "@website-chatbot/shared";
import { App } from "./App";
import { ChatClient } from "./client";
import { autoOpenDue, canAutoOpen, countPage, greetingDue, greetingShown, watchAutoOpen } from "./greeting";
import { live, patch, site, ui } from "./store";
import css from "./styles.css?inline";
import { applyTheme } from "./theme";

export interface WidgetOptions {
  site: string;
  /** Chat server origin; defaults to where this script was loaded from. */
  server?: string;
  /** Overrides the site's theme map, e.g. while testing. */
  theme?: ThemeMap;
  ui?: Partial<WidgetUi>;
  dev?: SessionRequest["dev"];
}

declare global {
  /** True in the Playground (dev server and its hosted build); false in the visitor widget. */
  const __WCB_PLAYGROUND__: boolean;
  /** True where the Design menu's look choices apply: the Playground and the preview build for sites' dev pages. */
  const __WCB_DESIGN__: boolean;
  interface Window {
    WebsiteChatbotOptions?: WidgetOptions;
    WebsiteChatbot?: { open(): void; close(): void; newChat(): void };
  }
}

function readOptions(): WidgetOptions | null {
  const script = document.currentScript as HTMLScriptElement | null;
  const fromScript = script?.dataset.site
    ? { site: script.dataset.site, server: script.dataset.server ?? new URL(script.src).origin }
    : null;
  const opts = { ...fromScript, ...window.WebsiteChatbotOptions } as WidgetOptions;
  return opts.site ? opts : null;
}

const SITE_CACHE = (key: string) => `wcb:site:${key}`;

async function loadSite(server: string, key: string): Promise<PublicSiteConfig | null> {
  try {
    const cached = localStorage.getItem(SITE_CACHE(key));
    if (cached) site.value = JSON.parse(cached) as PublicSiteConfig;
  } catch {
    // no cache; wait for the network
  }
  try {
    const presence = fetch(`${server}/api/presence`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ ownerOnline: boolean }>) : null))
      .catch(() => null);
    const res = await fetch(`${server}/api/site/${encodeURIComponent(key)}`);
    if (!res.ok) return site.value;
    const data = (await res.json()) as { site: PublicSiteConfig };
    site.value = data.site;
    const p = await presence;
    if (p) patch({ status: { ...live.value.status, ownerOnline: p.ownerOnline } });
    try {
      localStorage.setItem(SITE_CACHE(key), JSON.stringify(data.site));
    } catch {
      // fine
    }
  } catch {
    if (!site.value) patch({ conn: "unreachable" });
  }
  return site.value;
}

/**
 * The bubble above the closed chat: a reply from the owner the visitor hasn't seen (always), else, as often
 * as the site's `proactive.repeat` allows, "welcome back" for a visitor with a saved chat or the site's greeting.
 */
function scheduleBubble(s: PublicSiteConfig, client: ChatClient): void {
  const due = greetingDue(s.proactive.repeat);
  const pages = countPage();
  // "both" and "open" open the chat itself on large screens; phones get the bubble.
  const style = s.proactive.style ?? "bubble";
  const opens = s.proactive.enabled && style !== "bubble" && canAutoOpen();
  setTimeout(async () => {
    if (live.value.open) return;
    let text = "";
    const fresh = !live.value.messages.length;
    if (await client.ownerReplied()) text = `${s.ownerName.charAt(0).toUpperCase()}${s.ownerName.slice(1)} replied to your message`;
    else {
      // Counted from page load.
      if (opens && fresh && autoOpenDue(s.proactive.repeat)) watchAutoOpen(s, pages, true, performance.timeOrigin);
      const bubble = !opens || style === "both" || !fresh;
      if (bubble && due && s.proactive.enabled) text = fresh ? s.proactive.text : "Welcome back! Pick up where you left off?";
    }
    if (!text || live.value.open) return;
    patch({ bubble: true, bubbleText: text });
    greetingShown();
  }, s.proactive.delaySec * 1000);
}

export async function boot(opts: WidgetOptions): Promise<void> {
  if (document.getElementById("website-chatbot")) return;
  const server = (opts.server ?? location.origin).replace(/\/$/, "");
  const host = document.createElement("div");
  host.id = "website-chatbot";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.appendChild(style);
  const mount = document.createElement("div");
  shadow.appendChild(mount);

  const client = new ChatClient({ server, siteKey: opts.site, dev: opts.dev });
  const s = await loadSite(server, opts.site);
  if (!s) {
    // Without any config there is nothing sensible to show; the site's own contact links remain.
    host.remove();
    return;
  }
  applyTheme(host, { ...s.theme, ...opts.theme });
  ui.value = { ...DEFAULT_UI, ...s.ui, ...opts.ui };
  client.hydrate();
  render(<App client={client} />, mount);
  scheduleBubble(s, client);

  window.WebsiteChatbot = {
    open: () => {
      patch({ open: true, bubble: false });
      void client.start();
    },
    close: () => patch({ open: false }),
    newChat: () => void client.newChat(),
  };

  if (__WCB_DESIGN__) {
    const dev = await import("./dev");
    dev.initDev(host, opts, client);
  }
}

const opts = readOptions();
if (opts) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot(opts));
  else void boot(opts);
}
