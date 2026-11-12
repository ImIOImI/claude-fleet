// Proposals repository (#407 Phase 5) over the inbox.db connection. Never
// pruned: proposals and decisions are the audit trail. Async on Kysely.
import { sql, type Kysely } from 'kysely';
import type { CaptureSettingsChange, Proposal, ProposalItem } from '../../preload/inboxTypes.js';
import { newId } from '../inbox/inboxDb.js';
import type { InboxDb, ProposalRow } from '../store/inboxSchema.js';

function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id, kind: r.kind, proposer: { kind: r.proposer_kind, id: r.proposer_id }, rationale: r.rationale, status: r.status,
    items: JSON.parse(r.items) as ProposalItem[], note: r.note, createdAt: r.created_at, decidedAt: r.decided_at,
    ...(r.payload ? { captureSettings: JSON.parse(r.payload) as CaptureSettingsChange } : {})
  };
}

export class ProposalStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  async create(p: Omit<Proposal, 'id' | 'decidedAt' | 'note'>, now = Date.now()): Promise<Proposal> {
    const id = newId(now);
    await this.db.insertInto('proposals').values({
      id, kind: p.kind, proposer_kind: p.proposer.kind, proposer_id: p.proposer.id, rationale: p.rationale, status: p.status,
      items: JSON.stringify(p.items), payload: p.captureSettings ? JSON.stringify(p.captureSettings) : null, created_at: now, decided_at: p.status === 'pending' ? null : now
    }).execute();
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Proposal | null> {
    const r = await this.db.selectFrom('proposals').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toProposal(r) : null;
  }

  async list(limit = 100): Promise<Proposal[]> {
    const rows = await this.db.selectFrom('proposals').selectAll()
      .orderBy(sql`CASE status WHEN 'pending' THEN 0 ELSE 1 END`).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return rows.map(toProposal);
  }

  async pending(): Promise<Proposal[]> {
    const rows = await this.db.selectFrom('proposals').selectAll().where('status', '=', 'pending').orderBy('created_at').orderBy('id').execute();
    return rows.map(toProposal);
  }

  async save(p: Proposal): Promise<void> {
    await this.db.updateTable('proposals')
      .set({ status: p.status, items: JSON.stringify(p.items), note: p.note, decided_at: p.decidedAt })
      .where('id', '=', p.id).execute();
  }

  /** Compare-and-set: saves only while the row is still pending with the items as read; false when another decision landed first. */
  async saveIfPending(p: Proposal, readItems: ProposalItem[]): Promise<boolean> {
    const r = await this.db.updateTable('proposals')
      .set({ status: p.status, items: JSON.stringify(p.items), note: p.note, decided_at: p.decidedAt })
      .where('id', '=', p.id).where('status', '=', 'pending').where('items', '=', JSON.stringify(readItems)).executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }
}
