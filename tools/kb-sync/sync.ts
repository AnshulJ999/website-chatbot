#!/usr/bin/env node
// kb-sync: copies a site's content into its Omnara memory store (one file per page, each starting
// with its real URL) and pushes the site's chatbot config, with a generated site brief, to the chat server.
//
//   node sync.ts <site>/chatbot/chatbot.config.json [--live] [--full] [--env <file>] [--dry-run [--show <store path>|brief]] [--prune] [--force] [--alert] [--create-store] [--no-push]
//
// --live: the deployed server. Reads .sync.vars beside this file, stops early when nothing changed since the last
// good run (--full syncs anyway), removes pages that left the site (guarded) and checks the store afterwards.
// Ends with "SYNC OK" or "SYNC FAILED" (exit 1); the result is kept in .sync-state.json beside this file.
// Checks run before anything is written; --force overrides them. --alert sends a failure to the system ntfy topic.
//
// Credentials come from the environment, --env, or .sync.vars (--live): OMNARA_API_KEY, OMNARA_ORG_ID,
// OMNARA_PROJECT_ID, CHATBOT_SERVER (or PUBLIC_URL), API_TOKEN; optional CHATBOT_SERVER_IP (reach the server at
// this address when local DNS points its name elsewhere), NTFY_URL and NTFY_TOKEN (for --alert).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, relative, resolve } from "node:path";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Agent, fetch as uFetch } from "undici";

interface Source {
  /**
   * "dir": every .md/.mdx/.txt file under `dir`; "file": one file; "url": fetch one text page (e.g. /llms.txt);
   * "sitemap": every HTML page in the site's sitemap, converted to Markdown.
   */
  type: "dir" | "file" | "url" | "sitemap";
  /** dir/file: read from a shallow checkout of this git repository instead of the config's folder. */
  git?: { url: string; branch?: string };
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
  brief?: BriefConfig;
}

/** The site brief at the end of every prompt, generated at each sync. */
interface BriefConfig {
  /** Shown first, under "About <site>". */
  about?: BriefPart[];
  /** owner/repo: the newest stable release and any newer pre-release, from its GitHub releases feed. */
  releases?: string;
  /** Page list groups, first match wins: `match` is a store path prefix ("" matches everything left). */
  groups?: { label: string; match: string }[];
  /** Name live pages by their main heading (default) or by their <title> before " - " / ":" ("title"). */
  pageNames?: "heading" | "title";
  /** "- [name](address) (details): summary" lists in text pages: a page with that address takes the name and details, with the summary under its line. */
  lists?: { url: string; sections: string[] }[];
  /** Shown after the pages, each section under its own heading. */
  after?: BriefPart[];
}

/** A text page (`url`, e.g. /llms.txt) or a synced file (`file`, a store path): its intro before the first "## " heading, or the named "## " sections. `from` names the source in each heading. */
interface BriefPart {
  url?: string;
  file?: string;
  sections?: string[];
  from?: string;
}

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const configPath = args.find((a, i) => !a.startsWith("--") && !["--env", "--show", "--dump"].includes(args[i - 1] ?? ""));
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
  /** One-line summary for the site brief (front matter or meta description). */
  desc?: string;
}

/** Shallow, sparse checkouts of git sources, one per repository and branch; removed when the run ends. */
const checkouts = new Map<string, string>();
process.on("exit", () => {
  for (const dir of checkouts.values()) rmSync(dir, { recursive: true, force: true });
});

function sourceRoot(s: Source): string {
  if (!s.git) return base;
  const key = `${s.git.url}#${s.git.branch ?? ""}`;
  const known = checkouts.get(key);
  if (known) return known;
  const dir = mkdtempSync(join(tmpdir(), "kb-sync-"));
  checkouts.set(key, dir);
  const git = (a: string[], cwd?: string) =>
    execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString().trim();
  const folders = [
    ...new Set(
      cfg.sources
        .filter((o) => o.git?.url === s.git!.url && (o.git.branch ?? "") === (s.git!.branch ?? ""))
        .map((o) => o.dir ?? posix.dirname(o.file ?? "."))
        .filter((d) => d && d !== "."),
    ),
  ];
  git(["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--sparse", ...(s.git.branch ? ["--branch", s.git.branch] : []), s.git.url, dir]);
  if (folders.length) git(["sparse-checkout", "set", ...folders], dir);
  console.log(`  read ${s.git.url}${s.git.branch ? `@${s.git.branch}` : ""} (${git(["rev-parse", "--short", "HEAD"], dir)})`);
  return dir;
}

