const SUGGESTIONS_RE = /\n?\s*SUGGESTIONS:\s*(.*)\s*$/i;

/** Splits the model's trailing "SUGGESTIONS: a | b | c" line off an answer. */
export function splitSuggestions(raw: string): { text: string; suggestions: string[] } {
  const m = SUGGESTIONS_RE.exec(raw);
  if (!m) return { text: raw.trim(), suggestions: [] };
  const suggestions = (m[1] ?? "")
    .split("|")
    .map((s) => s.trim().replace(/^["'`]|["'`]$/g, ""))
    .filter((s) => s.length > 0 && s.length <= 80)
    .slice(0, 3);
  return { text: raw.slice(0, m.index).trim(), suggestions };
}

/** While an answer streams in, hide a partly written SUGGESTIONS line. */
export function visiblePreview(raw: string): string {
  const full = raw.toUpperCase().indexOf("SUGGESTIONS:");
  if (full >= 0) return raw.slice(0, full).trimEnd();
  const nl = raw.lastIndexOf("\n");
  const tail = raw.slice(nl + 1).trim().toUpperCase();
  if (nl >= 0 && tail && "SUGGESTIONS:".startsWith(tail)) return raw.slice(0, nl).trimEnd();
  return raw;
}

/** Time-sortable random id, e.g. "c_lx2k9a_5f3b2c1d". */
export function newId(prefix: string): string {
  const rand = new Uint8Array(6);
  crypto.getRandomValues(rand);
  const hex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${Date.now().toString(36)}_${hex}`;
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254;
}
