import { Archive, ArchiveRestore, ArrowLeft, Bot, Check, Globe, Hand, Info, Mail, MonitorSmartphone, Send, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { newId, renderMarkdown, visitorLabel, type ChatMessage, type ChatStatus, type ChatSummary, type VisitorLabel } from "@website-chatbot/shared";
import { ago, api, chatSocket, usd, type ChatDetail } from "./api";
import { notify } from "./presence";
import { Badge, Button, Empty, ErrorLine } from "./ui";

/** Chats per page, as the server sends them. */
const PAGE = 50;

const FILTERS = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "wants", label: "Waiting for you" },
  { id: "email", label: "Left an email" },
  { id: "test", label: "Test" },
  { id: "archived", label: "Archived" },
] as const;

/** The visitor's name or email when known, else their label in the chosen style. */
export function visitorName(c: ChatSummary, style: VisitorLabel): string {
  return c.name || c.email || visitorLabel(style, { visitorId: c.visitorId, number: c.visitorNumber });
}

const place = (c: ChatSummary) => [c.city, c.region && c.region !== c.city ? c.region : undefined, c.country].filter(Boolean).join(", ");

export function Chats({ selected, sites, event, labelStyle }: { selected?: string; sites: { key: string; name: string }[]; event: ChatSummary | null; labelStyle: VisitorLabel }) {
  const [filter, setFilter] = useState<string>("all");
  const [site, setSite] = useState("");
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setChats(null);
    api
      .chats(filter, site)
      .then((list) => {
        setChats(list);
        setMore(list.length >= PAGE);
      })
      .catch((e: Error) => setError(e.message));
  }, [filter, site, reload]);

  const loadMore = async () => {
    if (!chats?.length) return;
    setLoadingMore(true);
    try {
      // Live chats sort first, so the cursor is the oldest chat that isn't live.
      const offline = chats.filter((c) => !c.visitorOnline);
      const older = await api.chats(filter, site, Math.min(...(offline.length ? offline : chats).map((c) => c.updatedAt)));
      setChats((list) => [...(list ?? []), ...older.filter((c) => !list?.some((x) => x.id === c.id))]);
      setMore(older.length >= PAGE);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoadingMore(false);
  };

  const archiveTests = async () => {
    setArchiving(true);
    try {
      await api.archiveTestChats();
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
    setArchiving(false);
  };

  // Live updates from the hub: replace or insert the changed chat.
  useEffect(() => {
    if (!event) return;
    setChats((list) => {
      if (!list) return list;
      const rest = list.filter((c) => c.id !== event.id);
      const keep =
        (site === "" || event.site === site) &&
        event.archived === (filter === "archived") &&
        (filter !== "live" || event.visitorOnline) &&
        (filter !== "wants" || event.wantsOwner) &&
        (filter !== "email" || !!event.email) &&
        (filter !== "test" || event.test);
      return keep ? [event, ...rest].sort((a, b) => Number(b.visitorOnline) - Number(a.visitorOnline) || b.updatedAt - a.updatedAt) : rest;
    });
  }, [event, filter, site]);

  const siteName = (key: string) => sites.find((s) => s.key === key)?.name ?? key;

  return (
    <div className="flex h-full min-h-0">
      <section className={`flex w-full min-w-0 flex-col border-r border-border md:w-80 md:shrink-0 ${selected ? "hidden md:flex" : "flex"}`}>
        <div className="space-y-2 border-b border-border p-3">
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="Filter chats">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${filter === f.id ? "bg-fg text-bg" : "bg-muted text-muted-fg hover:text-fg"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {sites.length > 1 && (
            <select aria-label="Site" value={site} onChange={(e) => setSite(e.target.value)} className="w-full rounded-md border border-border bg-panel px-2 py-1 text-sm">
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          {filter === "test" && !!chats?.length && (
            <Button className="w-full" disabled={archiving} onClick={() => void archiveTests()}>
              <Archive size={14} /> {archiving ? "Archiving…" : "Archive all test chats"}
            </Button>
          )}
        </div>
        <ErrorLine error={error} />
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {chats === null && <li className="p-4 text-sm text-muted-fg">Loading chats…</li>}
          {chats?.length === 0 && (
            <li className="p-6 text-center text-sm text-muted-fg">
              {filter === "all" ? "No chats yet. They appear here as visitors start them." : filter === "archived" ? "No archived chats." : "No chats match this filter."}
            </li>
          )}
          {chats?.map((c) => (
            <li key={c.id}>
              <a
                href={`#/chats/${c.id}`}
                aria-current={selected === c.id ? "true" : undefined}
                className={`block border-b border-border px-3 py-2.5 hover:bg-muted ${selected === c.id ? "bg-muted" : ""}`}
              >
                <div className="flex items-center gap-2">
                  {c.visitorOnline && <span className="h-2 w-2 shrink-0 rounded-full bg-ok" title="Visitor is on the site" />}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{visitorName(c, labelStyle)}</span>
                  <span className="shrink-0 text-xs text-muted-fg">{ago(c.updatedAt)}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-fg">{[place(c), c.device?.split(" / ")[0]].filter(Boolean).join(" · ")}</p>
                <p className="mt-0.5 truncate text-xs text-muted-fg">{c.preview || "No messages yet"}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {sites.length > 1 && <Badge>{siteName(c.site)}</Badge>}
                  {c.test && <Badge>Test</Badge>}
                  {c.wantsOwner && <Badge tone="warn">Waiting for you</Badge>}
                  {c.mode === "owner" && <Badge tone="accent">You're in</Badge>}
                  {c.mode === "form" && <Badge>Get in touch</Badge>}
                  {c.unread > 0 && <Badge tone="accent">{c.unread} new</Badge>}
                </div>
              </a>
            </li>
          ))}
          {more && (
            <li className="p-3">
              <Button className="w-full" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading…" : "Load older chats"}
              </Button>
            </li>
          )}
        </ul>
      </section>
      <section className={`min-w-0 flex-1 ${selected ? "flex" : "hidden md:flex"}`}>
        {selected ? <ChatView key={selected} id={selected} siteName={siteName} labelStyle={labelStyle} /> : <Empty>Pick a chat to read it.</Empty>}
      </section>
    </div>
  );
}

function ChatView({ id, siteName, labelStyle }: { id: string; siteName: (k: string) => string; labelStyle: VisitorLabel }) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [presence, setPresence] = useState<{ visitorOnline: boolean; page?: string }>({ visitorOnline: false });
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const sock = useRef<ReturnType<typeof chatSocket> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    api
      .chat(id)
      .then((d) => {
        setDetail(d);
        // The live socket may already have newer messages: keep them.
        setMessages((live) => merge(d.messages, live));
      })
      .catch((e: Error) => setError(e.message));
    void api.markRead(id).catch(() => {});
    sock.current = chatSocket(
      id,
      (m) => {
        if (m.t === "history") {
          setMessages((l) => merge(l, m.messages));
          setStatus(m.status);
        } else if (m.t === "message") {
          setMessages((l) => merge(l, [m.message]));
          // This open chat keeps the visitor's messages from counting as unread, so it raises the notification itself.
          if (m.message.role === "visitor" && document.hidden) notify("New message in your chat", m.message.text, () => {});
        }
        else if (m.t === "update") setMessages((l) => l.map((x) => (x.id === m.message.id ? m.message : x)));
        else if (m.t === "status") setStatus(m.status);
        else if (m.t === "presence") setPresence({ visitorOnline: m.visitorOnline, page: m.page });
      },
      setConnected,
    );
    return () => sock.current?.close();
  }, [id]);

  // Follow new messages only while already at the bottom, so reading older ones isn't interrupted.
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    if (atBottom.current) void bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, status?.busy]);

  const chat = detail?.chat;
  const totalCost = useMemo(() => messages.reduce((n, m) => n + (m.meta?.costUsd ?? 0), 0), [messages]);

  if (error) return <div className="p-4"><ErrorLine error={error} /></div>;
  if (!chat) return <Empty>Loading chat…</Empty>;

  const archive = async () => {
    try {
      await api.archive(chat.id, !chat.archived);
      setDetail((d) => (d ? { ...d, chat: { ...d.chat, archived: !d.chat.archived } } : d));
      if (!chat.archived) location.hash = "#/chats";
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const details = (
    <>
      <Detail icon={UserRound} label="Visitor">
        <div>
          {visitorLabel(labelStyle, { visitorId: chat.visitorId, number: chat.visitorNumber })}
          {chat.visitorChats && chat.visitorChats > 1 ? <span className="text-muted-fg"> · {chat.visitorChats} chats</span> : null}
          {chat.test ? <span className="text-muted-fg"> · Test</span> : null}
        </div>
        {chat.name && <div>{chat.name}</div>}
        {chat.email ? (
          <a className="text-accent underline" href={`mailto:${chat.email}`}>
            {chat.email}
          </a>
        ) : (
          <span className="text-muted-fg">No email given</span>
        )}
      </Detail>
      <Detail icon={Globe} label="Where">
        <div>{place(chat) || "Unknown location"}</div>
        <div className="text-muted-fg">Page: {presence.page ?? chat.page ?? "unknown"}</div>
        <div className="text-muted-fg">Came from: {chat.referrer || "direct"}</div>
      </Detail>
      <Detail icon={MonitorSmartphone} label="Device">
        <div className="text-muted-fg">{chat.device ?? "Unknown"}</div>
      </Detail>
      <Detail icon={Bot} label="AI">
        <div className="tabular">
          {usd(Math.max(totalCost, chat.costUsd))} · {chat.model ?? "no answers yet"}
        </div>
      </Detail>
      {detail.visitorChats.length > 0 && (
        <Detail icon={Mail} label="Earlier chats">
          <ul className="space-y-1">
            {detail.visitorChats.map((v) => (
              <li key={v.id}>
                <a href={`#/chats/${v.id}`} className="block truncate text-accent underline">
                  {ago(v.updatedAt)}: {v.preview || "empty"}
                </a>
              </li>
            ))}
          </ul>
        </Detail>
      )}
    </>
  );

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 md:gap-2 md:px-3 md:py-2">
          <a href="#/chats" className="rounded-md p-1.5 text-muted-fg hover:bg-muted md:hidden" aria-label="Back to chats">
            <ArrowLeft size={18} />
          </a>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{visitorName(chat, labelStyle)}</p>
            <p className="truncate text-xs text-muted-fg">
              {presence.visitorOnline ? <span className="text-ok">On the site{presence.page ? ` · ${presence.page}` : ""}</span> : "Left the site"} · {siteName(chat.site)}
            </p>
          </div>
          {(status ? status.wantsOwner : chat.wantsOwner) && (
            <Button
              onClick={() => sock.current?.send({ t: "owner_done" })}
              disabled={!connected} title={'Clears "Waiting for you" without replying'} className="px-2 md:px-3">
              <Check size={15} /> <span className="hidden sm:inline">Done</span>
            </Button>
          )}
          {status?.mode === "owner" ? (
            <Button onClick={() => sock.current?.send({ t: "owner_hand_back" })} title="The AI answers the visitor's next message" className="px-2 md:px-3">
              <Bot size={15} /> <span className="hidden sm:inline">Hand back to AI</span>
              <span className="sm:hidden">Hand back</span>
            </Button>
          ) : (
            <Button variant="primary" onClick={() => sock.current?.send({ t: "owner_join" })} disabled={!connected} title="You answer from here on; an answer the AI is writing still finishes" className="px-2 md:px-3">
              <Hand size={15} /> <span className="hidden sm:inline">Join chat</span>
              <span className="sm:hidden">Join</span>
            </Button>
          )}
          <button className="rounded-md p-1.5 text-muted-fg hover:bg-muted" aria-label={chat.archived ? "Restore chat" : "Archive chat"} title={chat.archived ? "Restore chat" : "Archive chat"} onClick={() => void archive()}>
            {chat.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}
          </button>
          <button className="rounded-md p-1.5 text-muted-fg hover:bg-muted xl:hidden" aria-label="Visitor details" aria-expanded={info} onClick={() => setInfo(true)}>
            <Info size={18} />
          </button>
        </header>

        {info && (
          <div className="fixed inset-0 z-40 flex justify-end bg-black/40 xl:hidden" onClick={() => setInfo(false)}>
            <div className="h-full w-80 max-w-[85%] space-y-4 overflow-y-auto bg-panel p-4 text-sm shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Visitor details">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Visitor details</h2>
                <button className="rounded-md p-1.5 hover:bg-muted" aria-label="Close details" onClick={() => setInfo(false)}>
                  <X size={18} />
                </button>
              </div>
              {details}
            </div>
          </div>
        )}

        <div
          className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 md:p-4"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {messages.length === 0 && <p className="text-center text-sm text-muted-fg">No messages yet.</p>}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          {status?.busy && <p className="text-xs text-muted-fg">AI is answering{status.progress ? `: ${status.progress}` : ""}…</p>}
          {status?.mode === "form" && <p className="text-center text-xs text-muted-fg">The visitor sees the Get in touch form ({status.reason?.replace("_", " ")}).</p>}
          <div ref={bottom} />
        </div>

        <Reply key={chat.id} status={status} connected={connected} hasEmail={!!(chat.email || status?.visitorEmail)} visitorOnline={presence.visitorOnline} onSend={(text, email) => sock.current?.send({ t: "owner_send", id: newId("m"), text, email })} />
      </div>

      <aside className="hidden w-72 shrink-0 space-y-4 overflow-y-auto border-l border-border p-4 text-sm xl:block [html[data-d-layout=two]_&]:hidden">
        {details}
      </aside>
    </div>
  );
}

/** Both lists, one copy per message, in order. */
function merge(a: ChatMessage[], b: ChatMessage[]): ChatMessage[] {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.seq - y.seq);
}

