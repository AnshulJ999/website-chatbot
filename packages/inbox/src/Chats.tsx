import { ArrowLeft, Bot, Globe, Hand, Mail, MonitorSmartphone, Send, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { newId, renderMarkdown, type ChatMessage, type ChatStatus, type ChatSummary } from "@website-chatbot/shared";
import { ago, api, chatSocket, usd, type ChatDetail } from "./api";
import { Badge, Button, Empty, ErrorLine } from "./ui";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "wants", label: "Waiting for you" },
  { id: "email", label: "Left an email" },
] as const;

export function Chats({ selected, sites, event }: { selected?: string; sites: { key: string; name: string }[]; event: ChatSummary | null }) {
  const [filter, setFilter] = useState<string>("all");
  const [site, setSite] = useState("");
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChats(null);
    api
      .chats(filter, site)
      .then(setChats)
      .catch((e: Error) => setError(e.message));
  }, [filter, site]);

  // Live updates from the hub: replace or insert the changed chat.
  useEffect(() => {
    if (!event) return;
    setChats((list) => {
      if (!list) return list;
      const rest = list.filter((c) => c.id !== event.id);
      const keep = (site === "" || event.site === site) && (filter !== "live" || event.visitorOnline) && (filter !== "wants" || event.wantsOwner) && (filter !== "email" || !!event.email);
      return keep ? [event, ...rest].sort((a, b) => Number(b.visitorOnline) - Number(a.visitorOnline) || b.updatedAt - a.updatedAt) : rest;
    });
  }, [event, filter, site]);

  const siteName = (key: string) => sites.find((s) => s.key === key)?.name ?? key;

  return (
    <div className="flex h-full min-h-0">
      <section className={`flex w-full min-w-0 flex-col border-r border-border md:w-80 md:shrink-0 ${selected ? "hidden md:flex" : "flex"}`}>
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter chats">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-full px-2.5 py-1 text-xs ${filter === f.id ? "bg-fg text-bg" : "bg-muted text-muted-fg hover:text-fg"}`}
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
        </div>
        <ErrorLine error={error} />
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {chats === null && <li className="p-4 text-sm text-muted-fg">Loading chats…</li>}
          {chats?.length === 0 && (
            <li className="p-6 text-center text-sm text-muted-fg">{filter === "all" ? "No chats yet. They appear here as visitors start them." : "No chats match this filter."}</li>
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
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name || c.email || visitorLabel(c)}</span>
                  <span className="shrink-0 text-xs text-muted-fg">{ago(c.updatedAt)}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-fg">{c.preview || "No messages yet"}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {sites.length > 1 && <Badge>{siteName(c.site)}</Badge>}
                  {c.wantsOwner && <Badge tone="warn">Waiting for you</Badge>}
                  {c.mode === "owner" && <Badge tone="accent">You're in</Badge>}
                  {c.mode === "form" && <Badge>Get in touch</Badge>}
                  {c.unread > 0 && <Badge tone="accent">{c.unread} new</Badge>}
                </div>
              </a>
            </li>
          ))}
        </ul>
      </section>
      <section className={`min-w-0 flex-1 ${selected ? "flex" : "hidden md:flex"}`}>
        {selected ? <ChatView key={selected} id={selected} siteName={siteName} /> : <Empty>Pick a chat to read it.</Empty>}
      </section>
    </div>
  );
}

function visitorLabel(c: ChatSummary): string {
  return `Visitor ${c.visitorId.slice(-4)}${c.country ? ` · ${c.country}` : ""}`;
}

