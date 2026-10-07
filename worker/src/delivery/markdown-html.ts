// Markdown to the small HTML Postiz keeps for providers with an HTML editor
// (WordPress, Listmonk). Postiz runs such content through
// stripHtmlValidation('html', ...), which keeps only p, h1, h2, h3, ul, li,
// strong, u and a (libraries/helpers/src/utils/strip.html.validation.ts,
// v2.25.0) and drops every other tag but keeps its text. So this writes only
// those tags: deeper headings become h3, ordered lists become bullet lists whose
// items keep their numbers, emphasis, code and quotes become plain text, and a
// soft line break becomes a space. Everything else is escaped. Pure.

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const BARE_URL = /\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/gi;
const SLOT = /\u0000(\d+)\u0000/g;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function anchor(url: string, text: string): string {
  return `<a href="${escapeHtml(url)}">${text}</a>`;
}

export function inlineHtml(raw: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = raw.split("\u0000").join("");
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => hold(escapeHtml(code)));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) =>
    SAFE_HREF.test(url) ? hold(anchor(url, escapeHtml(text.replace(/\*\*|__|\*|_/g, "")))) : m);
  s = s.replace(BARE_URL, (url) => hold(anchor(url, escapeHtml(url))));
  s = escapeHtml(s);
  s = s.replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, "<strong>$1</strong>").replace(/__(\S(?:[^_\n]*\S)?)__/g, "<strong>$1</strong>");
  // Italics are not in Postiz's list: keep the words, drop the markers.
  s = s.replace(/(^|[^*\w])\*(\S(?:[^*\n]*\S)?)\*(?!\w)/g, "$1$2").replace(/(^|[^_\w])_(\S(?:[^_\n]*\S)?)_(?!\w)/g, "$1$2");
  return s.replace(SLOT, (_, i: string) => slots[Number(i)] ?? "");
}

export function markdownToPostizHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineHtml(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((i) => `<li>${i}</li>`).join("")}</ul>`);
    list = [];
  };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) out.push(`<p>${escapeHtml(lines[i++]!)}</p>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const n = Math.min(heading[1]!.length, 3);
      out.push(`<h${n}>${inlineHtml(heading[2]!)}</h${n}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      list.push(ul ? inlineHtml(ul[1]!) : `${ol![1]}) ${inlineHtml(ol![2]!)}`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (list.length && !quote) {
      // A continuation line of the last list item.
      list[list.length - 1] += ` ${inlineHtml(line.trim())}`;
      continue;
    }
    flushList();
    para.push((quote ? quote[1]! : line).trim());
  }
  flush();
  return out.join("");
}
