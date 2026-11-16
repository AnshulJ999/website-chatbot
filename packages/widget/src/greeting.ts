import type { GreetingRepeat, PublicSiteConfig } from "@website-chatbot/shared";
import { emit } from "./client";
import { live, patch } from "./store";

const KEY = "wcb:bubble";
const OPENED = "wcb:autoopen";
const CLOSED = "wcb:autoopen-closed";
const PAGES = "wcb:pages";

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Whether the greeting bubble may show again for this visitor. */
export function greetingDue(repeat: GreetingRepeat = "session"): boolean {
  try {
    if (repeat === "session") return !sessionStorage.getItem(KEY);
    if (repeat === "day") return localStorage.getItem(KEY) !== today();
  } catch {
    // storage blocked: show it
  }
  return true;
}

export function greetingShown(): void {
  try {
    sessionStorage.setItem(KEY, "1");
    localStorage.setItem(KEY, today());
  } catch {
    // fine
  }
}

/** Opening the chat by itself suits a large screen only; on a phone it would cover the page. */
export const canAutoOpen = () => matchMedia("(pointer: fine) and (min-width: 768px)").matches;

/** At most once per visit, and not again the day the visitor closed it. */
export function autoOpenDue(): boolean {
  try {
    return !sessionStorage.getItem(OPENED) && localStorage.getItem(CLOSED) !== today();
  } catch {
    return false;
  }
}

/** The visitor closed a chat that opened by itself: leave it shut for today. */
export function autoOpenClosed(): void {
  try {
    localStorage.setItem(CLOSED, today());
  } catch {
    // fine
  }
}

/** Counts this page in the visit; returns how many pages the visitor has seen. */
export function countPage(): number {
  try {
    const n = (Number(sessionStorage.getItem(PAGES)) || 0) + 1;
    sessionStorage.setItem(PAGES, String(n));
    return n;
  } catch {
    return 1;
  }
}

/** Opens the chat (welcome and starters, no connection yet) without taking focus from the page. */
export function autoOpen(): void {
  if (live.value.open || live.value.messages.length) return;
  patch({ open: true, bubble: false, autoOpened: true });
  try {
    sessionStorage.setItem(OPENED, "1");
  } catch {
    // fine
  }
  emit("auto_opened");
}

/**
 * The "open" greeting: after `openAfterSec` on the site, once the visitor shows interest (scrolled, or on a
 * second page). `requireActivity` false is for the Playground, which has nothing to scroll.
 */
export function watchAutoOpen(s: PublicSiteConfig, pages: number, requireActivity = true, start = Date.now()): () => void {
  const href = location.href;
  const after = (s.proactive.openAfterSec ?? 45) * 1000;
  const timer = window.setInterval(() => {
    if (live.value.open || live.value.messages.length || Date.now() - start > 10 * 60_000) return window.clearInterval(timer);
    const active = !requireActivity || pages >= 2 || window.scrollY > 300 || location.href !== href;
    if (Date.now() - start >= after && active) {
      window.clearInterval(timer);
      autoOpen();
    }
  }, 1000);
  return () => window.clearInterval(timer);
}
