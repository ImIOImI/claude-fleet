// Minimal line diff (LCS) for proposal cards (#407 Phase 5). Pure.
export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** Keep changed lines plus `context` unchanged lines around them; collapse the rest to "…". */
export function compact(lines: DiffLine[], context = 2): Array<DiffLine | { type: 'gap' }> {
  const keep = lines.map((l, i) => l.type !== 'same' || lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.type !== 'same'));
  const out: Array<DiffLine | { type: 'gap' }> = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.length === 0 || out[out.length - 1].type !== 'gap') out.push({ type: 'gap' });
  });
  return out;
}
