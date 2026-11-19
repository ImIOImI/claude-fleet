import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';
import { pgDrainStore } from './drainStore.js';
import { drainStoreContract } from './drainStore.test.js';

const HOSTED = '01JC0000000000000000000000';
const OTHER = '01JC0000000000000000000001';

let t: TestPg | null = null;
afterEach(async () => { await t?.drop(); t = null; });

async function owners(k: Kysely<HostDb>, rows: Array<[string, string, string]>): Promise<void> {
  await k.insertInto('session_owners').values(rows.map(([broker_session_id, session_id, workspace_id], i) => ({
    broker_session_id, session_id, workspace_id, kind: 'user', provider: 'github', account_id: '7', login: 'ann', name: null, avatar_url: null, started_at: i
  }))).execute();
}

async function rig(): Promise<Kysely<HostDb>> {
  t = await testPgSchema();
  const k = postgresKysely<HostDb>(t.pool);
  await migratePostgres(k, t.schema, HOST_TRACK);
  await k.insertInto('host_meta').values({ singleton: true, workspace_id: HOSTED, created_at: 1 }).execute();
  return k;
}

drainStoreContract('postgres', async () => {
  const k = await rig();
  await owners(k, [['tab1', 'c1', HOSTED], ['tab2', 'c2', HOSTED], ['tab1', 'c9', HOSTED]]);
  return pgDrainStore(k);
}, !isPg);

describe.skipIf(!isPg)('postgres drained rows', () => {
  it('serves only rows whose session is owned in the hosted workspace (host_meta)', async () => {
    const k = await rig();
    await owners(k, [['tab1', 'c1', HOSTED], ['tab2', 'c2', OTHER]]);
    const s = pgDrainStore(k);
    await s.recordDrained([
      { instance: 'i', brokerSessionId: 'tab1', sessionId: 'c1', reason: null },
      { instance: 'i', brokerSessionId: 'tab2', sessionId: 'c2', reason: null },
      { instance: 'i', brokerSessionId: 'tab3', sessionId: 'c3', reason: null }
    ], 10);
    expect(await s.drained(0, 10)).toEqual([{ brokerSessionId: 'tab1', sessionId: 'c1', drainedAt: 10 }]);
  });

  it('a pending row is claimed by exactly one of two holders', async () => {
    const k = await rig();
    const a = pgDrainStore(k);
    const b = pgDrainStore(postgresKysely<HostDb>(t!.pool));
    expect(await a.markRetry('R1', 'A', 1)).toBe(true);
    const [x, y] = await Promise.all([a.claimPending(2), b.claimPending(2)]);
    expect(x.length + y.length).toBe(1);
    expect(await b.markRetry('R1', 'A', 3)).toBe(false);
  });
});