function Detail({ icon: Icon, label, children }: { icon: typeof Globe; label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-fg">
        <Icon size={13} aria-hidden /> {label}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  if (m.role === "system")
    return (
      <p className="text-center text-xs text-muted-fg">
        {m.text}
        {m.meta?.reason && ` (${m.meta.reason})`}
      </p>
    );
  const mine = m.role === "owner";
  const visitor = m.role === "visitor";
  return (
    <div className={`flex flex-col ${visitor ? "items-start" : "items-end"}`}>
      <div className={`md max-w-[85%] rounded-lg px-3 py-2 ${visitor ? "bg-muted" : mine ? "bg-accent text-accent-fg [&_a]:text-accent-fg" : "border border-border bg-panel"}`}>
        {visitor ? <span className="whitespace-pre-wrap">{m.text}</span> : <div dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />}
      </div>
      <p className="mt-0.5 flex flex-wrap gap-1.5 px-1 text-[11px] text-muted-fg tabular">
        <span>{m.role === "ai" ? "AI" : mine ? "You" : "Visitor"}</span>
        <span>{new Date(m.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
        {m.meta?.via === "email" && <span>by email</span>}
        {m.meta?.emailed && <span>also emailed</span>}
        {m.meta?.model && <span>{m.meta.model}</span>}
        {m.meta?.costUsd !== undefined && m.role === "ai" && <span>{usd(m.meta.costUsd)}</span>}
        {m.feedback === 1 && <span className="text-ok">Rated helpful</span>}
        {m.feedback === -1 && <span className="text-danger">Rated not helpful</span>}
        {m.suggestions?.length ? <span title={m.suggestions.join(" | ")}>{m.suggestions.length} suggestions</span> : null}
      </p>
    </div>
  );
}

function Reply({ status, connected, hasEmail, visitorOnline, onSend }: { status: ChatStatus | null; connected: boolean; hasEmail: boolean; visitorOnline: boolean; onSend: (text: string, email: boolean) => void }) {
  const [text, setText] = useState("");
  // Emailing follows the visitor: on while they're away from the chat, off while they're in it, until the owner picks.
  const [email, setEmail] = useState(!visitorOnline);
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (!picked) setEmail(!visitorOnline);
  }, [visitorOnline, picked]);
  const joined = status?.mode === "owner";
  const send = () => {
    const t = text.trim();
    if (!t || !connected) return;
    onSend(t, email && hasEmail);
    setText("");
  };
  return (
    <form
      className="border-t border-border p-2 md:p-3"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={joined ? "Reply to the visitor…" : "Reply to take over from the AI…"}
          aria-label="Your reply"
          className="min-h-10 flex-1 resize-none rounded-md border border-border bg-panel px-3 py-2 text-sm"
        />
        <Button type="submit" variant="primary" disabled={!text.trim() || !connected} aria-label={joined ? "Send" : "Send and take over"} className="h-10">
          <Send size={15} /> <span className="hidden md:inline">{joined ? "Send" : "Send and take over"}</span>
        </Button>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <label className={`flex items-center gap-2 text-xs ${hasEmail ? "" : "text-muted-fg"}`} title={hasEmail ? "" : "The visitor hasn't given an email address"}>
          <input
            type="checkbox"
            checked={email && hasEmail}
            disabled={!hasEmail}
            onChange={(e) => {
              setPicked(true);
              setEmail(e.target.checked);
            }}
          />
          Also email this reply
        </label>
        <span className="text-xs text-muted-fg">{!connected ? "Connecting…" : joined ? "" : <span className="hidden md:inline">Sending takes over from the AI</span>}</span>
      </div>
    </form>
  );
}
