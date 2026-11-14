#!/usr/bin/env node
// kb-sync: copies a site's content into its Omnara memory store (one file per page, each starting
// with its real URL) and pushes the site's chatbot config, with a map of its pages, to the chat server.
//
//   node sync.ts <site>/chatbot/chatbot.config.json [--live] [--env <file>] [--dry-run [--show <store path>]] [--prune] [--force] [--alert] [--create-store] [--no-push]
//
// --live: the deployed server. Reads .sync.vars beside this file, removes pages that left the site (guarded),
// checks the store afterwards and asks the live bot one question. Ends with "SYNC OK" or "SYNC FAILED" (exit 1).
// Checks run before anything is written; --force overrides them. --alert sends a failure to the system ntfy topic.
//
// Credentials come from the environment, --env, or .sync.vars (--live): OMNARA_API_KEY, OMNARA_ORG_ID,
// OMNARA_PROJECT_ID, CHATBOT_SERVER (or PUBLIC_URL), API_TOKEN; optional CHATBOT_SERVER_IP (reach the server at
// this address when local DNS points its name elsewhere), NTFY_URL and NTFY_TOKEN (for --alert).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, posix, relative, resolve } from "node:path";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Agent, WebSocket, fetch as uFetch } from "undici";

interface Source {
  /**
   * "dir": every .md/.mdx/.txt file under `dir`; "file": one file; "url": fetch one text page (e.g. /llms.txt);
   * "sitemap": every HTML page in the site's sitemap, converted to Markdown.
   */
  type: "dir" | "file" | "url" | "sitemap";
  dir?: string;
  file?: string;
  url?: string;
  /** Page URL template for dir sources: {slug} is the file path without extension. */
  pageUrl?: string;
  /** File name (without extension) that maps to the bare pageUrl, e.g. "README" for /docs. */
  index?: string;
  /** Where the files go inside the store. */
  storePath: string;
  /** sitemap: the public sitemap URL; its page addresses are what the bot links to. */
  sitemap?: string;
  /** sitemap: fetch pages (and the sitemap) from this origin instead, e.g. a local dev server; links keep the public address. */
  readFrom?: string;
  /** sitemap: path prefixes already covered by file sources; used only when knowledgeSource is "both". "*" ends a prefix. */
  exclude?: string[];
  /** sitemap: CSS selector of the page's main content (default "main", then "body"). */
  main?: string;
}

interface SyncConfig {
  /** SiteConfig without `instruction` (read from instructionFile). */
  site: Record<string, unknown> & { key: string; storeName: string };
  instructionFile: string;
  /** Which sources count: "files" (repo files only), "live" (the sitemap only), "both" (default). */
  knowledgeSource?: "files" | "live" | "both";
  sources: Source[];
  /** Curated knowledge folder; files may start with their own "URL:" line. */
  curatedDir?: string;
}

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const configPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--env" && args[i - 1] !== "--show");
if (!configPath) {
  console.error("Usage: node sync.ts <chatbot.config.json> [--env <file>] [--dry-run] [--prune] [--create-store] [--no-push]");
  process.exit(2);
}

const live = flag("--live");
const force = flag("--force");
const env: Record<string, string | undefined> = { ...process.env };
const liveVars = join(import.meta.dirname, ".sync.vars");
const envFile = opt("--env") ?? (live ? liveVars : undefined);
if (live && !opt("--env") && !existsSync(liveVars)) {
  console.error(`--live needs ${liveVars} (copy .sync.vars.example)`);
  process.exit(2);
}
if (envFile) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) env[m[1]!] ??= m[2]!.replace(/^["']|["']$/g, "");
  }
}

/** Requests to the chat server; CHATBOT_SERVER_IP pins its address when local DNS sends the name elsewhere. */
const pinned = env.CHATBOT_SERVER_IP
  ? new Agent({ connect: { lookup: (_h, o, cb) => (o?.all ? cb(null, [{ address: env.CHATBOT_SERVER_IP!, family: 4 }]) : cb(null, env.CHATBOT_SERVER_IP!, 4)) } })
  : undefined;
const serverFetch = (url: string, init: Parameters<typeof uFetch>[1] = {}) => uFetch(url, { ...init, ...(pinned ? { dispatcher: pinned } : {}) });
const need = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`Missing ${k} (set it in the environment or the --env file)`);
  return v;
};

