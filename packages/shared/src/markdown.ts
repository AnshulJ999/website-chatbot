// A small, safe Markdown subset for chat answers: paragraphs, bold, italics, inline code, links,
// bullet and numbered lists, fenced code blocks, simple tables, and headings (shown as a bold line).
// Everything is escaped first; only http(s) and mailto links become anchors.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  const codes: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
      const u = url.replace(/&amp;/g, "&");
      if (!/^(https?:|mailto:)/i.test(u)) return m;
      return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
  // eslint-disable-next-line no-control-regex
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * An answer still streaming, without its unfinished end, so half-written Markdown doesn't flash as raw text:
 * a table is held back until its header and rule line are in (then each row until it ends), and on the last
 * line an open bold or code span is closed and a half-typed link shows only its words.
 */
export function tidyStreaming(src: string): string {
  const lines = src.split("\n");
  // Inside an open code fence the rest already shows as code.
  if (lines.filter((l) => /^\s*```/.test(l)).length % 2 === 1) return src;
  let end = lines.length;
  // A finished line ends with a line break, which leaves an empty last line.
  const tail = lines[end - 1] === "" ? end - 1 : end;
  let start = tail;
  while (start > 0 && /^\s*\|/.test(lines[start - 1]!)) start--;
  if (start < tail) {
    const block = lines.slice(start, tail);
    const finished = tail < end || isTableRow(block[block.length - 1]!);
    if (block.length < 2 || !isTableRule(block[1]!) || (block.length === 2 && !finished)) end = start;
    else if (!finished) end = tail - 1;
  }
  const kept = lines.slice(0, end);
  let last = kept.pop() ?? "";
  last = last
    .replace(/\[([^\]]*)\]\([^)]*$/, "$1")
    .replace(/\[([^\]]*)\]?$/, "$1")
    .replace(/(^|[^*])\*$/, "$1");
  const ticks = (last.replace(/```/g, "").match(/`/g) ?? []).length;
  if (ticks % 2 === 1) last = last.endsWith("`") ? last.slice(0, -1) : `${last}\``;
  const bolds = (last.replace(/`[^`]*`/g, "").match(/\*\*/g) ?? []).length;
  if (bolds % 2 === 1) last = /\*\*\s*$/.test(last) ? last.replace(/\*\*\s*$/, "") : `${last}**`;
  return [...kept, last].join("\n");
}

export interface MarkdownOptions {
  /** Adds a Copy button to code blocks (the page handles clicks on `.code-copy`). */
  copyButtons?: boolean;
}

export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();

    const fence = /^\s*```/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!);
      const copy = opts.copyButtons ? `<button type="button" class="code-copy" aria-label="Copy code">Copy</button>` : "";
      html.push(`<div class="code-block">${copy}<pre><code>${esc(code.join("\n"))}</code></pre></div>`);
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
      const tb = rows.map((r) => `<tr>${head.map((_, j) => `<td>${inline(r[j] ?? "")}</td>`).join("")}</tr>`).join("");
      html.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      html.push(`<p><strong>${inline(heading[1]!.replace(/\*\*/g, ""))}</strong></p>`);
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? num)![1]!);
    } else if (!line.trim()) {
      flush();
    } else {
      flushList();
      para.push(line);
    }
  }
  flush();
  return html.join("");
}
