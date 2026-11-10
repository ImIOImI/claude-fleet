// Federated search merge (D64): every source scores cosine similarity on the
// same model, so scores sort together.
import { compareBytes, type SearchHitItem } from '../../preload/federation.js';

export function mergeHits(sources: { origin: string; hits: Omit<SearchHitItem, 'origin'>[] }[], limit: number): SearchHitItem[] {
  const all = sources.flatMap((s) => s.hits.map((h) => ({ ...h, origin: s.origin })));
  all.sort((a, b) => b.score - a.score || compareBytes(a.origin, b.origin) || compareBytes(a.sessionId, b.sessionId) || (a.ts ?? 0) - (b.ts ?? 0));
  return all.slice(0, limit);
}