const dryRun = flag("--dry-run");
const cfgFile = resolve(configPath);
const base = dirname(cfgFile);
const cfg = JSON.parse(readFileSync(cfgFile, "utf8")) as SyncConfig;

// ---------- collect files ----------

interface KbFile {
  path: string;
  body: string;
}

const TEXT = new Set([".md", ".mdx", ".txt"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (TEXT.has(extname(name).toLowerCase())) out.push(full);
  }
  return out.sort();
}

/** Drops YAML front matter but keeps its title and description as plain lines. */
function clean(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return text.trim();
  const fm = m[1]!;
  const title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1];
  const description = /^description:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1];
  const head = [title ? `# ${title}` : "", description ?? ""].filter(Boolean).join("\n\n");
  return `${head}\n\n${text.slice(m[0].length).trim()}`.trim();
}

const withUrl = (url: string, body: string) => `URL: ${url}\n\n${body}\n`;

/** llms.txt-style files link the site's pages as ".md" copies; visitors need the normal pages. */
function htmlPageLinks(body: string, origin: string): string {
  const site = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(`(${site}(?:/[^)\\s#]*)?)\\.md(?=[)#\\s]|$)`, "gm"), "$1");
}

/**
 * Docs in a repo link to each other by file name ("indexing.md#first-index"); the agent would copy those, so they
 * become the real page addresses. Images are dropped: the agent can't show them.
 */
function linkPages(body: string, s: Source, slug: string, url: string): string {
  const folder = slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/") + 1) : "";
  const pageFor = (target: string) => (s.index && target === s.index ? s.pageUrl!.replace(/\/?\{slug\}$/, "") : s.pageUrl!.replace("{slug}", target));
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)[ \t]*\n?/g, "")
    .replace(/\]\((?!https?:|mailto:)([^)#\s]+?)\.mdx?(#[^)\s]*)?\)/g, (_m, file: string, hash = "") => `](${pageFor(posix.normalize(folder + file))}${hash})`)
    .replace(/\]\((#[^)\s]+)\)/g, (_m, hash: string) => `](${url}${hash})`);
}

// ---------- live pages (sitemap -> Markdown) ----------

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
turndown.use(gfm);


function pathMatches(path: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path === p || path === p.replace(/\/$/, "")));
}

/** One page's main content as Markdown, with a short header the agent can cite. */
export function pageToMarkdown(html: string, publicUrl: string, readOrigin: string, selector = "main"): string {
  const { document } = parseHTML(html);
  const title = (document.querySelector("title")?.textContent ?? "").trim();
  const description = document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "";
  const root = document.querySelector(selector) ?? document.querySelector("main") ?? document.body;
  const drop = "nav, footer, script, style, noscript, iframe, svg, canvas, video, audio, img, picture, form, button, dialog, [aria-hidden='true'], [hidden], .sr-only, [data-dev-ui]";
  for (const el of root.querySelectorAll(drop)) el.remove();
  const publicOrigin = new URL(publicUrl).origin;
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    try {
      const abs = new URL(href, publicUrl.replace(publicOrigin, readOrigin));
      if (abs.origin === readOrigin) abs.href = abs.href.replace(readOrigin, publicOrigin);
      a.setAttribute("href", abs.href);
    } catch {
      // leave odd links as they are
    }
  }
  let md = turndown
    .turndown(root.innerHTML)
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!/^# /m.test(md) && title) md = `# ${title}\n\n${md}`;
  const head = [`Title: ${title}`, description ? `Description: ${description}` : ""].filter(Boolean).join("\n");
  return `${head}\n\n${md}`;
}

