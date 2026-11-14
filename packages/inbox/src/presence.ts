export type Activity = "active" | "idle" | "locked";

const HEARTBEAT_MS = 60_000;

interface Detector extends EventTarget {
  userState: "active" | "idle" | null;
  screenState: "locked" | "unlocked" | null;
  start(o: { threshold: number; signal: AbortSignal }): Promise<void>;
}
type DetectorClass = { new (): Detector; requestPermission(): Promise<PermissionState> };
const detectorClass = () => (window as unknown as { IdleDetector?: DetectorClass }).IdleDetector;

/** "unsupported" outside Chromium browsers; "prompt" until the owner allows it once. */
export async function idleDetectionState(): Promise<PermissionState | "unsupported"> {
  if (!detectorClass()) return "unsupported";
  try {
    return (await navigator.permissions.query({ name: "idle-detection" as PermissionName })).state;
  } catch {
    return "unsupported";
  }
}

/** Must run from a click. */
export async function allowIdleDetection(): Promise<boolean> {
  return (await detectorClass()?.requestPermission().catch(() => "denied")) === "granted";
}

/**
 * Reports the owner's activity: the browser's idle detection when allowed (any input on the computer, screen
 * lock), else input in this tab. "active" repeats every minute so the server's away timer keeps resetting.
 */
export function trackActivity(report: (a: Activity) => void, awayAfterMin: () => number): { resend(): void; stop(): void } {
  const abort = new AbortController();
  let detector: Detector | null = null;
  let lastInput = Date.now();
  let state: Activity = "active";

  const compute = (): Activity => {
    if (detector) return detector.screenState === "locked" ? "locked" : detector.userState === "idle" ? "idle" : "active";
    return Date.now() - lastInput < awayAfterMin() * 60_000 ? "active" : "idle";
  };
  const tick = () => {
    const next = compute();
    if (next === state && next !== "active") return;
    state = next;
    report(state);
  };

  for (const type of ["pointerdown", "keydown", "touchstart", "wheel"]) {
    window.addEventListener(type, () => ((lastInput = Date.now()), state !== "active" && tick()), { passive: true, signal: abort.signal });
  }
  const timer = window.setInterval(tick, HEARTBEAT_MS);

  void (async () => {
    const D = detectorClass();
    if (!D || (await idleDetectionState()) !== "granted") return;
    try {
      const d = new D();
      d.addEventListener("change", tick);
      await d.start({ threshold: Math.max(60, awayAfterMin() * 60) * 1000, signal: abort.signal });
      detector = d;
      tick();
    } catch {
      // stays on this tab's activity
    }
  })();

  report(state);
  return {
    resend: () => report(state),
    stop: () => {
      abort.abort();
      clearInterval(timer);
    },
  };
}

/** A desktop notification (the system plays its sound); clicking it focuses the inbox. */
export function notify(title: string, body: string, onClick: () => void): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(title, { body: body.slice(0, 200), tag: title });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}
