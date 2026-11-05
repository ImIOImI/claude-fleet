// Knowledge claims (#483): inbox.db persistence. Async Kysely only — inside a
// transaction callback query through trx, never this.db (mutex deadlock).
import { sql, type Kysely } from 'kysely';
import type { ClaimRow, ClaimSourceRow, InboxDb } from '../store/inboxSchema.js';
import type { ClaimKind, ClaimRecord, ClaimSourceInput, ClaimStatus, ClaimVisibility } from './types.js';

export interface NewClaim {
  id: string; text: string; kind: ClaimKind; topics: string[]; refs: string[];
  visibility: ClaimVisibility; workspaceId: string; now: number;
}

function toRecord(r: ClaimRow): ClaimRecord {
  return {
    id: r.id, text: r.text, kind: r.kind as ClaimKind, topics: JSON.parse(r.topics) as string[],
    refs: r.refs ? (JSON.parse(r.refs) as string[]) : [], visibility: r.visibility as ClaimVisibility,
    status: r.status as ClaimStatus, supersededBy: r.superseded_by, retractReason: r.retract_reason,
    workspaceId: r.workspace_id, confirmations: r.confirmations, createdAt: r.created_at, updatedAt: r.updated_at
  };
}

export class ClaimStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  /** Insert a claim with its FTS row, vector and first source. With
   *  `supersedes`, the target is marked superseded in the SAME transaction —
   *  if it is no longer current the whole insert rolls back. */
  async insert(c: NewClaim, vec: Buffer | null, modelId: string, src: ClaimSourceInput, opts: { supersedes?: string | null } = {}): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('claims').values({
        id: c.id, text: c.text, kind: c.kind, topics: JSON.stringify(c.topics),
        refs: c.refs.length ? JSON.stringify(c.refs) : null, visibility: c.visibility,
        superseded_by: null, retract_reason: null, workspace_id: c.workspaceId, created_at: c.now, updated_at: c.now
      }).execute();
      await sql`INSERT INTO claims_fts (claim_id, text, topics) VALUES (${c.id}, ${c.text}, ${c.topics.join(' ')})`.execute(trx);
      if (vec) await trx.insertInto('claim_vectors').values({ claim_id: c.id, model_id: modelId, vec }).execute();
      await trx.insertInto('claim_sources').values({
        claim_id: c.id, workspace_id: src.workspaceId, session_id: src.sessionId, via: src.via,
        capture_run: src.captureRun, ts: c.now
      }).execute();
      // Last, so a vanished or no-longer-current target rolls back everything above.
      if (opts.supersedes) {
        const r = await trx.updateTable('claims').set({ status: 'superseded', superseded_by: c.id, updated_at: c.now })
          .where('id', '=', opts.supersedes).where('status', '=', 'current').executeTakeFirst();
        if (Number(r.numUpdatedRows) !== 1) throw new Error('cannot supersede: the target claim is no longer current');
      }
    });
  }

  async get(id: string): Promise<ClaimRecord | null> {
    const r = await this.db.selectFrom('claims').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toRecord(r) : null;
  }

  async visible(callerId: string, modelId: string, includeInactive: boolean): Promise<Array<{ claim: ClaimRecord; vec: Buffer | null }>> {
    let q = this.db.selectFrom('claims')
      .leftJoin('claim_vectors', (j) => j.onRef('claim_vectors.claim_id', '=', 'claims.id').on('claim_vectors.model_id', '=', modelId))
      .selectAll('claims').select('claim_vectors.vec')
      .where((eb) => eb.or([eb('claims.visibility', '=', 'fleet'), eb('claims.workspace_id', '=', callerId)]));
    if (!includeInactive) q = q.where('claims.status', '=', 'current');
    const rows = await q.orderBy('claims.created_at').execute();
    return rows.map((r) => ({ claim: toRecord(r), vec: (r.vec as Buffer | null) ?? null }));
  }

  async confirm(id: string, src: ClaimSourceInput, now: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('claims').set((eb) => ({ confirmations: eb('confirmations', '+', 1), updated_at: now })).where('id', '=', id).execute();
      await trx.insertInto('claim_sources').values({
        claim_id: id, workspace_id: src.workspaceId, session_id: src.sessionId, via: src.via, capture_run: src.captureRun, ts: now
      }).execute();
    });
  }

  async supersede(oldId: string, newId: string, now: number): Promise<void> {
    await this.db.updateTable('claims').set({ status: 'superseded', superseded_by: newId, updated_at: now }).where('id', '=', oldId).execute();
  }

  async retract(id: string, reason: string, now: number): Promise<void> {
    await this.db.updateTable('claims').set({ status: 'retracted', retract_reason: reason, updated_at: now }).where('id', '=', id).execute();
  }

  async ftsIds(callerId: string, match: string, limit: number, includeInactive: boolean): Promise<string[]> {
    const rows = await sql<{ id: string }>`
      SELECT c.id AS id FROM claims_fts f JOIN claims c ON c.id = f.claim_id
      WHERE claims_fts MATCH ${match}
        AND (c.visibility = 'fleet' OR c.workspace_id = ${callerId})
        AND (${includeInactive ? 1 : 0} = 1 OR c.status = 'current')
      ORDER BY bm25(claims_fts) LIMIT ${limit}`.execute(this.db);
    return rows.rows.map((r) => r.id);
  }

  async sources(ids: string[]): Promise<Map<string, ClaimSourceRow[]>> {
    const out = new Map<string, ClaimSourceRow[]>();
    if (ids.length === 0) return out;
    const rows = await this.db.selectFrom('claim_sources').selectAll().where('claim_id', 'in', ids).orderBy('ts').execute();
    for (const r of rows) out.set(r.claim_id, [...(out.get(r.claim_id) ?? []), r]);
    return out;
  }

  async missingVectors(modelId: string, limit: number): Promise<Array<{ id: string; text: string }>> {
    return this.db.selectFrom('claims')
      .leftJoin('claim_vectors', (j) => j.onRef('claim_vectors.claim_id', '=', 'claims.id').on('claim_vectors.model_id', '=', modelId))
      .select(['claims.id as id', 'claims.text as text']).where('claim_vectors.claim_id', 'is', null).limit(limit).execute();
  }

  async setVector(id: string, modelId: string, vec: Buffer): Promise<void> {
    await this.db.insertInto('claim_vectors').values({ claim_id: id, model_id: modelId, vec })
      .onConflict((oc) => oc.column('claim_id').doUpdateSet({ model_id: modelId, vec })).execute();
  }
}
