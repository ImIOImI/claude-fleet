import type { OwnerCostRow, SessionOwner } from '../../preload/sessionOwner';

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

export interface OwnerCostLine { key: string; owner: SessionOwner | null; sessions: number; usd: number }

/** Host order (most expensive first); a repeated owner keeps its first line. */
export function ownerCostLines(rows: readonly OwnerCostRow[]): OwnerCostLine[] {
  const seen = new Set<string>();
  const out: OwnerCostLine[] = [];
  for (const r of rows) {
    const key = r.owner ? `${r.owner.kind}:${r.owner.provider}:${r.owner.id}` : 'unattributed';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, owner: r.owner, sessions: r.sessions, usd: r.usd });
  }
  return out;
}
