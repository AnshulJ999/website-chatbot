# Website Chatbot

An AI chat widget for your website that answers from your own content, takes messages, and lets you step in live. One script tag on any site; the AI runs on [Omnara](https://omnara.com); the server runs on Cloudflare's free plan.

- **Answers from your site.** Your pages and docs go into a knowledge store the AI searches and reads before answering. It links to real pages and says when it doesn't know.
- **You can take over.** Every chat shows up live in your inbox. Join any chat, reply, and hand it back to the AI. Replies can also go to the visitor's email, and their email replies come back into the chat.
- **Never a dead end.** If the AI fails, a model stalls or a spending limit is hit, the chat turns into a "Get in touch" form. If the server is unreachable, visitors see your email address.
- **Cheap and capped.** A model ladder with automatic fallback and cooldowns, a per-chat limit, a daily budget, and per-visitor limits.
- **Fits your design.** The widget reads your site's own CSS variables, so it follows your themes and light/dark switch. About 19 KB gzipped, inside a Shadow DOM.

## How it works

```
Visitor's browser                Cloudflare Worker (free plan)                 Omnara
widget.js  ── WebSocket ──>  ChatRoom Durable Object (one per chat)  ──>  one agent per chat
                             D1: chats, visitors, messages left, spend      + read-only memory store
Your inbox (/admin) ── WebSocket ──> Hub Durable Object                        (your site's content)
```

| Package | What |
|---|---|
| `packages/widget` | Preact widget (Shadow DOM, one IIFE file) and the Playground dev page |
| `packages/server` | Worker (Hono), `ChatRoom` and `Hub` Durable Objects, D1 migrations |
| `packages/inbox` | React inbox and dashboard served at `/admin` |
| `packages/shared` | Protocol and config types |
| `tools/kb-sync` | Copies a site's content into its Omnara memory store and pushes its config |

## Run it locally

Requires Node 23.6 or newer and an Omnara API key.

```bash
npm install
cp packages/server/.dev.vars.example packages/server/.dev.vars   # fill in the Omnara values
npm run db:migrate:local -w @website-chatbot/server
npm run dev            # server on http://127.0.0.1:8790
npm run dev:widget     # Playground on http://127.0.0.1:5290
npm run dev:inbox      # inbox on http://127.0.0.1:5291/admin/
```

The Playground starts with a built-in demo site and a **scripted brain** (free, no Omnara calls). Its Design menu switches site themes, forces every widget state, and simulates failures; set Brain to Real to use Omnara.

## Add a site

Create a `chatbot/` folder in the site's repo:

- `chatbot.config.json`: the site's settings (name, wording, starter prompts, theme map, allowed origins, memory store name, tools) and the content sources to sync.
- `instruction.md`: what the AI should know about the site and where things are in its knowledge base.
- `knowledge/`: optional extra notes for the AI.

Then:

```bash
node tools/kb-sync/sync.ts ../my-site/chatbot/chatbot.config.json --env packages/server/.dev.vars --create-store
```

Embed the widget:

```html
<script src="https://chat.example.com/widget/widget.js" data-site="my-site" defer></script>
```

## Deploy

1. `wrangler d1 create website-chatbot`, put its id in `wrangler.jsonc`, then `npm run db:migrate:remote -w @website-chatbot/server`.
2. Set the `vars` in `wrangler.jsonc` and the secrets: `OMNARA_API_KEY`, `TOKEN_SECRET`, `API_TOKEN`, and optionally `RESEND_API_KEY`, `NTFY_URL`, `TURNSTILE_SECRET`, `GITHUB_TOKEN`.
3. Protect `/admin` with a Cloudflare Access application and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
4. `npm run deploy`, then add a custom domain to the Worker.
5. Optional: route a reply subdomain's email to the Worker with Email Routing and set `REPLY_DOMAIN`.

## Settings

Everything that costs money or decides behaviour is a setting in the inbox: the model ladder, per-chat and daily limits and what happens when they're reached, per-visitor limits, timeouts, cooldowns, streaming, and alerts.