function frontDesc(text: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  return fm ? /^description:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1] : undefined;
}

const plain = (md: string) => md.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

/** A doc's summary: its front matter, else its line in the index file ("- [Name](file.md): summary"), else its first paragraph. */
function docDesc(raw: string, slug: string, indexText: string): string | undefined {
  const listed = new RegExp(`^\\s*[-*]\\s+\\[[^\\]]+\\]\\(${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.md\\)\\s*:?\\s*(.+)$`, "m").exec(indexText)?.[1];
  const first = clean(raw)
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("URL:"));
  const text = frontDesc(raw) ?? (listed ? plain(listed).replace(/[.;]$/, "") : first ? plain(first) : undefined);
  return text && text.length > 240 ? `${text.slice(0, 237).replace(/\s+\S*$/, "")}...` : text;
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

/** A single file's own links (README style: `SECURITY.md`, `../../releases`) made absolute against its page; images and HTML layout tags go. */
function absoluteLinks(body: string, pageUrl: string): string {
  return body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_m, n: string, inner: string) => `${"#".repeat(Number(n))} ${inner.replace(/<[^>]+>/g, "").trim()}`)
    .replace(/!\[[^\]]*\]\([^)]*\)[ \t]*\n?/g, "")
    .replace(/<img[^>]*>/g, "")
    .replace(/<\/?(?:p|h[1-6]|b|strong|a|div|br)\b[^>]*>/g, "")
    .replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (m, link: string) => {
      try {
        return `](${new URL(link, pageUrl).href})`;
      } catch {
        return m;
      }
    });
}
const noEmDash = (s: string) => s.replace(/\s*\u2014\s*/g, " - ");

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
  // Icons that carry meaning (a tick labelled "Included") become their label before icons are dropped.
  for (const el of root.querySelectorAll("svg[aria-label], img[alt], [role='img'][aria-label]")) {
    const label = (el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? "").trim();
    if (label && el.getAttribute("aria-hidden") !== "true") el.replaceWith(document.createTextNode(` ${label} `));
  }
  const drop =
    "nav, footer, script, style, noscript, iframe, svg, canvas, video, audio, img, picture, form, button, dialog, input, select, textarea, label, output, [role='slider'], [aria-hidden='true'], [hidden], .sr-only, [data-dev-ui]";
  for (const el of root.querySelectorAll(drop)) el.remove();
  // Text in neighbouring elements (a price and its period, a number and its label) keeps a space between.
  for (const el of root.querySelectorAll("*")) if (el.nextSibling?.nodeType === 1) el.after(document.createTextNode(" "));
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
    .replace(/^#{1,6} [^\n]+\n+(?=\* \* \*|$(?![\s\S]))/gm, "")
    .replace(/^\* \* \*\s*$/gm, "")
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
      out.push({ path: `${s.storePath}/${name}.md`, body: withUrl(u, md), desc: /^Description: (.+)$/m.exec(md)?.[1] });
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
      const dir = resolve(sourceRoot(s), s.dir!);
      const indexFile = s.index ? walk(dir).find((p) => basename(p).replace(/\.(md|mdx|txt)$/i, "") === s.index) : undefined;
      const indexText = indexFile ? readFileSync(indexFile, "utf8") : "";
      for (const full of walk(dir)) {
        const rel = relative(dir, full).replace(/\\/g, "/");
        const slug = rel.replace(/\.(md|mdx|txt)$/i, "");
        const url = s.index && slug === s.index ? s.pageUrl!.replace(/\/?\{slug\}$/, "") : s.pageUrl!.replace("{slug}", slug);
        const raw = readFileSync(full, "utf8");
        files.push({ path: `${s.storePath}/${slug}.md`, body: withUrl(url, linkPages(clean(raw), s, slug, url)), desc: docDesc(raw, slug, indexText) });
      }
    } else if (s.type === "file") {
      const raw = readFileSync(resolve(sourceRoot(s), s.file!), "utf8");
      files.push({ path: s.storePath, body: withUrl(s.pageUrl!, absoluteLinks(clean(raw), s.pageUrl!)), desc: frontDesc(raw) });
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
  // The bot copies the style it reads; its rules ask for hyphens.
  for (const f of files) {
    f.body = noEmDash(f.body);
    if (f.desc) f.desc = noEmDash(f.desc);
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

// ---------- site brief ----------

/** A synced page's Markdown, made compact for the prompt: headings become bold lines, link-only clutter goes. */
function tidy(md: string): string {
  return md
    .replace(/^(URL|Title|Description): .*$/gm, "")
    .replace(/\[\s*\n+\s*#{1,6} ([^\n]+?)\s*\n+\s*\]\(([^)\s]+)\)/g, "**$1** - $2")
    .replace(/^#{1,6} (.+)$/gm, "**$1**")
    .replace(/^\[(?:Read more|Read post →)\]\([^)]*\)\s*$/gm, "")
    .replace(/^.*\+\d+ more\s*$/gm, "")
    .replace(/^((?:Up to )?[\d.,]+\+?%?)\n\n(?=[A-Z])/gm, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Chosen "## " sections of a page, in the order asked, each under `level` heading; "" is the part before the first section. */
function pageSections(body: string, wanted: string[], warnings: string[], source: string, level = "####", from?: string): string {
  const [intro = "", ...rest] = body.split(/^## /m);
  const byTitle = new Map(rest.map((p) => [p.slice(0, p.indexOf("\n")).trim(), p.slice(p.indexOf("\n") + 1)]));
  return wanted
    .map((w) => {
      if (w === "") return tidy(intro.replace(/^# .*$/m, "").replace(/^> ?/gm, ""));
      const text = byTitle.get(w);
      if (text === undefined) warnings.push(`brief: no "## ${w}" section in ${source} any more`);
      return text === undefined ? "" : `${level} ${w}${from ? ` (from ${from})` : ""}\n\n${tidy(text)}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

const sameAddress = (a: string, b: string) => {
  const norm = (u: string) => u.trim().replace(/^https?:\/\/(www\.)?/i, "").replace(/\.md$/, "").replace(/\/$/, "").toLowerCase();
  return norm(a) === norm(b);
};

/** Newest stable release and any newer pre-release, from the GitHub releases feed (the API refuses many anonymous callers). */
async function releaseLines(repo: string): Promise<string> {
  const res = await fetch(`https://github.com/${repo}/releases.atom`);
  if (!res.ok) throw new Error(`releases feed HTTP ${res.status}`);
  const entries = [...(await res.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1]!;
    const link = /<link[^>]+href="([^"]+)"/.exec(e)?.[1] ?? "";
    const title = (/<title>([^<]*)<\/title>/.exec(e)?.[1] ?? "").replace(/&amp;/g, "&").trim();
    return { title, link, date: /<updated>([^<]{10})/.exec(e)?.[1] ?? "", pre: /-/.test(link.split("/tag/")[1] ?? "") };
  });
  const stable = entries.findIndex((e) => !e.pre);
  const beta = entries.findIndex((e) => e.pre);
  const line = (label: string, e: (typeof entries)[number]) => `- ${label}: ${e.title} (${e.date}) - ${e.link}`;
  const out: string[] = [];
  if (stable >= 0) out.push(line("Stable", entries[stable]!));
  if (beta >= 0 && (stable < 0 || beta < stable)) out.push(line("Beta (newer features, still being tested)", entries[beta]!));
  return out.join("\n");
}

const pageTitle = (f: KbFile) => (/^# (.+)$/m.exec(f.body)?.[1] ?? /^Title: (.+)$/m.exec(f.body)?.[1] ?? f.path).replace(/\*\*/g, "").trim();

/** A live page's short name from its <title>: the part before " - ", " | " or ": " ("Pricing - KopiaLens: ..." is "Pricing"). */
function shortTitle(f: KbFile): string {
  if (/(^|\/)home\.md$/.test(f.path)) return "Home";
  const t = /^Title: (.+)$/m.exec(f.body)?.[1]?.trim();
  if (!t) return pageTitle(f);
  const sep = [" - ", " | ", ": "].find((s) => t.includes(s));
  return sep ? t.slice(0, t.indexOf(sep)).trim() : t;
}

/** About, latest releases, every page (name - address - file, with the site's own summary where it gives one), then any closing sections. Part of every chat's prompt. */
async function buildBrief(files: KbFile[]): Promise<{ text: string; problems: string[]; warnings: string[] }> {
  const b = cfg.brief ?? {};
  const problems: string[] = [];
  const warnings: string[] = [];
  const parts: string[] = [];

  const pages = new Map<string, Promise<string | null>>();
  const textPage = (url: string) => {
    if (!pages.has(url))
      pages.set(
        url,
        fetch(url)
          .then(async (r) => (r.ok ? htmlPageLinks(await r.text(), new URL(url).origin) : (problems.push(`brief: couldn't read ${url} (HTTP ${r.status})`), null)))
          .catch(() => (problems.push(`brief: couldn't read ${url} (unreachable)`), null)),
      );
    return pages.get(url)!;
  };
  const render = async (p: BriefPart, level: string): Promise<string> => {
    const source = p.url ?? p.file ?? "";
    const body = p.url ? await textPage(p.url) : (files.find((x) => x.path === p.file)?.body ?? null);
    if (body === null) {
      if (p.file) problems.push(`brief: ${p.file} wasn't synced`);
      return "";
    }
    return pageSections(body, p.sections ?? [""], warnings, source, level, p.from);
  };

  const about = (await Promise.all((b.about ?? []).map((p) => render(p, "####")))).filter(Boolean);
  if (about.length) parts.push(`### About ${cfg.site.name}\n\n${about.join("\n\n")}`);

  if (b.releases) {
    try {
      const lines = await releaseLines(b.releases);
      if (lines) parts.push(`### Latest releases\n\n${lines}`);
    } catch (e) {
      warnings.push(`brief: releases left out (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // Names, details and summaries the site gives its own pages in list form, in the site's order.
  const items: { name: string; details?: string; summary: string; address: string }[] = [];
  for (const l of b.lists ?? []) {
    const body = await textPage(l.url);
    if (body === null) continue;
    const text = pageSections(body, l.sections, warnings, l.url, "####");
    for (const m of text.matchAll(/^- \[([^\]]+)\]\(([^)\s]+)\)(?: \(([^)]*)\))?:\s*(.+)$/gm)) items.push({ name: m[1]!, address: m[2]!, details: m[3], summary: m[4]!.trim() });
  }

  const groups = b.groups?.length ? b.groups : [{ label: "Pages", match: "" }];
  const listed = new Map<string, { order: number; key: string; line: string }[]>(groups.map((g) => [g.label, []]));
  for (const f of files) {
    const path = f.path.replace(/^\/+/, "");
    const g = groups.find((x) => path.startsWith(x.match));
    if (!g) continue;
    const url = /^URL: (.+)$/m.exec(f.body)?.[1]?.trim() ?? "";
    const page = /^https?:/.test(url) ? url : "no page";
    const i = items.findIndex((it) => sameAddress(it.address, url));
    const it = items[i];
    const name = it ? `${it.name}${it.details ? ` (${it.details})` : ""}` : b.pageNames === "title" && /^Title: /m.test(f.body) ? shortTitle(f) : pageTitle(f);
    listed.get(g.label)!.push({ order: it ? i : Number.MAX_SAFE_INTEGER, key: path, line: `- ${name} - ${page} - file: ${path}${it ? `\n  ${it.summary}` : ""}` });
  }
  const pageText = [...listed]
    .filter(([, lines]) => lines.length)
    .map(([label, lines]) => `#### ${label}\n\n${lines.sort((x, y) => x.order - y.order || x.key.localeCompare(y.key)).map((l) => l.line).join("\n")}`);
  const legend = `Each line: title - page address - file in your store${items.length ? "; a summary follows where the site gives one" : ""}.`;
  parts.push(`### Pages\n\n${legend}\n\n${pageText.join("\n\n")}`);

  for (const p of b.after ?? []) {
    const text = await render(p, "###");
    if (text) parts.push(text);
  }

  return { text: noEmDash(parts.join("\n\n")), problems, warnings };
}

// ---------- last result per site (.sync-state.json) ----------

interface SiteState {
  lastRun: string;
  result: "ok" | "unchanged" | "failed";
  lastChange?: string;
  fingerprint?: string;
  files?: number;
  problems?: string[];
}

const statePath = join(import.meta.dirname, ".sync-state.json");
const readState = (): Record<string, SiteState> => {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, SiteState>;
  } catch {
    return {};
  }
};
/** Kept for --live runs only: the Sitrep reads it, and the next run compares against the last good fingerprint. */
function saveState(patch: Partial<SiteState> & { result: SiteState["result"] }): void {
  if (!live || dryRun) return;
  const all = readState();
  all[cfg.site.key] = { ...all[cfg.site.key], ...patch, lastRun: new Date().toISOString() };
  writeFileSync(statePath, `${JSON.stringify(all, null, 2)}\n`);
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



// ---------- main ----------

async function main(): Promise<void> {
  const files = await collect();
  const problems: string[] = [];
  const warnings: string[] = [];
  console.log(`${files.length} files for store "${cfg.site.storeName}"`);
  if (skippedPaths.length) warnings.push(`${skippedPaths.length} live page(s) couldn't be fetched; their old copies were kept`);
  const brief = await buildBrief(files);
  warnings.push(...brief.warnings);
  const instruction = readFileSync(resolve(base, cfg.instructionFile), "utf8");
  const server = (env.CHATBOT_SERVER ?? env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const fingerprint = digest(JSON.stringify({ files, brief: brief.text, instruction, site: cfg.site, server }));

  if (dryRun) {
    for (const f of files) console.log(`  ${f.path}  (${f.body.length} chars)  ${f.body.split("\n", 1)[0]}`);
    const show = opt("--show");
    const hit = show && files.find((f) => f.path === show || f.path === `${show}.md` || f.path.endsWith(`/${show}`) || f.path.endsWith(`/${show}.md`));
    if (hit) console.log(`\n----- ${hit.path} -----\n${hit.body}`);
    if (show === "brief") console.log(`\n----- site brief -----\n${brief.text}`);
    const dump = opt("--dump");
    if (dump) writeFileSync(dump, JSON.stringify({ files, brief: brief.text }, null, 1));
    const pre = [...preflight(files, 0), ...brief.problems];
    if (pre.length) console.log(`\nchecks would stop a real sync:\n  ${pre.join("\n  ")}`);
    for (const w of warnings) console.log(`warning: ${w}`);
  } else {
    const last = readState()[cfg.site.key];
    if (live && !flag("--full") && last?.fingerprint === fingerprint && last.result !== "failed") {
      saveState({ result: "unchanged" });
      console.log(`\nSYNC OK (nothing changed since ${last.lastChange ?? last.lastRun})`);
      return;
    }
    let store = await storeId(cfg.site.storeName);
    if (!store) {
      if (!flag("--create-store")) throw new Error(`No memory store named "${cfg.site.storeName}". Run again with --create-store to create it.`);
      const r = await omnara<{ id?: string; memory_store?: { id: string } }>("POST", "/memory-stores", JSON.stringify({ name: cfg.site.storeName, agent_access: "read" }));
      store = r.data.memory_store?.id ?? r.data.id ?? null;
      if (!store) throw new Error(`creating the store failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      console.log(`created store ${store}`);
    }
    const before = (await listAll(store)).map((p) => p.replace(/^\/+/, ""));
    const pre = [...preflight(files, before.length), ...brief.problems];
    if (pre.length && !force) {
      console.log(`\nSYNC FAILED before changing the store (run again with --force to override):\n  ${pre.join("\n  ")}`);
      saveState({ result: "failed", problems: pre });
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
        console.log(`removed ${stale.length} files no longer in the site: ${stale.join(", ")}`);
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
    const site = { ...cfg.site, instruction, siteBrief: brief.text };
    if (!server) throw new Error("Missing CHATBOT_SERVER (or PUBLIC_URL)");
    if (dryRun) {
      console.log(`would push site config "${cfg.site.key}" to ${server} (site brief: ${brief.text.length} chars)`);
      return;
    }
    const res = await serverFetch(`${server}/api/sync/site`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${need("API_TOKEN")}`, "Content-Type": "application/json" },
      body: JSON.stringify(site),
    });
    if (res.ok) console.log(`pushed site config "${cfg.site.key}" to ${server}`);
    else problems.push(`config push failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  if (dryRun) return;
  for (const w of warnings) console.log(`warning: ${w}`);
  if (problems.length) {
    console.log(`\nSYNC FAILED:\n  ${problems.join("\n  ")}`);
    saveState({ result: "failed", problems });
    await alertFailure(problems);
    process.exitCode = 1;
  } else {
    const now = new Date().toISOString();
    saveState({ result: "ok", lastChange: now, fingerprint, files: files.length, problems: [] });
    console.log(`\nSYNC OK${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  async (e: unknown) => {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`\nSYNC FAILED: ${why}`);
    saveState({ result: "failed", problems: [why] });
    await alertFailure([why]);
    process.exit(1);
  },
);
