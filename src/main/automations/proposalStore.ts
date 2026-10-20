// Proposals repository (#407 Phase 5) over the inbox.db connection. Never
// pruned: proposals and decisions are the audit trail.
import type Database from 'better-sqlite3';
import type { Proposal, ProposalItem, ProposalKind, ProposalStatus, TodoSource } from '../../preload/inboxTypes.js';
import { newId } from '../inbox/inboxDb.js';

interface PRow {
  id: string; kind: ProposalKind; proposer_kind: TodoSource['kind']; proposer_id: string | null; rationale: string | null;
  status: ProposalStatus; items: string; note: string | null; created_at: number; decided_at: number | null;
}

function toProposal(r: PRow): Proposal {
  return {
    id: r.id, kind: r.kind, proposer: { kind: r.proposer_kind, id: r.proposer_id }, rationale: r.rationale, status: r.status,
    items: JSON.parse(r.items) as ProposalItem[], note: r.note, createdAt: r.created_at, decidedAt: r.decided_at
  };
}

export class ProposalStore {
  constructor(private readonly db: Database.Database) {}

  create(p: Omit<Proposal, 'id' | 'decidedAt' | 'note'>, now = Date.now()): Proposal {
    const id = newId(now);
    this.db.prepare('INSERT INTO proposals (id, kind, proposer_kind, proposer_id, rationale, status, items, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.kind, p.proposer.kind, p.proposer.id, p.rationale, p.status, JSON.stringify(p.items), now, p.status === 'pending' ? null : now);
    return this.get(id)!;
  }

  get(id: string): Proposal | null {
    const r = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as PRow | undefined;
    return r ? toProposal(r) : null;
  }

  list(limit = 100): Proposal[] {
    return (this.db.prepare(`SELECT * FROM proposals ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`).all(limit) as PRow[]).map(toProposal);
  }

  pending(): Proposal[] {
    return (this.db.prepare(`SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at`).all() as PRow[]).map(toProposal);
  }

  save(p: Proposal): void {
    this.db.prepare('UPDATE proposals SET status = ?, items = ?, note = ?, decided_at = ? WHERE id = ?')
      .run(p.status, JSON.stringify(p.items), p.note, p.decidedAt, p.id);
  }
}
