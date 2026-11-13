import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { isEmail, renderMarkdown, startersFor, visiblePreview, type ChatMessage, type GetInTouchReason, type PublicSiteConfig } from "@website-chatbot/shared";
import { emit, type ChatClient, type PastChat } from "./client";
import { Icon } from "./icons";

import { currentPath, forced, live, notice, setView, site, ui, type View } from "./store";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const CLOSE_MS = 180;

export function App({ client }: { client: ChatClient }) {
  const [closing, setClosing] = useState(false);
  const s = site.value;
  const v = forced.value ?? live.value;
  const u = ui.value;
  if (!s) return null;

  const open = () => {
    setView({ open: true, bubble: false });
    emit("opened");
    void client.start();
  };
  // The panel plays its closing animation before it unmounts.
  const close = () => {
    if (closing) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setView({ open: false, menu: false });
    setClosing(true);
    setTimeout(() => {
      setView({ open: false, menu: false });
      setClosing(false);
    }, CLOSE_MS);
  };
  const isOpen = v.open && !closing;

  return (
    <div class={`root corner-${u.corner} actions-${u.actions} ${v.open ? "is-open" : ""}`}>
      {v.open && <Panel client={client} site={s} v={v} closing={closing} onClose={close} />}
      {!v.open && v.bubble && s.proactive.text && (
        <div class="bubble" role="status">
          <button class="bubble-text" onClick={open}>
            {s.proactive.text}
          </button>
          <button class="icon-btn small" aria-label="Dismiss" onClick={() => setView({ bubble: false })}>
            <Icon name="x" />
          </button>
        </div>
      )}
      <button
        class={`launcher launcher-${u.launcher} ${isOpen ? "open" : ""}`}
        aria-label={isOpen ? `Close ${s.assistantName}` : `Open ${s.assistantName}`}
        aria-expanded={isOpen}
        onClick={isOpen ? close : open}
      >
        <span class="launcher-icon" key={isOpen ? "x" : "chat"}>
          <Icon name={isOpen ? "x" : "chat"} />
        </span>
        {u.launcher === "pill" && !isOpen && <span>{s.assistantName}</span>}
      </button>
    </div>
  );
}

