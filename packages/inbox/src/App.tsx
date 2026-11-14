import { BarChart3, Inbox, Mail, Menu, Settings as SettingsIcon, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSummary, Presence, Settings as SettingsT } from "@website-chatbot/shared";
import { api, hubSocket, usd, type Overview } from "./api";
import { Chats } from "./Chats";
import { Enquiries } from "./Enquiries";
import { allowIdleDetection, idleDetectionState, notify, trackActivity } from "./presence";
import { Settings } from "./Settings";
import { Stats } from "./Stats";
import { ErrorLine, Toggle } from "./ui";

type Route = { page: "chats"; id?: string } | { page: "enquiries" } | { page: "stats" } | { page: "settings" };

function parseHash(): Route {
  const [, page, id] = location.hash.replace(/^#/, "").split("/");
  if (page === "enquiries" || page === "stats" || page === "settings") return { page };
  return { page: "chats", id: id || undefined };
}

const NAV = [
  { page: "chats", label: "Chats", icon: Inbox },
  { page: "enquiries", label: "Messages", icon: Mail },
  { page: "stats", label: "Stats", icon: BarChart3 },
  { page: "settings", label: "Settings", icon: SettingsIcon },
] as const;

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatEvent, setChatEvent] = useState<ChatSummary | null>(null);
  const [enquiryTick, setEnquiryTick] = useState(0);
  const [live, setLive] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const awayAfter = useRef(10);
  const seen = useRef(new Map<string, ChatSummary>());

  const refresh = useCallback(() => {
    api
      .overview()
      .then((o) => {
        setOverview(o);
        setOnline(o.ownerOnline);
        awayAfter.current = o.settings.awayAfterMin;
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    const on = () => {
      setRoute(parseHash());
      setDrawer(false);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    refresh();
    let tracker: ReturnType<typeof trackActivity> | undefined;
    const hub = hubSocket(
      (m) => {
        if (m.t === "chat") {
          setChatEvent(m.chat);
          alertIfNeeded(seen.current, m.chat);
        }
        if (m.t === "enquiry") setEnquiryTick((n) => n + 1);
        if (m.t === "settings") refresh();
        if (m.t === "presence") setOnline(m.online);
      },
      (open) => {
        setLive(open);
        if (open) tracker?.resend();
      },
    );
    tracker = trackActivity((state) => hub.send({ t: "activity", state }), () => awayAfter.current);
    const timer = setInterval(refresh, 60_000);
    return () => {
      tracker?.stop();
      hub.close();
      clearInterval(timer);
    };
  }, [refresh]);

  const saveSettings = async (patch: Partial<SettingsT>) => {
    if (!overview) return;
    setOverview({ ...overview, settings: { ...overview.settings, ...patch } });
    try {
      const settings = await api.settings(patch);
      setOverview((o) => (o ? { ...o, settings } : o));
    } catch (e) {
      setError((e as Error).message);
      refresh();
    }
  };

  const s = overview?.settings;
  const inChat = route.page === "chats" && !!route.id;
  const title = NAV.find((n) => n.page === route.page)?.label ?? "Chats";

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Phone: one slim bar; everything else lives in the menu so the chat gets the screen. */}
      <header className={`items-center gap-1 border-b border-border bg-panel px-1.5 py-1.5 md:hidden ${inChat ? "hidden" : "flex"}`}>
        <button className="rounded-md p-2 hover:bg-muted" aria-label="Menu" aria-expanded={drawer} onClick={() => setDrawer(true)}>
          <Menu size={20} />
        </button>
        <h1 className="flex-1 text-base font-semibold">{title}</h1>
        <span className="flex items-center gap-1.5 px-2 text-xs text-muted-fg">
          <span className={`h-2 w-2 rounded-full ${online ? "bg-ok" : "bg-border"}`} aria-hidden />
          {online ? "Online" : "Away"}
        </span>
      </header>

      {drawer && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setDrawer(false)} aria-hidden />}
      <aside
        className={`${drawer ? "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85%] shadow-xl" : "hidden"} shrink-0 flex-col overflow-y-auto border-border bg-panel md:static md:z-auto md:flex md:w-56 md:max-w-none md:border-r md:shadow-none`}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <h1 className="text-base font-semibold">Chat inbox</h1>
          <span className={`text-xs ${live ? "text-ok" : "text-muted-fg"}`} title={live ? "Live updates on" : "Reconnecting to live updates"}>
            {live ? "● Live" : "○ Offline"}
          </span>
          <button className="rounded-md p-1.5 hover:bg-muted md:hidden" aria-label="Close menu" onClick={() => setDrawer(false)}>
            <X size={18} />
          </button>
        </div>
        <nav className="flex flex-col px-2" aria-label="Sections">
          {NAV.map(({ page, label, icon: Icon }) => (
            <a
              key={page}
              href={`#/${page}`}
              aria-current={route.page === page ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm ${route.page === page ? "bg-muted text-fg" : "text-muted-fg hover:text-fg"}`}
            >
              <Icon size={16} aria-hidden />
              {label}
            </a>
          ))}
        </nav>
        {s && (
          <div className="mt-auto space-y-3 border-t border-border px-4 py-3">
            <PresenceControl settings={s} online={online} onSave={saveSettings} />
            <Toggle label="AI answers" hint={s.aiEnabled ? "On" : "Off: visitors see Get in touch"} checked={s.aiEnabled} onChange={(v) => void saveSettings({ aiEnabled: v })} />
            <p className="text-xs text-muted-fg tabular">
              Today {usd(overview.spendTodayUsd)} of {usd(s.dailyBudgetUsd)}
            </p>
          </div>
        )}
      </aside>

      <main className="min-h-0 min-w-0 flex-1">
        {error && (
          <div className="p-3">
            <ErrorLine error={error} />
          </div>
        )}
        {route.page === "chats" && <Chats selected={route.id} sites={overview?.sites ?? []} event={chatEvent} />}
        {route.page === "enquiries" && <Enquiries tick={enquiryTick} sites={overview?.sites ?? []} />}
        {route.page === "stats" && <Stats sites={overview?.sites ?? []} />}
        {route.page === "settings" && overview && <Settings overview={overview} onSave={saveSettings} />}
      </main>
    </div>
  );
}

/** Desktop notification when a visitor asks for the owner, or writes in a chat the owner has joined, unless that chat is on screen. */
function alertIfNeeded(seen: Map<string, ChatSummary>, chat: ChatSummary): void {
  const before = seen.get(chat.id);
  seen.set(chat.id, chat);
  if (!document.hidden && location.hash === `#/chats/${chat.id}`) return;
  const who = chat.name || chat.email || "A visitor";
  const text = chat.preview.replace(/^\w+: /, "");
  const open = () => (location.hash = `#/chats/${chat.id}`);
  if (chat.wantsOwner && !before?.wantsOwner) notify(`${who} wants to talk to you`, text, open);
  else if (chat.mode === "owner" && chat.unread > (before?.unread ?? 0)) notify(`${who} wrote in your chat`, text, open);
}

const PRESENCE: { id: Presence; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "available", label: "Available" },
  { id: "away", label: "Do not disturb" },
];

function PresenceControl({ settings: s, online, onSave }: { settings: SettingsT; online: boolean; onSave: (p: Partial<SettingsT>) => Promise<void> }) {
  const [idle, setIdle] = useState<PermissionState | "unsupported">("unsupported");
  const [notif, setNotif] = useState<NotificationPermission | "unsupported">("Notification" in window ? Notification.permission : "unsupported");
  useEffect(() => void idleDetectionState().then(setIdle), []);

  return (
    <div>
      <p className="text-sm">Your status</p>
      <div role="radiogroup" aria-label="Your status" className="mt-1 flex rounded-md border border-border p-0.5">
        {PRESENCE.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={s.presence === p.id}
            onClick={() => void onSave({ presence: p.id })}
            className={`flex-1 rounded px-1 py-1 text-xs ${s.presence === p.id ? "bg-fg text-bg" : "text-muted-fg hover:text-fg"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-fg">
        <span className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-ok" : "bg-border"}`} aria-hidden />
        {online ? "Visitors see you online" : "Visitors see you away"}
        {s.presence === "auto" ? `, away after ${s.awayAfterMin} min idle` : ""}
      </p>
      {s.presence === "auto" && idle === "prompt" && (
        <button className="mt-1 text-left text-xs text-accent underline" onClick={() => void allowIdleDetection().then((ok) => ok && location.reload())}>
          Count activity anywhere on this computer
        </button>
      )}
      {notif === "default" && (
        <button className="mt-1 block text-left text-xs text-accent underline" onClick={() => void Notification.requestPermission().then(setNotif)}>
          Turn on desktop notifications
        </button>
      )}
    </div>
  );
}
