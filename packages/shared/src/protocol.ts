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
  | { t: "pong" };

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
  device?: string;
  email?: string;
  name?: string;
  unread: number;
  createdAt: number;
  updatedAt: number;
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
