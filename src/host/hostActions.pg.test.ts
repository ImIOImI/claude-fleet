// The ledger on the holder's fenced handle: a stale holder can't claim, and the PK makes a concurrent claim lose.
import { afterEach, describe, expect, it } from 'vitest';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';
import { leaseFence, postgresLeaseStore, LeaseLostError } from './pgLease.js';
import { pgActionLedger, LEDGER_TTL_MS } from './hostActions.js';

const WS = '01JC0000000000000000000000';
const RID = '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a';

describe.skipIf(!isPg)('pgActionLedger', () => {
  let t: TestPg | null = null;
  afterEach(async () => { await t?.drop(); t = null; });

  async function setup() {
    t = await testPgSchema();
    await migratePostgres(postgresKysely<unknown>(t.pool), t.schema, HOST_TRACK);
    return postgresLeaseStore(postgresKysely(t.pool), WS);
  }

  it('claims once, replays the outcome, and prunes rows past 24 h', async () => {
    const lease = await setup();
    const e = (await lease.tryAcquire('a', 0, 60_000))!;
    const k = postgresKysely<HostDb>(t!.pool, { afterBeginWrite: leaseFence({ workspaceId: WS, holder: 'a', epoch: () => e, onLost: () => undefined }) });
    let now = 1_000;
    const l = pgActionLedger(k, () => now);
    const [x, y] = await Promise.all([l.claim('github:7', RID, 'automations:run'), l.claim('github:7', RID, 'automations:run')]);
    expect([x.fresh, y.fresh].sort()).toEqual([false, true]);
    await l.settle('github:7', RID, { result: { runId: 'R' } });
    expect(await l.claim('github:7', RID, 'automations:run')).toEqual({ fresh: false, channel: 'automations:run', result: { runId: 'R' }, error: null });
    expect(await l.claim('github:8', RID, 'automations:run')).toEqual({ fresh: true });
    await l.settle('github:8', RID, { error: 'nope' });
    expect(await l.claim('github:7', RID, 'automations:run')).toEqual({ fresh: false, channel: 'automations:run', result: { runId: 'R' }, error: null });
    now += LEDGER_TTL_MS + 1;
    expect(await l.claim('github:7', '1b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a', 'automations:run')).toEqual({ fresh: true });
    expect(await l.claim('github:7', RID, 'automations:run')).toEqual({ fresh: true });
  });

  it('a superseded holder cannot claim', async () => {
    const lease = await setup();
    const eb = (await lease.tryAcquire('b', 0, 60_000))!;
    const kb = postgresKysely<HostDb>(t!.pool, { afterBeginWrite: leaseFence({ workspaceId: WS, holder: 'b', epoch: () => eb, onLost: () => undefined }) });
    await t!.pool.query(`UPDATE ${t!.schema}.host_lease SET expires_at = clock_timestamp() - interval '1 second'`);
    await lease.tryAcquire('a', 0, 60_000);
    await expect(pgActionLedger(kb).claim('github:7', RID, 'automations:run')).rejects.toBeInstanceOf(LeaseLostError);
  });
});