async function sitemapUrls(sitemap: string, readOrigin: string, publicOrigin: string): Promise<string[]> {
  const res = await fetch(sitemap.replace(publicOrigin, readOrigin));
  if (!res.ok) throw new Error(`${sitemap}: HTTP ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!);
  // A sitemap index lists more sitemaps.
  if (/<sitemapindex/.test(xml)) return (await Promise.all(locs.map((l) => sitemapUrls(l, readOrigin, publicOrigin)))).flat();
  return locs;
}

/** Store paths of sitemap pages that couldn't be fetched this run: their old copies are kept. */
const skippedPaths: string[] = [];
let sitemapTotal = 0;

async function collectSitemap(s: Source, applyExcludes: boolean): Promise<KbFile[]> {
  const finalSitemap = (await fetch(s.sitemap!, { method: "HEAD", redirect: "follow" }).catch(() => null))?.url || s.sitemap!;
  const publicOrigin = new URL(finalSitemap).origin;
  const readOrigin = s.readFrom ? new URL(s.readFrom).origin : publicOrigin;
  const urls = await sitemapUrls(finalSitemap, readOrigin, publicOrigin);
  const out: KbFile[] = [];
  const skipped: string[] = [];
  const queue = urls.filter((u) => {
    const path = new URL(u).pathname;
    if (applyExcludes && s.exclude && pathMatches(path, s.exclude)) return false;
    return true;
  });
  sitemapTotal += queue.length;
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const path = new URL(u).pathname.replace(/\/$/, "") || "/";
      const res = await fetch(u.replace(publicOrigin, readOrigin)).catch(() => null);
      const name = path === "/" ? "home" : path.slice(1);
      if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) {
        skipped.push(`${path} (${res ? `${res.status} ${res.headers.get("content-type") ?? ""}` : "unreachable"})`);
        skippedPaths.push(`${s.storePath}/${name}.md`);
        continue;
      }
      const md = pageToMarkdown(await res.text(), u, readOrigin, s.main);
      out.push({ path: `${s.storePath}/${name}.md`, body: withUrl(u, md) });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (skipped.length) console.log(`  skipped ${skipped.length} non-HTML or failed pages: ${skipped.join(", ")}`);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function collect(): Promise<KbFile[]> {
  const files: KbFile[] = [];
  const mode = cfg.knowledgeSource ?? "both";
  for (const s of cfg.sources) {
    const live = s.type === "sitemap";
    if ((mode === "files" && live) || (mode === "live" && !live)) continue;
    if (s.type === "sitemap") {
      files.push(...(await collectSitemap(s, mode === "both")));
    } else if (s.type === "dir") {
      const dir = resolve(base, s.dir!);
      for (const full of walk(dir)) {
        const rel = relative(dir, full).replace(/\\/g, "/");
        const slug = rel.replace(/\.(md|mdx|txt)$/i, "");
        const url = s.index && slug === s.index ? s.pageUrl!.replace(/\/?\{slug\}$/, "") : s.pageUrl!.replace("{slug}", slug);
        files.push({ path: `${s.storePath}/${slug}.md`, body: withUrl(url, linkPages(clean(readFileSync(full, "utf8")), s, slug, url)) });
      }
    } else if (s.type === "file") {
      files.push({ path: s.storePath, body: withUrl(s.pageUrl!, clean(readFileSync(resolve(base, s.file!), "utf8"))) });
    } else {
      const res = await fetch(s.url!);
      if (!res.ok) throw new Error(`${s.url}: HTTP ${res.status}`);
      files.push({ path: s.storePath, body: withUrl(s.pageUrl!, htmlPageLinks((await res.text()).trim(), new URL(s.pageUrl!).origin)) });
    }
  }
  if (cfg.curatedDir) {
    const dir = resolve(base, cfg.curatedDir);
    for (const full of walk(dir)) {
      if (basename(full).toLowerCase() === "readme.md") continue;
      const rel = relative(dir, full).replace(/\\/g, "/");
      const text = readFileSync(full, "utf8").trim();
      files.push({ path: `curated/${rel}`, body: /^URL:/.test(text) ? `${text}\n` : `URL: none (background facts, no page to link)\n\n${text}\n` });
    }
  }
  return files;
}

// ---------- Omnara ----------

const OMNARA = env.OMNARA_API ?? "https://api.omnara.com/v1";

async function omnara<T>(method: string, path: string, body?: BodyInit, json = true): Promise<{ status: number; data: T }> {
  const res = await fetch(`${OMNARA}/orgs/${need("OMNARA_ORG_ID")}/projects/${need("OMNARA_PROJECT_ID")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${need("OMNARA_API_KEY")}`,
      "User-Agent": "website-chatbot-kb-sync/0.1",
      ...(body ? { "Content-Type": json ? "application/json" : "application/octet-stream" } : {}),
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

async function storeId(name: string): Promise<string | null> {
  let cursor: string | null = null;
  do {
    const r: { status: number; data: { data: { id: string; name: string }[]; next_cursor: string | null } } = await omnara("GET", `/memory-stores?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    if (r.status !== 200) throw new Error(`listing memory stores failed: HTTP ${r.status}`);
    const hit = r.data.data.find((s) => s.name === name);
    if (hit) return hit.id;
    cursor = r.data.next_cursor;
  } while (cursor);
  return null;
}

const digest = (s: string) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

/** Writes one file. Omnara accepts identical content without a digest, so "written" covers new and unchanged files. */
async function put(store: string, f: KbFile): Promise<"written" | "updated" | "same"> {
  const q = `/memory-stores/${store}/file?path=${encodeURIComponent(f.path)}`;
  let r = await omnara<{ code?: string; current_digest?: string; error?: string }>("PUT", q, f.body, false);
  if (r.status === 200) return "written";
  if (r.status === 409 && r.data.current_digest) {
    if (r.data.current_digest === digest(f.body)) return "same";
    r = await omnara("PUT", `${q}&expected_digest=${encodeURIComponent(r.data.current_digest)}`, f.body, false);
    if (r.status === 200) return "updated";
  }
  throw new Error(`${f.path}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
}

async function listAll(store: string, path = ""): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const r: { status: number; data: { data: { path: string; type: string }[]; next_cursor: string | null } } = await omnara(
      "GET",
      `/memory-stores/${store}/files?limit=100${path ? `&path=${encodeURIComponent(path)}` : ""}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    if (r.status !== 200) throw new Error(`listing ${path || "/"} failed: HTTP ${r.status}`);
    for (const e of r.data.data) {
      if (e.type === "directory") out.push(...(await listAll(store, e.path)));
      else out.push(e.path);
    }
    cursor = r.data.next_cursor;
  } while (cursor);
  return out;
}

// ---------- site map ----------

/** One line per file: title, page address, store path. Goes into every chat's prompt, so it holds nothing that drifts. */
function siteMap(files: KbFile[]): string {
  return files
    .map((f) => {
      const url = /^URL: (.+)$/m.exec(f.body)?.[1]?.trim() ?? "";
      const title = (/^# (.+)$/m.exec(f.body)?.[1] ?? /^Title: (.+)$/m.exec(f.body)?.[1] ?? f.path).replace(/\*\*/g, "").trim();
      const page = /^https?:/.test(url) ? url : "no page";
      return `- ${title} - ${page} - ${f.path.replace(/^\/+/, "")}`;
    })
    .sort((a, b) => a.localeCompare(b))
    .join("\n");
}

// ---------- safety checks ----------

/** Reasons not to touch the store: empty or error-looking pages, many failed pages, far fewer pages than before. */
function preflight(files: KbFile[], existing: number): string[] {
  const problems: string[] = [];
  if (!files.length) problems.push("no files were collected");
  const thin = files.filter((f) => f.body.replace(/^URL: .*$/m, "").trim().length < 120).map((f) => f.path);
  if (thin.length) problems.push(`${thin.length} near-empty file(s): ${thin.slice(0, 5).join(", ")}`);
  const errorish = files.filter((f) => /^(Title: |# )(.*\b(404|not found|page not found|server error|bad gateway)\b.*)$/im.test(f.body.slice(0, 400))).map((f) => f.path);
  if (errorish.length) problems.push(`${errorish.length} page(s) look like error pages: ${errorish.slice(0, 5).join(", ")}`);
  if (sitemapTotal && skippedPaths.length / sitemapTotal > 0.2) problems.push(`${skippedPaths.length} of ${sitemapTotal} live pages couldn't be fetched`);
  if (existing > 10 && files.length < existing * 0.7) problems.push(`only ${files.length} files now, the store has ${existing}`);
  return problems;
}

/** Tells the system ntfy topic that a sync failed (--alert). */
async function alertFailure(problems: string[]): Promise<void> {
  if (!flag("--alert") || !env.NTFY_URL) return;
  const name = String(cfg.site.name ?? cfg.site.key);
  await fetch(env.NTFY_URL, {
    method: "POST",
    headers: { Title: `Chatbot - Knowledge sync failed - ${name}`, Priority: "4", Tags: "warning", ...(env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}) },
    body: problems.map((p) => `⚠️ ${p}`).join("\n").slice(0, 3000),
  }).catch(() => undefined);
}

/** Asks the live bot one question as a test visitor (owner pass: no Turnstile, no alerts); returns a problem or null. */
async function askLiveBot(server: string, question: string): Promise<string | null> {
  const origin = (cfg.site.origins as string[] | undefined)?.find((o) => o.startsWith("https://dev.")) ?? (cfg.site.origins as string[] | undefined)?.[0];
  if (!origin) return "no site origin to test from";
  const passRes = await serverFetch(`${server}/api/dev-pass`, { headers: { Authorization: `Bearer ${need("API_TOKEN")}` } });
  const { pass } = (await passRes.json()) as { pass: string };
  const sRes = await serverFetch(`${server}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ site: cfg.site.key, newChat: true, page: { url: `${origin}/`, title: "Home", referrer: "" }, device: { width: 1280, touch: false, lang: "en", tz: "UTC" }, dev: { brain: "real", pass } }),
  });
  const s = (await sRes.json()) as { token?: string; wsUrl?: string };
  if (!s.token) return `test session failed (HTTP ${sRes.status})`;
  const wsBase = server.replace(/^http/, "ws");
  return new Promise((done) => {
    const ws = new WebSocket(`${wsBase}${s.wsUrl}?token=${encodeURIComponent(s.token!)}&page=/`, { headers: { Origin: origin }, ...(pinned ? { dispatcher: pinned } : {}) });
    const timer = setTimeout(() => finish("the live bot didn't answer within 70 s"), 70_000);
    const finish = (problem: string | null) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      done(problem);
    };
    ws.onopen = () => ws.send(JSON.stringify({ t: "send", id: `m${Date.now()}`, text: question }));
    ws.onerror = () => finish("couldn't connect to the live bot");
    ws.onmessage = (e) => {
      const d = String(e.data);
      if (d.startsWith("D") || d.startsWith("B")) return;
      const m = JSON.parse(d) as { t: string; status?: { mode?: string }; message?: { role: string; text: string } };
      if (m.t === "status" && m.status?.mode === "form") finish("the live bot gave no answer (contact form shown)");
      if (m.t === "message" && m.message?.role === "ai") finish(m.message.text.trim().length > 20 ? null : "the live bot's answer was empty");
    };
  });
}

// ---------- main ----------

async function main(): Promise<void> {
  const files = await collect();
  const problems: string[] = [];
  const warnings: string[] = [];
  console.log(`${files.length} files for store "${cfg.site.storeName}"`);
  if (skippedPaths.length) warnings.push(`${skippedPaths.length} live page(s) couldn't be fetched; their old copies were kept`);
  if (dryRun) {
    for (const f of files) console.log(`  ${f.path}  (${f.body.length} chars)  ${f.body.split("\n", 1)[0]}`);
    const show = opt("--show");
    const hit = show && files.find((f) => f.path === show || f.path === `${show}.md` || f.path.endsWith(`/${show}`) || f.path.endsWith(`/${show}.md`));
    if (hit) console.log(`\n----- ${hit.path} -----\n${hit.body}`);
    if (show === "sitemap") console.log(`\n----- site map -----\n${siteMap(files)}`);
    const pre = preflight(files, 0);
    if (pre.length) console.log(`\nchecks would stop a real sync:\n  ${pre.join("\n  ")}`);
  } else {
    let store = await storeId(cfg.site.storeName);
    if (!store) {
      if (!flag("--create-store")) throw new Error(`No memory store named "${cfg.site.storeName}". Run again with --create-store to create it.`);
      const r = await omnara<{ id?: string; memory_store?: { id: string } }>("POST", "/memory-stores", JSON.stringify({ name: cfg.site.storeName, agent_access: "read" }));
      store = r.data.memory_store?.id ?? r.data.id ?? null;
      if (!store) throw new Error(`creating the store failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      console.log(`created store ${store}`);
    }
    const before = (await listAll(store)).map((p) => p.replace(/^\/+/, ""));
    const pre = preflight(files, before.length);
    if (pre.length && !force) {
      console.log(`\nSYNC FAILED before changing the store (run again with --force to override):\n  ${pre.join("\n  ")}`);
      await alertFailure(pre);
      process.exit(1);
    }
    warnings.push(...pre.map((p) => `forced past: ${p}`));

    const counts = { written: 0, updated: 0, same: 0 };
    for (const [i, f] of files.entries()) {
      counts[await put(store, f)]++;
      if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${files.length}`);
    }
    console.log(`store: ${counts.written + counts.same} new or unchanged, ${counts.updated} changed`);

    // Removal comes only after every upload succeeded (put throws otherwise), never for pages skipped this run.
    const keep = new Set([...files.map((f) => f.path.replace(/^\/+/, "")), ...skippedPaths]);
    const stale = before.filter((p) => !keep.has(p));
    const pruneLimit = Math.max(5, Math.round(files.length * 0.1));
    if (stale.length) {
      if ((flag("--prune") || live) && stale.length > pruneLimit && !force) {
        warnings.push(`${stale.length} files are no longer on the site; not removed (more than ${pruneLimit}; check them, then run with --force): ${stale.slice(0, 8).join(", ")}`);
      } else if (flag("--prune") || live) {
        for (const p of stale) {
          const r = await omnara("DELETE", `/memory-stores/${store}/file?path=${encodeURIComponent(p)}`);
          if (r.status === 409) {
            const cur = (r.data as { current_digest?: string }).current_digest;
            if (cur) await omnara("DELETE", `/memory-stores/${store}/file?path=${encodeURIComponent(p)}&expected_digest=${encodeURIComponent(cur)}`);
          }
        }
        console.log(`removed ${stale.length} files no longer in the site`);
      } else {
        console.log(`${stale.length} files in the store are no longer in the site (run with --prune to remove):`);
        for (const p of stale) console.log(`  ${p}`);
      }
    }

    // Afterwards: every file is in the store, and a few read back exactly as written.
    const after = new Set((await listAll(store)).map((p) => p.replace(/^\/+/, "")));
    const missing = files.filter((f) => !after.has(f.path.replace(/^\/+/, "")));
    if (missing.length) problems.push(`${missing.length} file(s) missing from the store after the upload: ${missing.slice(0, 5).map((f) => f.path).join(", ")}`);
    for (const f of [...files].sort(() => Math.random() - 0.5).slice(0, 3)) {
      const res = await fetch(`${OMNARA}/orgs/${need("OMNARA_ORG_ID")}/projects/${need("OMNARA_PROJECT_ID")}/memory-stores/${store}/file?path=${encodeURIComponent(f.path)}`, {
        headers: { Authorization: `Bearer ${need("OMNARA_API_KEY")}`, "User-Agent": "website-chatbot-kb-sync/0.1" },
      });
      if (!res.ok || (await res.text()).trim() !== f.body.trim()) problems.push(`${f.path} didn't read back as written (HTTP ${res.status})`);
    }
  }

  if (!flag("--no-push")) {
    const instruction = readFileSync(resolve(base, cfg.instructionFile), "utf8");
    const site = { ...cfg.site, instruction, siteMap: siteMap(files) };
    const server = (env.CHATBOT_SERVER ?? env.PUBLIC_URL ?? "").replace(/\/$/, "");
    if (!server) throw new Error("Missing CHATBOT_SERVER (or PUBLIC_URL)");
    if (dryRun) {
      console.log(`would push site config "${cfg.site.key}" to ${server} (site map: ${files.length} lines)`);
      return;
    }
    const res = await serverFetch(`${server}/api/sync/site`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${need("API_TOKEN")}`, "Content-Type": "application/json" },
      body: JSON.stringify(site),
    });
    if (res.ok) console.log(`pushed site config "${cfg.site.key}" to ${server}`);
    else problems.push(`config push failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

    if (live && res.ok) {
      const question = (cfg.site.starters as { path: string; prompts: string[] }[] | undefined)?.find((s) => s.path === "/")?.prompts[0] ?? `What is ${cfg.site.name}?`;
      console.log(`asking the live bot: "${question}"`);
      const p = await askLiveBot(server, question);
      if (p) problems.push(p);
      else console.log("the live bot answered");
    }
  }

  if (dryRun) return;
  for (const w of warnings) console.log(`warning: ${w}`);
  if (problems.length) {
    console.log(`\nSYNC FAILED:\n  ${problems.join("\n  ")}`);
    await alertFailure(problems);
    process.exitCode = 1;
  } else {
    console.log(`\nSYNC OK${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  async (e: unknown) => {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`\nSYNC FAILED: ${why}`);
    await alertFailure([why]);
    process.exit(1);
  },
);