function Panel({ client, site: s, v, closing, onClose }: { client: ChatClient; site: PublicSiteConfig; v: View; closing: boolean; onClose: () => void }) {
  const u = ui.value;
  const st = v.status;
  const panelRef = useRef<HTMLDivElement>(null);
  const size = useResize(panelRef);
  const [expanded, setExpanded] = useExpanded();
  const sheet = expanded || u.panel === "sheet";
  // The side sheet keeps the visitor's width; its height is the whole window.
  const sizeStyle = { ...(size.w ? { width: `${size.w}px` } : {}), ...(!sheet && size.h ? { height: `${size.h}px` } : {}) };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((forced.value ?? live.value).menu) setView({ menu: false });
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const formReason: GetInTouchReason | null =
    v.conn === "unreachable" ? null : st.mode === "form" ? (st.reason ?? "ai_unavailable") : st.reason === "owner_away" && !v.formDismissed && !st.contactSent ? "owner_away" : null;
  const canType = v.conn !== "unreachable" && st.mode !== "form";
  const talkVisible = st.mode === "ai" && !st.ownerJoined;

  return (
    <div class={`panel panel-${sheet ? "sheet" : u.panel} ${closing ? "closing" : ""}`} ref={panelRef} style={sizeStyle} role="dialog" aria-label={s.assistantName}>
      <ResizeHandle panel={panelRef} axis="x" />
      {!sheet && <ResizeHandle panel={panelRef} axis="y" />}
      {!sheet && <ResizeHandle panel={panelRef} axis="xy" />}
      <header class="head">
        <div class="head-title">
          <strong>{s.assistantName}</strong>
          <span class="head-sub">
            {st.ownerJoined ? (
              <>
                <span class="dot on" aria-hidden="true" />
                {cap(s.ownerName)} is here
              </>
            ) : (
              <>
                <span class="tag">AI</span> Answers from this site
              </>
            )}
          </span>
        </div>
        {u.panel !== "sheet" && (
          <button class="icon-btn expand-btn" aria-label={expanded ? "Make the chat smaller" : "Make the chat bigger"} title={expanded ? "Smaller" : "Bigger"} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
            <Icon name={expanded ? "shrink" : "expand"} />
          </button>
        )}
        <button class="icon-btn" aria-label="Chat options" aria-expanded={v.menu} onClick={() => setView({ menu: !v.menu })}>
          <Icon name="dots" />
        </button>
        <button class="icon-btn" aria-label="Close chat" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      {v.menu && <Menu client={client} site={s} v={v} />}

      {talkVisible && u.talkPlacement === "bar" && <TalkBar client={client} site={s} v={v} />}

      <Messages client={client} site={s} v={v} formReason={formReason} />

      {notice.value && <div class={`toast ${notice.value.tone}`}>{notice.value.text}</div>}

      {canType && (
        <Composer client={client} v={v} talk={talkVisible && u.talkPlacement === "composer" ? <TalkLink client={client} site={s} v={v} /> : null} />
      )}
      {u.notice === "under" && (
        <p class="notice-under">
          {s.noticeText}
          {s.privacyUrl && (
            <>
              {" "}
              <a href={s.privacyUrl} target="_blank" rel="noopener">
                Privacy
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function TalkBar({ client, site: s, v }: { client: ChatClient; site: PublicSiteConfig; v: View }) {
  const st = v.status;
  return (
    <div class="talkbar">
      <span class="talk-status">
        <span class={`dot ${st.ownerOnline ? "on" : ""}`} aria-hidden="true" />
        {st.ownerOnline ? "Online now" : "Away, replies by email"}
      </span>
      <button class="link-btn" disabled={st.wantsOwner && st.ownerOnline} onClick={() => client.talkToOwner()}>
        {st.wantsOwner && st.ownerOnline ? "Asked to join" : s.talkLabel}
      </button>
    </div>
  );
}

function TalkLink({ client, site: s, v }: { client: ChatClient; site: PublicSiteConfig; v: View }) {
  const st = v.status;
  return (
    <button class="link-btn talk-inline" disabled={st.wantsOwner && st.ownerOnline} onClick={() => client.talkToOwner()}>
      <span class={`dot ${st.ownerOnline ? "on" : ""}`} aria-hidden="true" />
      {st.wantsOwner && st.ownerOnline ? "Asked to join" : s.talkLabel}
    </button>
  );
}

function Menu({ client, site: s, v }: { client: ChatClient; site: PublicSiteConfig; v: View }) {
  const [emailing, setEmailing] = useState(false);
  const [email, setEmail] = useState(v.status.visitorEmail ?? "");
  const [past, setPast] = useState<PastChat[] | null>(null);
  const u = ui.value;
  const close = () => setView({ menu: false });
  return (
    <div class="menu" role="menu">
      <button role="menuitem" onClick={() => (close(), void client.newChat())}>
        <Icon name="plus" /> Start new chat
      </button>
      <button role="menuitem" aria-expanded={!!past} onClick={async () => setPast(past ? null : await client.pastChats())}>
        <Icon name="history" /> Past chats
      </button>
      {past &&
        (past.length ? (
          <div class="past">
            {past.map((p) => (
              <button key={p.id} role="menuitem" class="past-item" onClick={() => (close(), void client.switchTo(p.id))}>
                <span class="past-text">{p.preview.replace(/^\w+: /, "").replace(/[*_#`>[\]]/g, "").replace(/\s+/g, " ").trim() || "Chat"}</span>
                <span class="past-when">{new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              </button>
            ))}
          </div>
        ) : (
          <p class="menu-note">No earlier chats in this browser.</p>
        ))}
      {!emailing ? (
        <button role="menuitem" disabled={!v.messages.length} onClick={() => setEmailing(true)}>
          <Icon name="mail" /> Email me this chat…
        </button>
      ) : (
        <form
          class="menu-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isEmail(email)) return;
            client.emailTranscript(email);
            setEmailing(false);
            close();
          }}
        >
          <input type="email" required placeholder="you@example.com" aria-label="Your email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} autoFocus />
          <button type="submit" class="btn small">
            Send
          </button>
        </form>
      )}
      {u.talkPlacement === "menu" && v.status.mode === "ai" && !v.status.ownerJoined && (
        <button role="menuitem" onClick={() => (close(), client.talkToOwner())}>
          <Icon name="person" /> {s.talkLabel}
          {v.status.ownerOnline && <span class="menu-online">Online</span>}
        </button>
      )}
      {u.notice === "menu" && (
        <p class="menu-note">
          {s.noticeText}{" "}
          {s.privacyUrl && (
            <a href={s.privacyUrl} target="_blank" rel="noopener">
              Privacy
            </a>
          )}
        </p>
      )}
    </div>
  );
}

function Messages({ client, site: s, v, formReason }: { client: ChatClient; site: PublicSiteConfig; v: View; formReason: GetInTouchReason | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const u = ui.value;
  const st = v.status;
  const lastAi = [...v.messages].reverse().find((m) => m.role !== "system");
  const showSuggestions = lastAi?.role === "ai" && !st.busy && st.mode === "ai" && !formReason && !!lastAi.suggestions?.length;
  const preview = v.preview ? visiblePreview(v.preview) : "";

  // Follow new content only while the visitor is at the bottom, so reading earlier text isn't interrupted.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      class="body"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      aria-live="polite"
    >
      {v.conn === "unreachable" ? (
        <Unreachable site={s} />
      ) : (
        <>
          {v.loading && !v.messages.length ? <Loading /> : <Welcome client={client} site={s} v={v} />}
          {v.messages.map((m) => (
            <Message key={m.id} m={m} site={s} client={client} />
          ))}
          {st.busy && (preview ? <div class="msg ai streaming" dangerouslySetInnerHTML={{ __html: renderMarkdown(preview) }} /> : <Thinking text={st.progress} />)}
          {st.wantsOwner && st.ownerOnline && !st.ownerJoined && st.mode === "ai" && (
            <p class="system">Asked {s.ownerName} to join. You can keep chatting meanwhile.</p>
          )}
          {showSuggestions && (
            <div class={`suggestions suggestions-${u.suggestions}`}>
              {lastAi.suggestions!.map((t) => (
                <button
                  key={t}
                  class="chip"
                  onClick={() => {
                    emit("suggestion_clicked", { text: t });
                    client.say(t);
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {formReason && <GetInTouch client={client} site={s} reason={formReason} v={v} />}
          {st.mode === "form" && st.contactSent && <Sent site={s} email={st.visitorEmail} />}
          {v.conn === "reconnecting" && <p class="system">Reconnecting…</p>}
        </>
      )}
    </div>
  );
}

function Welcome({ client, site: s, v }: { client: ChatClient; site: PublicSiteConfig; v: View }) {
  const u = ui.value;
  const hasChat = v.messages.some((m) => m.role === "visitor");
  const starters = startersFor(s.starters, currentPath());
  return (
    <div class="welcome">
      <div class="msg ai" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.greeting) }} />
      {u.notice === "welcome" && !hasChat && (
        <p class="notice">
          {s.noticeText}{" "}
          {s.privacyUrl && (
            <a href={s.privacyUrl} target="_blank" rel="noopener">
              Privacy
            </a>
          )}
        </p>
      )}
      {!hasChat && v.status.mode === "ai" && starters.length > 0 && (
        <div class="suggestions suggestions-chips starters">
          {starters.map((t) => (
            <button
              key={t}
              class="chip"
              onClick={() => {
                emit("starter_clicked", { text: t });
                client.say(t);
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ m, site: s, client }: { m: ChatMessage; site: PublicSiteConfig; client: ChatClient }) {
  if (m.role === "system") return <p class="system">{m.text}</p>;
  if (m.role === "visitor") return <div class="msg visitor">{m.text}</div>;
  const isOwner = m.role === "owner";
  return (
    <div class={`msg-wrap ${m.role}`}>
      {isOwner && <span class="who">{cap(s.ownerName)}</span>}
      <div class={`msg ${m.role}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
      <div class="thumbs">
        <CopyButton text={m.text} />
        {!isOwner && (
          <>
            <button class={`icon-btn tiny ${m.feedback === 1 ? "active" : ""}`} aria-label="Helpful" aria-pressed={m.feedback === 1} onClick={() => client.feedback(m.id, m.feedback === 1 ? 0 : 1)}>
              <Icon name="up" />
            </button>
            <button class={`icon-btn tiny ${m.feedback === -1 ? "active" : ""}`} aria-label="Not helpful" aria-pressed={m.feedback === -1} onClick={() => client.feedback(m.id, m.feedback === -1 ? 0 : -1)}>
              <Icon name="down" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      class={`icon-btn tiny ${copied ? "active" : ""}`}
      aria-label={copied ? "Copied" : "Copy"}
      title={copied ? "Copied" : "Copy"}
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        )
      }
    >
      <Icon name={copied ? "check" : "copy"} />
    </button>
  );
}

function Loading() {
  return (
    <div class="loading" role="status" aria-label="Loading your chat">
      <i />
      <i />
      <i />
    </div>
  );
}

function Thinking({ text }: { text?: string }) {
  return (
    <div class="thinking" role="status">
      <span class="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {text ? `${text}…` : "Thinking…"}
    </div>
  );
}

const FORM_COPY: Record<GetInTouchReason, (owner: string) => { title: string; text: string }> = {
  owner_away: (o) => ({ title: "Leave a message", text: `${cap(o)} isn't online right now. Leave your email and you'll get a reply.` }),
  asked: (o) => ({ title: "Leave a message", text: `${cap(o)} will reply by email.` }),
  ai_unavailable: (o) => ({ title: "Get in touch", text: `The assistant isn't available right now. Leave a message and ${o} will reply by email.` }),
  ai_off: (o) => ({ title: "Get in touch", text: `Leave a message and ${o} will reply by email.` }),
  cap: (o) => ({ title: "Get in touch", text: `Leave a message and ${o} will reply by email.` }),
  budget: (o) => ({ title: "Get in touch", text: `Leave a message and ${o} will reply by email.` }),
  limit: (o) => ({ title: "That's the limit for today", text: `You can still leave a message, and ${o} will reply by email.` }),
};

function GetInTouch({ client, site: s, reason, v }: { client: ChatClient; site: PublicSiteConfig; reason: GetInTouchReason; v: View }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(v.status.visitorEmail ?? "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  if (v.status.contactSent && reason !== "owner_away") return null;
  const copy = FORM_COPY[reason](s.ownerName);
  return (
    <form
      class="card form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!isEmail(email.trim())) return setError("Enter a valid email address");
        if (!message.trim()) return setError("Write a message");
        setError("");
        setSending(true);
        client.contact(name, email.trim(), message);
        setTimeout(() => setSending(false), 4000);
      }}
    >
      <strong>{copy.title}</strong>
      <p>{copy.text}</p>
      <label>
        Name
        <input value={name} autoComplete="name" onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        Email
        <input type="email" required value={email} autoComplete="email" onInput={(e) => setEmail(e.currentTarget.value)} />
      </label>
      <label>
        Message
        <textarea rows={3} required value={message} onInput={(e) => setMessage(e.currentTarget.value)} />
      </label>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="form-actions">
        <button type="submit" class="btn" disabled={sending}>
          {sending ? "Sending…" : "Send message"}
        </button>
        {reason === "owner_away" && (
          <button type="button" class="link-btn" onClick={() => setView({ formDismissed: true })}>
            Back to chat
          </button>
        )}
      </div>
    </form>
  );
}

function Sent({ site: s, email }: { site: PublicSiteConfig; email?: string }) {
  return (
    <div class="card sent">
      <Icon name="check" />
      <strong>Message sent</strong>
      <p>
        {cap(s.ownerName)} will reply{email ? ` to ${email}` : " by email"}.
      </p>
    </div>
  );
}

function Unreachable({ site: s }: { site: PublicSiteConfig }) {
  return (
    <div class="card offline">
      <strong>Chat isn't available right now</strong>
      <p>You can still reach {s.ownerName} directly.</p>
      <a class="btn" href={`mailto:${s.contactEmail}`}>
        Email {s.contactEmail}
      </a>
      {s.contactUrl && (
        <a class="link-btn" href={s.contactUrl}>
          Open the contact page
        </a>
      )}
    </div>
  );
}

function Composer({ client, v, talk }: { client: ChatClient; v: View; talk: preact.ComponentChildren }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = v.status.busy;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  useEffect(() => {
    if (v.open && window.matchMedia("(pointer: fine)").matches) ref.current?.focus();
  }, [v.open]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    client.say(t);
    setText("");
  };

  return (
    <div class="composer-wrap">
      {talk}
      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={ref}
          rows={1}
          placeholder={v.status.mode === "owner" ? "Write a reply…" : "Ask a question…"}
          aria-label="Message"
          value={text}
          maxLength={2000}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" class="send" aria-label="Send" disabled={!text.trim() || busy}>
          <Icon name="send" />
        </button>
      </form>
    </div>
  );
}

const SIZE_KEY = "wcb:size";
const EXPANDED_KEY = "wcb:expanded";
type Size = { w: number | null; h: number | null };

function readSize(): Size {
  try {
    const s = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as Size | null;
    if (s) return s;
    const w = Number(localStorage.getItem("wcb:width"));
    return { w: w > 0 ? w : null, h: null };
  } catch {
    return { w: null, h: null };
  }
}

/** The visitor's own panel size, remembered in this browser. */
function useResize(panel: { current: HTMLDivElement | null }): Size {
  const [size, setSize] = useState<Size>(readSize);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const onResize = (e: Event) => {
      const s = (e as CustomEvent<Size>).detail;
      setSize(s);
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify(s));
      } catch {
        // not remembered; fine
      }
    };
    el.addEventListener("wcb-resize", onResize);
    return () => el.removeEventListener("wcb-resize", onResize);
  }, [panel]);
  return size;
}

/** The "bigger" button's state (opens the side sheet), remembered in this browser. */
function useExpanded(): [boolean, (v: boolean) => void] {
  const [expanded, set] = useState(() => {
    try {
      return localStorage.getItem(EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const update = (v: boolean) => {
    set(v);
    try {
      localStorage.setItem(EXPANDED_KEY, v ? "1" : "0");
    } catch {
      // not remembered; fine
    }
  };
  return [expanded, update];
}

const HANDLE: Record<"x" | "y" | "xy", { cls: string; title: string }> = {
  x: { cls: "resize", title: "Drag to change the width" },
  y: { cls: "resize-top", title: "Drag to change the height" },
  xy: { cls: "resize-corner", title: "Drag to change the size" },
};

/** Drag handles (desktop only): inner edge = width, top edge = height, top inner corner = both. */
function ResizeHandle({ panel, axis }: { panel: { current: HTMLDivElement | null }; axis: "x" | "y" | "xy" }) {
  const MIN_W = 340;
  const MAX_W = 720;
  const MIN_H = 360;
  const onDown = (e: PointerEvent) => {
    const el = panel.current;
    if (!el) return;
    e.preventDefault();
    const fromRight = ui.value.corner === "right";
    const startX = e.clientX;
    const startY = e.clientY;
    const r = el.getBoundingClientRect();
    // The panel grows upwards from its bottom edge; keep 8px clear of the top of the window.
    const maxH = Math.max(MIN_H, r.bottom - 8);
    const move = (ev: PointerEvent) => {
      const dx = fromRight ? startX - ev.clientX : ev.clientX - startX;
      if (axis !== "y") el.style.width = `${Math.max(MIN_W, Math.min(MAX_W, r.width + dx))}px`;
      if (axis !== "x") el.style.height = `${Math.max(MIN_H, Math.min(maxH, r.height + startY - ev.clientY))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const now = el.getBoundingClientRect();
      const prev = readSize();
      el.dispatchEvent(new CustomEvent("wcb-resize", { detail: { w: axis === "y" ? prev.w : now.width, h: axis === "x" ? prev.h : now.height } satisfies Size }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div class={HANDLE[axis].cls} onPointerDown={onDown} aria-hidden="true" title={HANDLE[axis].title} />;
}
