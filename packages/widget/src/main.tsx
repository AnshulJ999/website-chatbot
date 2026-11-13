import { render } from "preact";
import { DEFAULT_UI, type PublicSiteConfig, type SessionRequest, type ThemeMap, type WidgetUi } from "@website-chatbot/shared";
import { App } from "./App";
import { ChatClient } from "./client";
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
    const res = await fetch(`${server}/api/site/${encodeURIComponent(key)}`);
    if (!res.ok) return site.value;
    const data = (await res.json()) as { site: PublicSiteConfig; ownerOnline: boolean };
    site.value = data.site;
    patch({ status: { ...live.value.status, ownerOnline: data.ownerOnline } });
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

function scheduleBubble(s: PublicSiteConfig): void {
  if (!s.proactive.enabled || !s.proactive.text) return;
  try {
    if (sessionStorage.getItem("wcb:bubble")) return;
  } catch {
    // show it anyway
  }
  setTimeout(() => {
    if (live.value.open || live.value.messages.length) return;
    patch({ bubble: true });
    try {
      sessionStorage.setItem("wcb:bubble", "1");
    } catch {
      // fine
    }
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
  render(<App client={client} />, mount);
  scheduleBubble(s);

  window.WebsiteChatbot = {
    open: () => {
      patch({ open: true, bubble: false });
      void client.start();
    },
    close: () => patch({ open: false }),
    newChat: () => void client.newChat(),
  };

  if (__WCB_PLAYGROUND__) {
    const dev = await import("./dev");
    dev.initDev(host, opts, client);
  }
}

const opts = readOptions();
if (opts) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot(opts));
  else void boot(opts);
}
