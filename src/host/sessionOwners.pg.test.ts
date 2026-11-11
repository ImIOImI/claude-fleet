import { afterEach, describe, expect, it } from 'vitest';
import * as db from '../main/db.js';
import { costFor } from '../main/pricing.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, openTestState, type TestState } from '../main/store/testStore.js';
import { MAX_OWNER_COST_ROWS, type SessionOwner } from '../preload/sessionOwner.js';
import { HOST_TRACK } from './hostSchema.js';
import { leaseFence, LeaseLostError } from './pgLease.js';
import { automationOwner, ownerOfIdentity, sessionOwnerStore, type OwnerClaim } from './sessionOwners.js';
import { person } from './testFakes.js';

const HOSTED = '01JC0000000000000000000000';
const OTHER = '01JC0000000000000000000001';
const S1 = '11111111-2222-4333-8444-555555555551';
const S2 = '11111111-2222-4333-8444-555555555552';
const S3 = '11111111-2222-4333-8444-555555555553';
const ann = ownerOfIdentity(person('ann', 7));
const bob = ownerOfIdentity(person('bob', 8));
const claim = (brokerSessionId: string, sessionId: string, owner: SessionOwner, startedAt: number): OwnerClaim => ({ brokerSessionId, sessionId, owner, startedAt });
const usd = (n: number) => costFor('claude-opus-4-1', null, { inputTokens: n, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

describe('ownerOfIdentity', () => {
  it('takes the provider, account id, login, a clean name and only an allowlisted avatar', () => {
    expect(ownerOfIdentity({ ...person('ann', 7), name: ' Ann‮ ', avatarUrl: 'https://evil.example/a.png' }))
      .toEqual({ kind: 'user', provider: 'github', id: '7', login: 'ann', name: 'Ann', avatarUrl: null });
    expect(ownerOfIdentity({ ...person('ann', 7), avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' }).avatarUrl)
      .toBe('https://avatars.githubusercontent.com/u/7?v=4');
  });

  it('refuses an identity whose login is not a GitHub login', () => {
    expect(() => ownerOfIdentity(person('-x', 7))).toThrow(/can't be recorded/);
    expect(() => ownerOfIdentity(person('a b', 7))).toThrow(/can't be recorded/);
  });
});

describe.skipIf(!isPg)('sessionOwnerStore', () => {
  let st: TestState | null = null;
  afterEach(async () => { await st?.close(); st = null; });

  async function rig() {
    st = await openTestState('owners-');
    await migratePostgres(postgresKysely(st.pg!.pool), st.pg!.schema, HOST_TRACK);
    return sessionOwnerStore(db.stateKysely, HOSTED);
  }
  const sess = (id: string, last: number) => ({ id, workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: last, ai_title: null, first_user_message: null, user_set_name: null });
  const cost = (session_id: string, input_tokens: number) => ({
    session_id, workspace_id: HOSTED, model: 'claude-opus-4-1', service_tier: '', input_tokens, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0, event_count: 1
  });

  it('records once per broker and claude session; a later record never changes it', async () => {
    const s = await rig();
    expect(await s.record(claim('tab-1', S1, ann, 10))).toBe(true);
    expect(await s.record(claim('tab-1', S1, bob, 20))).toBe(false);
    expect(await s.record(claim('tab-1', S2, bob, 30))).toBe(true);
    const m = await s.ownersOf([S1, S2], [HOSTED]);
    expect(m.get(S1)).toEqual(ann);
    expect(m.get(S2)).toEqual(bob);
  });

  it('the first row owns a claude session: a later insert with an earlier clock or a smaller broker id never takes it over', async () => {
    const s = await rig();
    await s.record(claim('tab-b', S1, bob, 20));
    await s.record(claim('tab-a', S1, ann, 10));
    await s.record(claim('tab-0', S1, ann, 20));
    expect((await s.ownersOf([S1], [HOSTED])).get(S1)).toEqual(bob);
    const rows = await st!.pg!.pool.query(`SELECT broker_session_id, started_at FROM ${st!.pg!.schema}.session_owners ORDER BY started_at, broker_session_id`);
    expect(rows.rows.map((r: { broker_session_id: string; started_at: string }) => [r.broker_session_id, Number(r.started_at)]))
      .toEqual([['tab-b', 20], ['tab-a', 21], ['tab-0', 22]]);
  });

  it('a later insert keeps its own clock when that is already later', async () => {
    const s = await rig();
    await s.record(claim('tab-b', S1, bob, 20));
    await s.record(claim('tab-a', S1, ann, 50));
    await s.record(claim('tab-c', S2, ann, 5));
    const rows = await st!.pg!.pool.query(`SELECT broker_session_id, started_at FROM ${st!.pg!.schema}.session_owners ORDER BY broker_session_id`);
    expect(rows.rows.map((r: { broker_session_id: string; started_at: string }) => [r.broker_session_id, Number(r.started_at)]))
      .toEqual([['tab-a', 50], ['tab-b', 20], ['tab-c', 5]]);
  });

  it('pinState: owned only by a row in this workspace; published by any publish_sessions row', async () => {
    const s = await rig();
    expect(await s.pinState(S1)).toEqual({ owned: false, published: false });
    await s.record(claim('tab-1', S1, ann, 10));
    expect(await s.pinState(S1)).toEqual({ owned: true, published: false });
    expect(await sessionOwnerStore(db.stateKysely, OTHER).pinState(S1)).toEqual({ owned: false, published: false });
    const schema = st!.pg!.schema;
    await st!.pg!.pool.query(`INSERT INTO ${schema}.publish_partitions (partition_id, owner_provider, owner_id, owner_login, source_workspace_id, created_at)
      VALUES ('pub_a', 'github', '9', 'cat', $1, 1)`, [OTHER]);
    await st!.pg!.pool.query(`INSERT INTO ${schema}.publish_sessions (session_id, partition_id, source_session_id, first_published_at, last_published_at)
      VALUES ($1, 'pub_a', 'src', 1, 1)`, [S3]);
    expect(await s.pinState(S3)).toEqual({ owned: false, published: true });
  });

  it('release drops only the row it names', async () => {
    const s = await rig();
    await s.record(claim('tab-1', S1, ann, 10));
    await s.record(claim('tab-2', S1, bob, 20));
    await s.release('tab-1', S1);
    expect((await s.ownersOf([S1], [HOSTED])).get(S1)).toEqual(bob);
  });

  it('records automation runs as the workspace', async () => {
    const s = await rig();
    await s.record(claim(`auto-r1-go`, S1, automationOwner(HOSTED), 10));
    expect((await s.ownersOf([S1], [HOSTED])).get(S1)).toEqual({ kind: 'automation', provider: 'fleet-host', id: HOSTED, login: 'automation', name: null, avatarUrl: null });
  });

  it('reads only the workspaces it is given; published sessions resolve to their partition owner', async () => {
    const s = await rig();
    await s.record(claim('tab-1', S1, ann, 10));
    const schema = st!.pg!.schema;
    await st!.pg!.pool.query(`INSERT INTO ${schema}.publish_partitions (partition_id, owner_provider, owner_id, owner_login, source_workspace_id, created_at)
      VALUES ('pub_a', 'github', '9', 'cat', $1, 1)`, [OTHER]);
    await st!.pg!.pool.query(`INSERT INTO ${schema}.publish_sessions (session_id, partition_id, source_session_id, first_published_at, last_published_at)
      VALUES ($1, 'pub_a', 'src', 1, 1)`, [S3]);
    expect([...(await s.ownersOf([S1, S3], [OTHER])).keys()]).toEqual([]);
    expect([...(await s.ownersOf([S1, S3], [HOSTED])).keys()]).toEqual([S1]);
    const both = await s.ownersOf([S1, S3], [HOSTED, 'pub_a']);
    expect(both.get(S1)).toEqual(ann);
    expect(both.get(S3)).toEqual({ kind: 'publisher', provider: 'github', id: '9', login: 'cat', name: null, avatarUrl: null });
    expect(await s.ownersOf([], [HOSTED])).toEqual(new Map());
  });

  it('a published session never resolves to a stored row, even one recorded under its id', async () => {
    const s = await rig();
    const schema = st!.pg!.schema;
    await st!.pg!.pool.query(`INSERT INTO ${schema}.publish_partitions (partition_id, owner_provider, owner_id, owner_login, source_workspace_id, created_at)
      VALUES ('pub_a', 'github', '9', 'cat', $1, 1)`, [OTHER]);
    await st!.pg!.pool.query(`INSERT INTO ${schema}.publish_sessions (session_id, partition_id, source_session_id, first_published_at, last_published_at)
      VALUES ($1, 'pub_a', 'src', 1, 1)`, [S3]);
    await s.record(claim('tab-1', S3, ann, 1));
    expect((await s.ownersOf([S3], [HOSTED, 'pub_a'])).get(S3)).toEqual({ kind: 'publisher', provider: 'github', id: '9', login: 'cat', name: null, avatarUrl: null });
    expect((await s.ownersOf([S3], [HOSTED])).has(S3)).toBe(false);
  });

  it('record re-validates the owner: an off-host avatar is not stored, a bad login or a publisher is refused', async () => {
    const s = await rig();
    await s.record(claim('tab-1', S1, { ...ann, avatarUrl: 'https://evil.example/a.png' }, 1));
    const rows = await st!.pg!.pool.query(`SELECT avatar_url FROM ${st!.pg!.schema}.session_owners`);
    expect(rows.rows).toEqual([{ avatar_url: null }]);
    await expect(s.record(claim('tab-2', S1, { ...ann, login: '-x' }, 1))).rejects.toThrow(/can't be recorded/);
    await expect(s.record(claim('tab-3', S1, { ...ann, kind: 'publisher' }, 1))).rejects.toThrow(/partition/);
  });

  it('groups cost by owner, most expensive first, with unowned sessions under null', async () => {
    const s = await rig();
    const k = db.stateKysely();
    await k.insertInto('sessions').values([sess(S1, 100), sess(S2, 200), sess(S3, 300)]).execute();
    await k.insertInto('session_costs').values([cost(S1, 1000), cost(S2, 3000), cost(S3, 500)]).execute();
    await s.record(claim('t1', S1, ann, 1));
    await s.record(claim('t2', S2, ann, 1));
    await s.record(claim('t3', S2, bob, 2));
    expect(await s.ownerCosts([HOSTED])).toEqual([
      { owner: ann, sessions: 2, usd: usd(1000) + usd(3000) },
      { owner: null, sessions: 1, usd: usd(500) }
    ]);
    expect(await s.ownerCosts([HOSTED], { since: 250 })).toEqual([{ owner: null, sessions: 1, usd: usd(500) }]);
    expect(await s.ownerCosts([OTHER])).toEqual([]);
    expect(await s.ownerCosts([])).toEqual([]);
  });

  it(`returns at most ${MAX_OWNER_COST_ROWS} owners`, async () => {
    const s = await rig();
    const k = db.stateKysely();
    const n = MAX_OWNER_COST_ROWS + 1;
    const ids = Array.from({ length: n }, (_, i) => `11111111-2222-4333-8444-${String(i).padStart(12, '0')}`);
    await k.insertInto('sessions').values(ids.map((id) => sess(id, 1))).execute();
    await k.insertInto('session_costs').values(ids.map((id, i) => cost(id, 1000 + i))).execute();
    for (const [i, id] of ids.entries()) await s.record(claim(`t${i}`, id, ownerOfIdentity(person(`u${i}`, i + 1)), 1));
    const rows = await s.ownerCosts([HOSTED]);
    expect(rows).toHaveLength(MAX_OWNER_COST_ROWS);
    expect(rows[0].owner!.login).toBe(`u${n - 1}`);
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
    await expect(s.record(claim('t1', S1, ann, 1))).rejects.toThrow(LeaseLostError);
    expect((await st!.pg!.pool.query(`SELECT count(*)::int AS n FROM ${schema}.session_owners`)).rows[0].n).toBe(0);
    await st!.pg!.pool.query(`INSERT INTO ${schema}.session_owners VALUES ('t2', $1, $2, 'user', 'github', '7', 'ann', NULL, NULL, 1)`, [S2, HOSTED]);
    await expect(s.release('t2', S2)).rejects.toThrow(LeaseLostError);
    expect((await st!.pg!.pool.query(`SELECT count(*)::int AS n FROM ${schema}.session_owners`)).rows[0].n).toBe(1);
    expect(lost).toHaveLength(1);
  });
});
