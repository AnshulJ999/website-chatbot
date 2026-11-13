/** One step of the model ladder. `provider` is an Omnara provider config name. */
export interface ModelTier {
  provider: string;
  model: string;
  label: string;
  free: boolean;
  enabled: boolean;
}

export type LimitAction = "free_tier" | "get_in_touch";

/** Global settings, edited in the inbox. Every number here is Anshul's to approve. */
export interface Settings {
  aiEnabled: boolean;
  ownerOnline: boolean;
  /** true = real word-by-word deltas from Omnara; false = finished answers only. */
  streaming: boolean;
  ladder: ModelTier[];
  chatCapUsd: number;
  capAction: LimitAction;
  dailyBudgetUsd: number;
  budgetAction: LimitAction;
  perVisitorDailyMessages: number;
  maxMessageChars: number;
  stallTimeoutSec: number;
  turnTimeoutSec: number;
  cooldownAfterFailures: number;
  cooldownMinutes: number;
  archiveAfterDays: number;
  alertOnNewChat: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  aiEnabled: true,
  ownerOnline: false,
  streaming: true,
  ladder: [
    { provider: "omnara-openrouter", model: "deepseek/deepseek-v4.1-flash-latest", label: "DeepSeek V4.1 Flash", free: false, enabled: true },
    { provider: "omnara-openrouter", model: "openai/gpt-6-luna", label: "GPT-6 Luna", free: false, enabled: true },
    { provider: "openrouter-byok", model: "openrouter/free", label: "OpenRouter free (auto)", free: true, enabled: false },
  ],
  chatCapUsd: 0.5,
  capAction: "free_tier",
  dailyBudgetUsd: 2,
  budgetAction: "get_in_touch",
  perVisitorDailyMessages: 40,
  maxMessageChars: 2000,
  stallTimeoutSec: 30,
  turnTimeoutSec: 120,
  cooldownAfterFailures: 3,
  cooldownMinutes: 15,
  archiveAfterDays: 14,
  alertOnNewChat: false,
};

/** CSS expressions resolved against the host page, e.g. "var(--color-primary)" or "hsl(var(--primary))". */
export interface ThemeMap {
  background?: string;
  surface?: string;
  foreground?: string;
  muted?: string;
  mutedForeground?: string;
  border?: string;
  accent?: string;
  accentForeground?: string;
  radius?: string;
  font?: string;
}

export interface StarterSet {
  /** Path prefix this set applies to; the longest match wins. "/" is the default. */
  path: string;
  prompts: string[];
}

export interface WidgetUi {
  launcher: "icon" | "pill";
  corner: "right" | "left";
  panel: "compact" | "tall" | "sheet";
  suggestions: "chips" | "list";
  talkPlacement: "bar" | "composer" | "menu";
  notice: "welcome" | "under" | "menu";
}

export const DEFAULT_UI: WidgetUi = {
  launcher: "icon",
  corner: "right",
  panel: "compact",
  suggestions: "chips",
  talkPlacement: "bar",
  notice: "welcome",
};

/** What the widget may know about a site. */
export interface PublicSiteConfig {
  key: string;
  name: string;
  assistantName: string;
  /** How the bot refers to the owner, used at most once per screen ("Anshul", "a person"). */
  ownerName: string;
  /** Label of the button that asks for the owner. */
  talkLabel: string;
  greeting: string;
  starters: StarterSet[];
  contactEmail: string;
  contactUrl?: string;
  privacyUrl?: string;
  noticeText: string;
  theme: ThemeMap;
  ui: Partial<WidgetUi>;
  proactive: { enabled: boolean; delaySec: number; text: string };
  turnstileSiteKey?: string;
}

/** Full site config stored on the server (pushed by kb-sync). */
export interface SiteConfig extends PublicSiteConfig {
  origins: string[];
  /** Omnara memory store name holding this site's knowledge. */
  storeName: string;
  /** The site's own agent instruction (AGENTS.md-style). */
  instruction: string;
  /** Custom tools this site enables, from TOOL_NAMES. */
  tools: string[];
  /** owner/repo for get_latest_release. */
  releasesRepo?: string;
  ownerEmail: string;
  /** Sender for emails to visitors, on a domain verified in Resend. */
  emailFrom: string;
}

export const TOOL_NAMES = ["save_enquiry", "request_owner", "get_latest_release"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function toPublic(site: SiteConfig): PublicSiteConfig {
  return {
    key: site.key,
    name: site.name,
    assistantName: site.assistantName,
    ownerName: site.ownerName,
    talkLabel: site.talkLabel,
    greeting: site.greeting,
    starters: site.starters,
    contactEmail: site.contactEmail,
    contactUrl: site.contactUrl,
    privacyUrl: site.privacyUrl,
    noticeText: site.noticeText,
    theme: site.theme,
    ui: site.ui,
    proactive: site.proactive,
    turnstileSiteKey: site.turnstileSiteKey,
  };
}

export function startersFor(sets: StarterSet[], path: string): string[] {
  let best: StarterSet | undefined;
  for (const s of sets) {
    if (path.startsWith(s.path) && (!best || s.path.length > best.path.length)) best = s;
  }
  return best?.prompts ?? [];
}