function ChatView({ id, siteName }: { id: string; siteName: (k: string) => string }) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [presence, setPresence] = useState<{ visitorOnline: boolean; page?: string }>({ visitorOnline: false });
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sock = useRef<ReturnType<typeof chatSocket> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .chat(id)
      .then((d) => {
        setDetail(d);
        setMessages(d.messages);
      })
      .catch((e: Error) => setError(e.message));
    void api.markRead(id).catch(() => {});
    sock.current = chatSocket(
      id,
      (m) => {
        if (m.t === "history") {
          setMessages(m.messages);
          setStatus(m.status);
        } else if (m.t === "message") setMessages((l) => [...l.filter((x) => x.id !== m.message.id), m.message].sort((a, b) => a.seq - b.seq));
        else if (m.t === "update") setMessages((l) => l.map((x) => (x.id === m.message.id ? m.message : x)));
        else if (m.t === "status") setStatus(m.status);
        else if (m.t === "presence") setPresence({ visitorOnline: m.visitorOnline, page: m.page });
      },
      setConnected,
    );
    return () => sock.current?.close();
  }, [id]);

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    void bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, status?.busy]);

  const chat = detail?.chat;
  const totalCost = useMemo(() => messages.reduce((n, m) => n + (m.meta?.costUsd ?? 0), 0), [messages]);

  if (error) return <div className="p-4"><ErrorLine error={error} /></div>;
  if (!chat) return <Empty>Loading chat…</Empty>;

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <a href="#/chats" className="rounded-md p-1.5 text-muted-fg hover:bg-muted md:hidden" aria-label="Back to chats">
            <ArrowLeft size={18} />
          </a>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{chat.name || chat.email || visitorLabel(chat)}</p>
            <p className="truncate text-xs text-muted-fg">
              {presence.visitorOnline ? <span className="text-ok">On the site{presence.page ? ` · ${presence.page}` : ""}</span> : "Left the site"} · {siteName(chat.site)}
            </p>
          </div>
          {status?.mode === "owner" ? (
            <Button onClick={() => sock.current?.send({ t: "owner_hand_back" })} title="The AI answers the visitor's next message">
              <Bot size={15} /> Hand back to AI
            </Button>
          ) : (
            <Button variant="primary" onClick={() => sock.current?.send({ t: "owner_join" })} disabled={!connected} title="The AI stops answering this chat">
              <Hand size={15} /> Join chat
            </Button>
          )}
        </header>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {messages.length === 0 && <p className="text-center text-sm text-muted-fg">No messages yet.</p>}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          {status?.busy && <p className="text-xs text-muted-fg">AI is answering{status.progress ? `: ${status.progress}` : ""}…</p>}
          {status?.mode === "form" && <p className="text-center text-xs text-muted-fg">The visitor sees the Get in touch form ({status.reason?.replace("_", " ")}).</p>}
          <div ref={bottom} />
        </div>

        <Reply status={status} connected={connected} hasEmail={!!chat.email} onSend={(text, email) => sock.current?.send({ t: "owner_send", id: newId("m"), text, email })} />
      </div>

      <aside className="hidden w-72 shrink-0 space-y-4 overflow-y-auto border-l border-border p-4 text-sm xl:block [html[data-d-layout=two]_&]:hidden">
        <Detail icon={UserRound} label="Visitor">
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
          <div>{[chat.city, chat.country].filter(Boolean).join(", ") || "Unknown location"}</div>
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
      </aside>
    </div>
  );
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
  if (m.role === "system") return <p className="text-center text-xs text-muted-fg">{m.text}</p>;
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

function Reply({ status, connected, hasEmail, onSend }: { status: ChatStatus | null; connected: boolean; hasEmail: boolean; onSend: (text: string, email: boolean) => void }) {
  const [text, setText] = useState("");
  const [email, setEmail] = useState(true);
  const joined = status?.mode === "owner";
  const send = () => {
    const t = text.trim();
    if (!t || !connected) return;
    onSend(t, email && hasEmail);
    setText("");
  };
  return (
    <form
      className="border-t border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={joined ? "Reply to the visitor…" : "Reply to take over from the AI…"}
        aria-label="Your reply"
        className="w-full resize-y rounded-md border border-border bg-panel px-3 py-2 text-sm"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <label className={`flex items-center gap-2 text-xs ${hasEmail ? "" : "text-muted-fg"}`} title={hasEmail ? "" : "The visitor hasn't given an email address"}>
          <input type="checkbox" checked={email && hasEmail} disabled={!hasEmail} onChange={(e) => setEmail(e.target.checked)} />
          Also email this reply
        </label>
        <Button type="submit" variant="primary" disabled={!text.trim() || !connected}>
          <Send size={14} /> {joined ? "Send" : "Send and take over"}
        </Button>
      </div>
      {!connected && <p className="mt-1 text-xs text-muted-fg">Connecting…</p>}
    </form>
  );
}
