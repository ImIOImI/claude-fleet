// Knowledge capture (#483 §5): pure helpers that pull the session ids a
// search result references, in rank order, for search-hit capture.

export interface SearchHitEvent {
  callerWorkspaceId: string;
  /** The caller's MCP read scope; only sessions inside it may be captured. */
  allowedWorkspaces: ReadonlySet<string>;
  tool: 'search_transcripts' | 'search_claims' | 'query';
  /** The search text (for `query`, the SQL). */
  query: string;
  /** Distinct session ids in result-rank order. */
  sessionIds: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function distinct(ids: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === 'string' && id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

export function sessionIdsFromTranscriptHits(hits: unknown): string[] {
  if (!Array.isArray(hits)) return [];
  return distinct(hits.map((h) => (h && typeof h === 'object' ? (h as { sessionId?: unknown }).sessionId : undefined)));
}

export function sessionIdsFromClaimResults(r: unknown): string[] {
  const results = r && typeof r === 'object' ? (r as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) return [];
  return distinct(results.flatMap((c) => {
    const sources = c && typeof c === 'object' ? (c as { sources?: unknown }).sources : undefined;
    return Array.isArray(sources) ? sources.map((s) => (s && typeof s === 'object' ? (s as { sessionId?: unknown }).sessionId : undefined)) : [];
  }));
}

export function sessionIdsFromQueryRows(rows: unknown[]): string[] {
  return distinct(rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const o = row as Record<string, unknown>;
    const ids = [o.session_id, o.sessionId, o.claude_session_id];
    if (typeof o.id === 'string' && UUID_RE.test(o.id)) ids.push(o.id);
    return ids;
  }));
}
