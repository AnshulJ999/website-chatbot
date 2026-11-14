# Website Chatbot

An AI chat widget for your website that answers from your own pages, hands visitors to you when they need a person, and never leaves them at a dead end. One script tag on any site. The server runs on Cloudflare's free plan; the AI runs on [Omnara](https://omnara.com) agents.

<!-- Screenshots and a short clip go here: docs/images/widget.png, docs/images/inbox.png, docs/images/chat.gif -->

## Live demos

- [kopialens.com](https://kopialens.com): product help for a backup app, answering from 50+ docs pages
- [anshuljain.net](https://www.anshuljain.net): a portfolio assistant that answers questions about the owner's work

## What it does

**For visitors**

- Answers from your site's own pages and docs, with links to the real pages. When it doesn't know, it says so.
- Starter questions per page, suggested follow-ups after each answer, and live progress ("Searching the knowledge base", "Reading Pricing").
- Chats are kept: reload the page or come back later and the conversation is still there. Earlier chats are one tap away.
- Resizable, with a larger side-sheet view; works on phones.
- "Talk to a person" at any time. If you're away, a short form takes their email instead.

**For you**

- An inbox (`/admin`) with every chat live: join any chat, reply, and hand it back to the AI.
- Replies can also go by email, and the visitor's email replies come back into the chat.
- Your status: Auto (online while you're using your computer, using the browser's idle detection), Available or Do not disturb. Desktop notifications when someone asks for you.
- Alerts to your phone through [ntfy](https://ntfy.sh), and a "welcome back" or "you have a reply" note for returning visitors.
- Stats: chats, answer times, slow answers, model fallbacks, failures, ratings and cost.

**Reliability**

- A model ladder: if the main model goes silent (15 s) or takes too long (30 s), the next one answers. Visitors never wait more than 45 s. Words already shown are kept.
- If every model fails or a spending limit is reached, the chat becomes a "Get in touch" form. If the server is unreachable, visitors see your contact options.
- Answers interrupted by the platform are recovered and finished automatically.

**Costs under control**

- A per-chat limit, a daily budget, per-visitor message limits and a kill switch, all editable in the inbox.
- Every number that affects cost or behaviour is a setting, not a constant.

## How it works

```
Visitor's browser               Cloudflare Worker (free plan)                    Omnara
widget.js  ── WebSocket ──>  ChatRoom Durable Object (one per chat)  ──>  one agent per chat
                             D1: chats, visitors, messages left,           + read-only memory store
                                 answer times, spend, incidents              (your site's pages)
Your inbox (/admin) ─ WebSocket ─> Hub Durable Object (live updates, your status)
```

- **Widget:** Preact inside a Shadow DOM, about 20 KB gzipped. It reads your site's CSS variables, so it follows your themes and light/dark mode without its styles leaking into your page.
- **One Durable Object per chat:** holds the conversation, streams the answer, runs the model ladder and the time limits, and survives restarts.
- **Omnara agent per chat:** the AI keeps the conversation's context and looks things up in a read-only memory store holding your pages as Markdown, each tagged with its public URL. It reads before it answers instead of guessing.
- **kb-sync:** copies your site into that store: Markdown docs straight from your repo, plus your live pages through the sitemap.

| Package | What |
|---|---|
| `packages/widget` | The widget and the Playground test page |
| `packages/server` | Worker (Hono), `ChatRoom` and `Hub` Durable Objects, D1 migrations |
| `packages/inbox` | React inbox and stats, served at `/admin` |
| `packages/shared` | Protocol and config types |
| `tools/kb-sync` | Syncs a site's content into its memory store and pushes its config |

## What it costs

- **AI:** with DeepSeek V4.1 Flash, a typical answer costs a fraction of a cent (about $0.002 to $0.007, depending on how much it reads). The ladder, effort per model and every limit are yours to set.
- **Cloudflare:** the free plan covers it: Workers (100k requests a day per account), Durable Objects and D1.
- **Email (optional):** [Resend](https://resend.com)'s free plan (100 emails a day).
- **Alerts (optional):** ntfy, free or self-hosted.

## Quick start (local)

Requires Node 22 or newer. The built-in **scripted brain** needs no API key, so you can try everything for free.

```bash
npm install
cp packages/server/.dev.vars.example packages/server/.dev.vars
cp packages/server/wrangler.example.jsonc packages/server/wrangler.jsonc
npm run db:migrate:local -w @website-chatbot/server
npm run dev            # server on http://127.0.0.1:8790
npm run dev:widget     # Playground on http://127.0.0.1:5290
npm run dev:inbox      # inbox on http://127.0.0.1:5291/admin/
```

Open the Playground, keep Brain on **Scripted**, and chat. Add your Omnara values to `.dev.vars` and switch Brain to **Real** to use the AI.

## Deploy your own

1. **Omnara:** create a project, grant it the models you want (for example DeepSeek V4.1 Flash and GPT-6 Luna) and create an organisation API key.
2. **Cloudflare:**
   - `npx wrangler d1 create website-chatbot`, then put its id and your values in `packages/server/wrangler.jsonc` (copied from `wrangler.example.jsonc`).
   - `npm run db:migrate:remote -w @website-chatbot/server`
   - Protect `/admin` and `/playground` with a Cloudflare Access application; set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
   - Optional: a Turnstile widget for bot protection.
3. **Secrets:** put them in `packages/server/.deploy.vars` (git-ignored): `OMNARA_API_KEY`, `TOKEN_SECRET`, `API_TOKEN`, and optionally `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TURNSTILE_SECRET`, `NTFY_URL` / `NTFY_TOKEN` (or per-site names), `GITHUB_TOKEN`.
4. **Deploy:** `npm run build`, then `npx wrangler deploy --secrets-file .deploy.vars` in `packages/server`, with a custom domain on the Worker.
5. **Add your site** (below), then embed the widget.

**Reply by email (optional).** Visitors' replies to the chatbot's emails go to `chat+<tag>@<replyDomain>` and land back in the chat. Use a subdomain with no other mail and pick one way in:

- **Resend Receiving:** enable receiving on the domain, add its MX record, and point an `email.received` webhook at `https://<server>/api/email/resend` with its signing secret as `RESEND_WEBHOOK_SECRET`.
- **Cloudflare Email Routing:** add the subdomain under the zone's Email Routing, turn on subaddressing, and route `chat@<replyDomain>` to this Worker.

## Add a site

Create a `chatbot/` folder in your site's repo:

- `chatbot.config.json`: the site's settings (name, wording, starter prompts per page, theme map, allowed origins, memory store, tools, alerts, email) and the content sources to sync (a sitemap, Markdown folders, single files or URLs).
- `instruction.md`: what the AI should know about this site: a short primer, where things are in its knowledge, how to handle common questions, and your contact options. It's sent with every chat, after the shared rules in `packages/server/src/brain/base-rules.md`.
- `knowledge/`: optional curated notes for the AI.

Sync it (creates the memory store the first time and pushes the config to your server):

```bash
node tools/kb-sync/sync.ts ../my-site/chatbot/chatbot.config.json --env packages/server/.dev.vars --create-store
```

## Embed and theme

```html
<script src="https://chatbot.example.com/widget/widget.js" data-site="my-site" defer></script>
```

- **Theme:** map the widget's colours, radius and font to your site's CSS variables in the site config (`theme`), for example `"accent": "var(--color-primary)"`. Light/dark and theme switches follow automatically.
- **Layout:** launcher style, corner, panel size, suggestion style and where "Talk to a person" sits are per-site settings (`ui`).
- **From your own code:** `window.WebsiteChatbot.open()`, `.close()` and `.newChat()`.

## Settings

The inbox's Settings page holds everything that costs money or changes behaviour:

- **Models:** the model ladder, with effort per model
- **Limits:** per chat, per day, per visitor
- **Time limits:** silence, per model, total, and when "Still working on it" shows
- **Cooldowns** for failing models
- **Your status:** idle time before you show as away
- **Delivery:** streaming and alerts

## The Playground

A test page for the real widget (`/playground`, owner only when deployed). Pick the site, page, theme and phone or desktop size. Choose the scripted or real brain, a single model and effort to compare them, or a failure scenario (stalls, errors, a cut-off mid-answer). It can also show every widget state for review.

## Privacy

The chatbot saves each chat so the site owner can read and reply. With it, it saves:

- the page the visitor was on, and where they came from
- their approximate city and country, from Cloudflare
- their device type and browser language
- their name and email, only if they enter them

IP addresses are used only for the bot check and aren't stored. A random visitor ID in the browser keeps their chats together. Add a line about the chat to your privacy page.

## Limitations and roadmap

- Built for one owner per deployment, with several sites.
- The AI answers from what's synced; re-run kb-sync after big site changes.
- Not yet built: a fallback for when Omnara itself is down, and a helper that detects you're at your computer without the inbox open.

## Licence

To be decided.
