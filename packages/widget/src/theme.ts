import type { ThemeMap } from "@website-chatbot/shared";

const THEME_VARS: Record<keyof ThemeMap, string> = {
  background: "--wc-background",
  surface: "--wc-surface",
  foreground: "--wc-foreground",
  muted: "--wc-muted",
  mutedForeground: "--wc-muted-foreground",
  border: "--wc-border",
  accent: "--wc-accent",
  accentForeground: "--wc-accent-foreground",
  radius: "--wc-radius",
  font: "--wc-font",
};

/** The host element lives in the page, so `var(--page-token)` resolves against the page and follows its theme switch. */
export function applyTheme(host: HTMLElement, map: ThemeMap): void {
  for (const [k, prop] of Object.entries(THEME_VARS)) {
    const value = map[k as keyof ThemeMap];
    if (value) host.style.setProperty(prop, value);
    else host.style.removeProperty(prop);
  }
  if (!map.font) host.style.setProperty("--wc-font", getComputedStyle(document.body).fontFamily);
}
