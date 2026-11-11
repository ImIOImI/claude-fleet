import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import * as db from '../main/db.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, openTestState, type TestState } from '../main/store/testStore.js';
import { partitionIdFor, publishedSessionId, PUBLISH_MAX_LINES } from '../main/publish/protocol.js';
import { makeScrubber, type ScrubbedLine } from '../main/publish/scrub.js';
import { HOST_TRACK } from './hostSchema.js';
import { leaseFence, LeaseLostError } from './pgLease.js';
import { PublishConflictError, publishStore } from './publishStore.js';

const HOSTED = '01JC0000000000000000000000';
const SRC = '01JC0000000000000000000005';
const SID = '11111111-2222-4333-8444-555555555555';
const ANN = { provider: 'github', id: 7, login: 'ann' };
const BOB = { provider: 'github', id: 8, login: 'bob' };
const scrub = makeScrubber([]);
const turn = (uuid: string, type: string, content: string): ScrubbedLine =>
  scrub(JSON.stringify({ type, uuid, sessionId: SID, timestamp: '2026-11-05T00:00:00Z', message: { role: type, content } }));

it('one publish request is one ingest transaction', () => {
  expect(PUBLISH_MAX_LINES).toBe(db.INGEST_TX_LINES);
});

describe.skipIf(!isPg)('publishStore', () => {
  let st: TestState | null = null;
  afterEach(async () => { await st?.close(); st = null; });

  async function rig(o: Parameters<typeof publishStore>[1] = {}) {
    st = await openTestState('pub-');
    await migratePostgres(postgresKysely(st.pg!.pool), st.pg!.schema, HOST_TRACK);
    return publishStore(db.stateKysely, o);
  }
  const count = async (t: string): Promise<number> =>
    Number((await st!.pg!.pool.query(`SELECT COUNT(*)::int AS n FROM ${st!.pg!.schema}.${t}`)).rows[0].n);

  it('files rows under the caller’s partition and a derived session id, idempotently', async () => {
    const bumped: string[] = [];
    const s = await rig({ onIngested: (id) => bumped.push(id) });
    const part = partitionIdFor(ANN, SRC);
    const r1 = await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'hello'), turn('a1', 'assistant', 'hi')]);
    expect(r1).toEqual({ partitionId: part, sessionId: publishedSessionId(part, SID), inserted: 2 });
    const r2 = await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'hello'), turn('a1', 'assistant', 'hi')]);
    expect(r2.inserted).toBe(0);
    expect(bumped).toEqual([r1.sessionId]);
    const k = db.stateKysely();
    expect(await k.selectFrom('events').select(['workspace_id', 'session_id']).distinct().execute())
      .toEqual([{ workspace_id: part, session_id: r1.sessionId }]);
    expect(await count('events')).toBe(2);
    expect((await db.getSession(r1.sessionId))?.workspaceId).toBe(part);
    expect(await s.partitionIds()).toEqual([part]);
    expect((await st!.pg!.pool.query(`SELECT session_id, partition_id, source_session_id FROM ${st!.pg!.schema}.publish_sessions`)).rows)
      .toEqual([{ session_id: r1.sessionId, partition_id: part, source_session_id: SID }]);
  });

  it('keeps two owners’ identical source session ids apart', async () => {
    const s = await rig();
    const a = await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'ann')]);
    const b = await s.ingest(BOB, SRC, SID, [turn('u1', 'user', 'bob')]);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.partitionId).not.toBe(b.partitionId);
    expect((await db.eventsForSession(a.sessionId)).map((e) => JSON.parse(e.rawJsonl).message.content)).toEqual(['ann']);
    expect((await db.eventsForSession(b.sessionId)).map((e) => JSON.parse(e.rawJsonl).message.content)).toEqual(['bob']);
  });

  it('refreshes the display login, never the key', async () => {
    const s = await rig();
    await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'x')]);
    await s.ingest({ ...ANN, login: 'ann-renamed' }, SRC, SID, [turn('u2', 'user', 'y')]);
    const rows = (await st!.pg!.pool.query(`SELECT owner_id, owner_login FROM ${st!.pg!.schema}.publish_partitions`)).rows;
    expect(rows).toEqual([{ owner_id: '7', owner_login: 'ann-renamed' }]);
  });

  it('refuses a derived session id another workspace already holds, and writes nothing', async () => {
    const s = await rig();
    const id = publishedSessionId(partitionIdFor(ANN, SRC), SID);
    await db.stateKysely().insertInto('sessions').values({
      id, workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: 1, ai_title: null, first_user_message: null, user_set_name: null
    }).execute();
    await expect(s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'x')])).rejects.toThrow(PublishConflictError);
    expect(await db.eventsForSession(id)).toEqual([]);
    expect(await s.partitionIds()).toEqual([]);
    expect(await count('publish_sessions')).toBe(0);
    expect((await db.getSession(id))?.workspaceId).toBe(HOSTED);
  });

  it('refuses a session held by another publisher’s partition', async () => {
    const s = await rig();
    const id = publishedSessionId(partitionIdFor(ANN, SRC), SID);
    await s.ingest(BOB, SRC, SID, [turn('u1', 'user', 'bob')]);
    await db.stateKysely().updateTable('sessions').set({ id }).where('workspace_id', '=', partitionIdFor(BOB, SRC)).execute();
    await expect(s.ingest(ANN, SRC, SID, [turn('u2', 'user', 'ann')])).rejects.toThrow(PublishConflictError);
    expect(await s.partitionIds()).toEqual([partitionIdFor(BOB, SRC)]);
  });

  it('writes nothing once the lease is lost', async () => {
    const s = await rig();
    const schema = st!.pg!.schema;
    await st!.pg!.pool.query(`INSERT INTO ${schema}.host_lease VALUES ($1, 'me', 2, clock_timestamp() + interval '1 minute')`, [HOSTED]);
    await db.closeDb();
    const lost: Error[] = [];
    await db.openDbPostgres(st!.pg!.pool, {
      migrate: false,
      afterBeginWrite: leaseFence({ workspaceId: HOSTED, holder: 'me', epoch: () => 1, onLost: (e) => lost.push(e) })
    });
    await expect(s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'x')])).rejects.toThrow(LeaseLostError);
    expect(await count('events')).toBe(0);
    expect(await count('publish_partitions')).toBe(0);
    expect(await count('publish_sessions')).toBe(0);
    expect(lost).toHaveLength(1);
  });

  it('runs the claim inside the ingest transaction, under a statement timeout', async () => {
    const seen: string[] = [];
    const s = await rig({
      ingest: async (_w: string, _s: string, _l: readonly string[], opts: Parameters<typeof db.ingestBatch>[3] = {}) => {
        await db.stateKysely().transaction().execute(async (trx) => {
          await opts.atStart!(trx);
          const r = await sql<{ t: string }>`SELECT current_setting('statement_timeout') AS t`.execute(trx);
          seen.push(r.rows[0].t);
        });
        return [];
      }
    });
    await s.ingest(ANN, SRC, SID, [turn('u1', 'user', 'x')]);
    expect(seen).toEqual(['5s']);
    expect(await s.partitionIds()).toEqual([partitionIdFor(ANN, SRC)]);
  });
});
