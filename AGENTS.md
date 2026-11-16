# Notes for AI agents

The README explains what this is, how to run it, deploy it and add a site; read it first. This file adds what helps when you work in the code or deploy it for someone.

## Code map

npm workspaces, TypeScript throughout.

**`packages/server`** - Cloudflare Worker (Hono) with two Durable Objects and a D1 database.
- `src/index.ts`: every HTTP route (public widget API, owner `/admin/api/*` behind Cloudflare Access, machine API for kb-sync), origin checks, `sanitizeSettings`, the daily job.
- `src/chatroom.ts`: one chat. The turn loop, model ladder and time limits, owner takeover and hand-back, contact forms, email in and out, alerts, recovery of cut-off answers.
- `src/hub.ts`: live updates for the inbox and the owner's online status.
- `src/brain/`: `omnara-brain.ts` (the real AI via Omnara agents), `scripted-brain.ts` (canned answers and failure scenarios for testing), `agent-config.ts` (builds each site's prompt), `base-rules.md` (the shared bot rules every site gets).
- `src/omnara.ts` (Omnara API client), `src/db.ts` (D1 queries), `src/notify.ts` (ntfy alerts, Resend email), `src/auth.ts` (signed session tokens, Access check), `src/tools.ts` (the AI's custom tools), `src/demo-site.ts` (the built-in Demo site).
- `migrations/`: D1 schema, applied in order. `test/`: Vitest against the real Worker runtime.

**`packages/widget`** - the visitor's chat, Preact in a Shadow DOM.
- `src/main.tsx` (boot, site config, greeting), `src/App.tsx` (all screens), `src/client.ts` (WebSocket, reconnects, resends), `src/store.ts` (state), `src/greeting.ts`, `src/styles.css`.
- `src/dev.ts` and `src/design-rows.ts`: the Playground's look options, built only into the Playground and `widget-preview.js`, never into visitors' `widget.js`.
- `playground/`: the test page.

**`packages/inbox`** - the owner's React inbox at `/admin`: `Chats.tsx`, `Enquiries.tsx` (messages left), `Stats.tsx`, `Settings.tsx`.

**`packages/shared`** - types and defaults used by all three: `config.ts` (site config, `DEFAULT_UI`, `DEFAULT_SETTINGS`), `protocol.ts` (WebSocket messages), `markdown.ts` (the safe Markdown renderer).

**`tools/kb-sync/sync.ts`** - copies a site's pages into its Omnara memory store and pushes its config to the server.

## Working in the code

- `npm run typecheck` checks every workspace; `npm test -w @website-chatbot/server` runs the server tests (about 40 s).
- A new setting goes into `DEFAULT_SETTINGS` (`shared/src/config.ts`), into `sanitizeSettings` (`server/src/index.ts`, or saving it is silently dropped), and into `inbox/src/Settings.tsx`.
- A new D1 table or column is a new numbered file in `migrations/`; apply it remotely before deploying code that uses it.
- Visible text follows the existing tone: plain, short, no jargon for visitors.

## Deploying for someone

- Ask the owner for what only they can give: Cloudflare and Omnara access, the domain for the server, the site's address and its repo, and the owner's email. Everything else follows from the README.
- Account sign-ups, API keys and DNS changes are theirs to do or approve; walk them through it rather than guessing values.
- Keep `DEV_MODE` off on any public deployment: it skips the Access and bot checks.
- Secrets live in git-ignored files (`.dev.vars`, `.deploy.vars`, `tools/kb-sync/.sync.vars`); never commit them.
- A site's `origins` must list every address the site is served from, or the widget is refused there. kb-sync warns when it's empty.
- Check it works: `/api/health`, then one real question in the widget on the site, then the inbox behind Access.

## Omnara notes

The [Omnara docs](https://docs.omnara.com) and [API reference](https://docs.omnara.com/api-reference) are the source of truth; the platform moves quickly, so check them when something behaves unexpectedly. Things that tripped us up:

- The server needs an organisation API key, and every model in the ladder must be granted to the project, or answers fail with that model.
- A ladder row's `provider` is the name of a provider config in the Omnara organisation (the inbox fills in `omnara-openrouter` for new rows; check the names in your organisation). Free models need a provider config of their own, with your own OpenRouter key.
- Memory store files are addressed by the store's ID, not its name, and deleting or replacing a file needs its current digest (`expected_digest`, the SHA-256 of its content). kb-sync handles both.
