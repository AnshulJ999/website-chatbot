import type { ChatRoom } from "./chatroom";
import type { Hub } from "./hub";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  HUB: DurableObjectNamespace<Hub>;

  OMNARA_API: string;
  OMNARA_ORG_ID: string;
  OMNARA_PROJECT_ID: string;
  /** Base URL of this server, e.g. https://chatbot.anshuljain.net */
  PUBLIC_URL: string;
  /** Cloudflare Access team domain (e.g. "myteam.cloudflareaccess.com") and the app's AUD tag. */
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Domain whose inbound mail Email Routing hands to this Worker, e.g. reply.anshuljain.net */
  REPLY_DOMAIN: string;
  /** "1" when OMNARA_API_KEY is a project API key: visitor messages then carry an Omnara actor. */
  OMNARA_ACTOR?: string;
  /** "1" locally: skips Access and Turnstile, allows the scripted brain. */
  DEV_MODE: string;

  // Secrets
  OMNARA_API_KEY: string;
  TOKEN_SECRET: string;
  /** Bearer token for machine access: kb-sync pushes and the Sitrep summary. */
  API_TOKEN: string;
  RESEND_API_KEY?: string;
  NTFY_URL?: string;
  NTFY_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  GITHUB_TOKEN?: string;
}

export const isDev = (env: Env) => env.DEV_MODE === "1";
