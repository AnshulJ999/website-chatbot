import type { PublicSiteConfig } from "./config";

export type Role = "visitor" | "ai" | "owner" | "system";

export interface ChatMessage {
  id: string;
  seq: number;
  role: Role;
  text: string;
  at: number;
  suggestions?: string[];
  /** Visitor's thumbs on an AI answer. */
  feedback?: 1 | -1;
  /** Shown to the owner only. */
  meta?: { model?: string; costUsd?: number; emailed?: boolean; via?: "email" | "widget" | "inbox" };
}

/** ai = the AI answers; owner = the owner has taken over; form = Get in touch only. */
export type ChatMode = "ai" | "owner" | "form";

export type GetInTouchReason = "ai_unavailable" | "cap" | "budget" | "limit" | "ai_off" | "owner_away" | "asked";

export interface ChatStatus {
  mode: ChatMode;
  /** The AI is working on an answer. */
  busy: boolean;
  /** Real progress from tool activity, e.g. "Searching the docs". */
  progress?: string;
  ownerOnline: boolean;
  ownerJoined: boolean;
  /** The visitor (or the AI for them) asked for the owner, who hasn't replied yet. */
  wantsOwner: boolean;
  reason?: GetInTouchReason;
  /** The visitor already sent the contact form in this chat. */
  contactSent: boolean;
  visitorEmail?: string;
}

/** Visitor widget -> ChatRoom */
export type ClientMsg =
  | { t: "send"; id: string; text: string }
  | { t: "talk_to_owner" }
  | { t: "feedback"; msgId: string; value: 1 | -1 | 0 }
  | { t: "contact"; name: string; email: string; message: string }
  | { t: "email_transcript"; email: string }
  | { t: "page"; url: string; title: string }
  | { t: "ping" };

/** Inbox -> ChatRoom (owner socket) */
export type OwnerMsg =
  | { t: "owner_send"; id: string; text: string; email: boolean }
  | { t: "owner_join" }
  | { t: "owner_hand_back" }
  | { t: "ping" };

/** ChatRoom -> both sockets */
export type ServerMsg =
  | { t: "history"; messages: ChatMessage[]; status: ChatStatus }
  | { t: "message"; message: ChatMessage }
  | { t: "update"; message: ChatMessage }
  | { t: "status"; status: ChatStatus }
  /** An Omnara model_output_delta `data:` payload, forwarded untouched. */
  | { t: "delta"; raw: string }
  | { t: "delta_reset" }
  | { t: "presence"; visitorOnline: boolean; page?: string }
  | { t: "error"; code: string; text: string }
  | { t: "pong" };

export interface SessionRequest {
  site: string;
  visitorId?: string;
  visitorKey?: string;
  chatId?: string;
  newChat?: boolean;
  turnstileToken?: string;
  page: { url: string; title: string; referrer: string };
  device: { width: number; touch: boolean; lang: string; tz: string };
  /** Playground only: brain, forced scenario, owner-name override. Honoured in dev mode or for the signed-in owner. */
  dev?: DevOptions;
}

export interface DevOptions {
  brain?: "real" | "scripted";
  scenario?: string;
  ownerName?: string;
  /** CPU test: burn about this much server CPU once per answer. Only acts when the server has CPU_TEST=1. */
  cpuBurnMs?: number;
  /** Cut-off test: the chat's server object restarts partway through the next streamed answer. */
  cutoff?: boolean;
  /** Model test: answer with only this model (an Omnara model name granted to the project), at this effort. */
  model?: string;
  effort?: string;
  /** Owner test mode: the agent may describe its own setup (instructions, tools, files) openly. */
  owner?: boolean;
  /** Owner pass from /admin/api/dev-pass; lets the hosted Playground use these options. */
  pass?: string;
}

export interface SessionResponse {
  visitorId: string;
  visitorKey: string;
  chatId: string;
  token: string;
  wsUrl: string;
  site: PublicSiteConfig;
  aiEnabled: boolean;
  ownerOnline: boolean;
}

export type SessionError = { error: "turnstile_required" | "origin" | "unknown_site" | "rate_limited" | "bad_request" | "off" };

/** Hub -> inbox */
export type HubMsg =
  | { t: "chat"; chat: ChatSummary }
  | { t: "enquiry"; id: string }
  | { t: "settings" }
  | { t: "presence"; online: boolean }
  | { t: "pong" };

/** Inbox -> hub: keepalive, and the owner's activity on that device ("idle" and "locked" mean away now). */
export type HubIn = { t: "ping" } | { t: "activity"; state: "active" | "idle" | "locked" };

export interface ChatSummary {
  id: string;
  site: string;
  visitorId: string;
  status: "open" | "closed";
  mode: ChatMode;
  wantsOwner: boolean;
  visitorOnline: boolean;
  messageCount: number;
  costUsd: number;
  model?: string;
  preview: string;
  page?: string;
  referrer?: string;
  country?: string;
  city?: string;
  region?: string;
  device?: string;
  email?: string;
  name?: string;
  /** The visitor's number on this site, given on their first message. */
  visitorNumber?: number;
  /** How many chats this visitor has had (with messages). */
  visitorChats?: number;
  /** Started from the owner's test pages (Playground, scripts, dev sites). */
  test: boolean;
  archived: boolean;
  unread: number;
  createdAt: number;
  updatedAt: number;
  /** When the owner last wrote in this chat. */
  ownerAt?: number;
}

export interface Enquiry {
  id: string;
  chatId: string;
  site: string;
  name: string;
  email: string;
  message: string;
  status: "new" | "replied" | "closed";
  createdAt: number;
}

export type AnalyticsEvent = "opened" | "first_message" | "enquiry_sent" | "talked_to_owner" | "suggestion_clicked" | "starter_clicked";
