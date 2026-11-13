// Dev only: the shared Notes widget and Design menu from the local notes server.
const NOTES = "http://127.0.0.1:7790";
const API = `${NOTES}/api/devnotes/website-chatbot`;

export const DESIGN_ROWS = [
  { key: "layout", label: "Inbox layout", options: [{ id: "three", label: "Three panes" }, { id: "two", label: "Two panes" }], fallback: "three" },
];

type W = Window & {
  DesignWidget?: { apply(rows: unknown, o?: object): void; init(o: object): void };
  NotesWidget?: { init(o: object): void };
  NotesStarterConfig?: unknown;
};

const load = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(src));
    document.head.appendChild(s);
  });

export async function loadDevTools(): Promise<void> {
  const w = window as W;
  const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = `${NOTES}/devnotes/design-widget.css`;
  document.head.appendChild(css);
  try {
    await load(`${NOTES}/devnotes/design-widget.js`);
    w.DesignWidget?.apply(DESIGN_ROWS, { storage: "wcb-inbox-dw-" });
  } catch {
    return;
  }
  let ready = false;
  const initDesign = (anchor?: string) => {
    if (ready) return;
    ready = true;
    w.DesignWidget?.init({ rows: DESIGN_ROWS, anchor, isDark, storage: "wcb-inbox-dw-" });
  };
  setTimeout(() => initDesign(), 2500);
  window.addEventListener(
    "notes-loaded",
    () => {
      w.NotesWidget?.init({
        app: "Website Chatbot",
        endpoint: API,
        position: "bottom-left",
        instance: `Inbox :${location.port}`,
        showInstance: true,
        screen: () => `Inbox ▸ ${location.hash.split("/")[1] || "chats"}`,
        isDark,
      });
      initDesign(".nw-launcher");
    },
    { once: true },
  );
  w.NotesStarterConfig = { state: `${API}/state`, files: [`${NOTES}/devnotes/notes-widget.css`, `${NOTES}/devnotes/notes-widget.js`] };
  load(`${NOTES}/devnotes/notes-starter.js`).catch(() => initDesign());
}
