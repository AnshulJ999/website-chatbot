import type { Env } from "./env";

let releaseCache: { repo: string; at: number; value: unknown } | undefined;

export async function latestRelease(env: Env, repo: string | undefined): Promise<{ ok: boolean; value: unknown }> {
  if (!repo) return { ok: false, value: "No release source is configured for this site." };
  if (releaseCache?.repo === repo && Date.now() - releaseCache.at < 600_000) return { ok: true, value: releaseCache.value };
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "website-chatbot" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!res.ok) return { ok: false, value: `Could not read the latest release (HTTP ${res.status}).` };
  const r = (await res.json()) as { tag_name: string; name: string; published_at: string; html_url: string; body?: string };
  const value = { version: r.tag_name, name: r.name, published: r.published_at.slice(0, 10), url: r.html_url, notes: (r.body ?? "").slice(0, 3000) };
  releaseCache = { repo, at: Date.now(), value };
  return { ok: true, value };
}
