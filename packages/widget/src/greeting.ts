import type { GreetingRepeat } from "@website-chatbot/shared";

const KEY = "wcb:bubble";

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
