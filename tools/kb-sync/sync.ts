#!/usr/bin/env node
// kb-sync: copies a site's content into its Omnara memory store (one file per page, each starting
// with its real URL) and pushes the site's chatbot config to the chat server.
//
//   node sync.ts <site>/chatbot/chatbot.config.json [--env <file>] [--dry-run] [--prune] [--create-store] [--no-push]
//
// Credentials come from the environment or --env (a KEY=value file such as the server's .dev.vars):
// OMNARA_API_KEY, OMNARA_ORG_ID, OMNARA_PROJECT_ID, CHATBOT_SERVER (or PUBLIC_URL), API_TOKEN.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

interface Source {
  /** "dir": every .md/.mdx/.txt file under `dir`; "file": one file; "url": fetch a page (e.g. /llms.txt). */
  type: "dir" | "file" | "url";
  dir?: string;
  file?: string;
  url?: string;
  /** Page URL template for dir sources: {slug} is the file path without extension. */
  pageUrl: string;
  /** File name (without extension) that maps to the bare pageUrl, e.g. "README" for /docs. */
  index?: string;
  /** Where the files go inside the store. */
  storePath: string;
}

interface SyncConfig {
  /** SiteConfig without `instruction` (read from instructionFile). */
  site: Record<string, unknown> & { key: string; storeName: string };
  instructionFile: string;
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
const configPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--env");
if (!configPath) {
  console.error("Usage: node sync.ts <chatbot.config.json> [--env <file>] [--dry-run] [--prune] [--create-store] [--no-push]");
  process.exit(2);
}

const env: Record<string, string | undefined> = { ...process.env };
const envFile = opt("--env");
if (envFile) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) env[m[1]!] ??= m[2]!.replace(/^["']|["']$/g, "");
  }
}
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

async function collect(): Promise<KbFile[]> {
  const files: KbFile[] = [];
  for (const s of cfg.sources) {
    if (s.type === "dir") {
      const dir = resolve(base, s.dir!);
      for (const full of walk(dir)) {
        const rel = relative(dir, full).replace(/\\/g, "/");
        const slug = rel.replace(/\.(md|mdx|txt)$/i, "");
        const url = s.index && slug === s.index ? s.pageUrl.replace(/\/?\{slug\}$/, "") : s.pageUrl.replace("{slug}", slug);
        files.push({ path: `${s.storePath}/${slug}.md`, body: withUrl(url, clean(readFileSync(full, "utf8"))) });
      }
    } else if (s.type === "file") {
      files.push({ path: s.storePath, body: withUrl(s.pageUrl, clean(readFileSync(resolve(base, s.file!), "utf8"))) });
    } else {
      const res = await fetch(s.url!);
      if (!res.ok) throw new Error(`${s.url}: HTTP ${res.status}`);
      files.push({ path: s.storePath, body: withUrl(s.pageUrl, (await res.text()).trim()) });
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

// ---------- main ----------

async function main(): Promise<void> {
  const files = await collect();
  console.log(`${files.length} files for store "${cfg.site.storeName}"`);
  if (dryRun) {
    for (const f of files) console.log(`  ${f.path}  (${f.body.length} chars)  ${f.body.split("\n", 1)[0]}`);
  } else {
    let store = await storeId(cfg.site.storeName);
    if (!store) {
      if (!flag("--create-store")) throw new Error(`No memory store named "${cfg.site.storeName}". Run again with --create-store to create it.`);
      const r = await omnara<{ id?: string; memory_store?: { id: string } }>("POST", "/memory-stores", JSON.stringify({ name: cfg.site.storeName, agent_access: "read" }));
      store = r.data.memory_store?.id ?? r.data.id ?? null;
      if (!store) throw new Error(`creating the store failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      console.log(`created store ${store}`);
    }
    const counts = { written: 0, updated: 0, same: 0 };
    for (const [i, f] of files.entries()) {
      counts[await put(store, f)]++;
      if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${files.length}`);
    }
    console.log(`store: ${counts.written + counts.same} new or unchanged, ${counts.updated} changed`);

    const keep = new Set(files.map((f) => f.path.replace(/^\/+/, "")));
    const stale = (await listAll(store)).map((p) => p.replace(/^\/+/, "")).filter((p) => !keep.has(p));
    if (stale.length) {
      if (flag("--prune")) {
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
  }

  if (flag("--no-push")) return;
  const instruction = readFileSync(resolve(base, cfg.instructionFile), "utf8");
  const site = { ...cfg.site, instruction };
  const server = (env.CHATBOT_SERVER ?? env.PUBLIC_URL ?? "").replace(/\/$/, "");
  if (!server) throw new Error("Missing CHATBOT_SERVER (or PUBLIC_URL)");
  if (dryRun) {
    console.log(`would push site config "${cfg.site.key}" to ${server}`);
    return;
  }
  const res = await fetch(`${server}/api/sync/site`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${need("API_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify(site),
  });
  console.log(res.ok ? `pushed site config "${cfg.site.key}" to ${server}` : `push failed: HTTP ${res.status} ${await res.text()}`);
  if (!res.ok) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
