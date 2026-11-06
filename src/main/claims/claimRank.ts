// Knowledge claims (#483): pure ranking helpers for search_claims.

/** Safe FTS5 MATCH expression: each token quoted (no operator injection), ORed. */
export function ftsQuery(q: string): string | null {
  const toks = q.replace(/"/g, '').match(/[A-Za-z0-9#_.-]+/g)
    ?.map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length > 0) ?? [];
  return toks.length === 0 ? null : toks.map((t) => `"${t}"`).join(' OR ');
}

/** Reciprocal rank fusion: score = Σ 1/(k + rank). Ties keep first-seen order. */
export function rrf(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Topics most used by the nearest claims, so agents converge on shared slugs. */
export function suggestTopics(neighbors: { topics: string[] }[], given: string[], max = 5): string[] {
  const n = new Map<string, number>();
  for (const c of neighbors) for (const t of c.topics) if (!given.includes(t)) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t);
}
