// Split plain text into text and link segments, so a todo body (written by
// automations and workspaces) can show its URLs as clickable links. Bare
// http(s) URLs and markdown links `[label](https://…)` become links; nothing
// else is interpreted. Only http(s) hrefs are produced — the main process
// (setWindowOpenHandler + externalUrl.ts) opens them in the browser.

export type Segment = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"'`]+/g;

function webUrl(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Drop sentence punctuation (and an unbalanced closing paren) glued to the end of a bare URL. */
function trimBare(url: string): string {
  let out = url;
  for (;;) {
    const last = out.slice(-1);
    if ('.,;:!?\'"'.includes(last) && last !== '') out = out.slice(0, -1);
    else if (last === ')' && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) out = out.slice(0, -1);
    else return out;
  }
}

export function linkify(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  const push = (s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') prev.text += s;
    else out.push({ kind: 'text', text: s });
  };
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
    push(text.slice(at, start));
    if (m[1] !== undefined) {
      const href = webUrl(m[2]);
      if (href) out.push({ kind: 'link', text: m[1], href });
      else push(m[0]);
      at = start + m[0].length;
    } else {
      const raw = trimBare(m[0]);
      const href = webUrl(raw);
      if (href) out.push({ kind: 'link', text: raw, href });
      else push(raw);
      at = start + raw.length;
    }
  }
  push(text.slice(at));
  return out;
}
