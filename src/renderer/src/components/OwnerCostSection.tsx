// Collapsed until opened; refetched on each summary change while open (D121).
import { useEffect, useState } from 'react';
import type { OwnerCostRow } from '../../../preload/sessionOwner';
import { formatUsd, ownerCostLines } from '../ownerView';
import { OwnerBadge } from './OwnerBadge';

export function OwnerCostList({ rows }: { rows: OwnerCostRow[] | null | undefined }) {
  if (rows === undefined) return <div className="subdued">Loading…</div>;
  if (rows === null) return <div className="subdued">Host unavailable</div>;
  const lines = ownerCostLines(rows);
  if (lines.length === 0) return <div className="subdued">No cost recorded yet</div>;
  return (
    <ul className="obs-owner-list">
      {lines.map((l) => (
        <li key={l.key} className="obs-owner-row">
          {l.owner ? <OwnerBadge owner={l.owner} /> : <span className="owner-badge subdued">Unattributed</span>}
          <span className="obs-owner-sessions">{`${l.sessions} session${l.sessions === 1 ? '' : 's'}`}</span>
          <span className="obs-owner-usd">{formatUsd(l.usd)}</span>
        </li>
      ))}
    </ul>
  );
}

interface Fetched {
  workspaceId: string;
  rows: OwnerCostRow[] | null;
}

/** Undefined (loading) until rows for this workspace arrive, so a switch never shows the previous one's. */
export function rowsFor(got: Fetched | undefined, workspaceId: string): OwnerCostRow[] | null | undefined {
  return got?.workspaceId === workspaceId ? got.rows : undefined;
}

export function OwnerCostSection({ workspaceId, refreshKey }: { workspaceId: string; refreshKey: number | null }) {
  const [open, setOpen] = useState(false);
  const [got, setGot] = useState<Fetched | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let live = true;
    window.api.observability.ownerCosts(workspaceId).then(
      (r) => live && setGot({ workspaceId, rows: r }),
      () => live && setGot({ workspaceId, rows: null })
    );
    return () => {
      live = false;
    };
  }, [open, workspaceId, refreshKey]);
  return (
    <section className="obs-owner-costs">
      <button type="button" className="btn-mini obs-owner-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Cost by owner
      </button>
      {open && <OwnerCostList rows={rowsFor(got, workspaceId)} />}
    </section>
  );
}
