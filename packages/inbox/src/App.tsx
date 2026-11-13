import { BarChart3, Inbox, Mail, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ChatSummary, Settings as SettingsT } from "@website-chatbot/shared";
import { api, hubSocket, usd, type Overview } from "./api";
import { Chats } from "./Chats";
import { Enquiries } from "./Enquiries";
import { Settings } from "./Settings";
import { Stats } from "./Stats";
import { ErrorLine, Toggle } from "./ui";

type Route = { page: "chats"; id?: string } | { page: "enquiries" } | { page: "stats" } | { page: "settings" };

function parseHash(): Route {
  const [, page, id] = location.hash.replace(/^#/, "").split("/");
  if (page === "enquiries" || page === "stats" || page === "settings") return { page };
  return { page: "chats", id: id || undefined };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatEvent, setChatEvent] = useState<ChatSummary | null>(null);
  const [enquiryTick, setEnquiryTick] = useState(0);
  const [live, setLive] = useState(false);

  const refresh = useCallback(() => {
    api
      .overview()
      .then((o) => {
        setOverview(o);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    refresh();
    const hub = hubSocket(
      (m) => {
        if (m.t === "chat") setChatEvent(m.chat);
        if (m.t === "enquiry") setEnquiryTick((n) => n + 1);
        if (m.t === "settings") refresh();
      },
      setLive,
    );
    const timer = setInterval(refresh, 60_000);
    return () => {
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
  const nav = [
    { page: "chats", label: "Chats", icon: Inbox },
    { page: "enquiries", label: "Messages", icon: Mail },
    { page: "stats", label: "Stats", icon: BarChart3 },
    { page: "settings", label: "Settings", icon: SettingsIcon },
  ] as const;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-border bg-panel md:w-56 md:border-r">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <h1 className="text-base font-semibold">Chat inbox</h1>
          <span className={`text-xs ${live ? "text-ok" : "text-muted-fg"}`} title={live ? "Live updates on" : "Reconnecting to live updates"}>
            {live ? "● Live" : "○ Offline"}
          </span>
        </div>
        <nav className="order-last flex border-t border-border md:order-none md:flex-col md:border-0 md:px-2" aria-label="Sections">
          {nav.map(({ page, label, icon: Icon }) => (
            <a
              key={page}
              href={`#/${page}`}
              aria-current={route.page === page ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-0.5 px-3 py-2 text-xs md:flex-row md:gap-2.5 md:rounded-md md:text-sm ${route.page === page ? "text-accent md:bg-muted md:text-fg" : "text-muted-fg hover:text-fg"}`}
            >
              <Icon size={16} aria-hidden />
              {label}
            </a>
          ))}
        </nav>
        {s && (
          <div className="flex items-center gap-4 border-t border-border px-4 py-2 md:mt-auto md:block md:space-y-1 md:py-3">
            <Toggle label="I'm online" hint={s.ownerOnline ? "Visitors can ask you to join" : "Requests go to email"} checked={s.ownerOnline} onChange={(v) => void saveSettings({ ownerOnline: v })} />
            <Toggle label="AI answers" hint={s.aiEnabled ? "On" : "Off: visitors see Get in touch"} checked={s.aiEnabled} onChange={(v) => void saveSettings({ aiEnabled: v })} />
            <p className="hidden pt-1 text-xs text-muted-fg md:block tabular">
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
