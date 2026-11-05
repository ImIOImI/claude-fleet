import { afterEach, describe, expect, it } from 'vitest';
import { sql, type Generated, type Kysely } from 'kysely';
import { createPgPool, postgresKysely } from '../main/store/postgres.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { isPg, pgMultiConnection, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK } from './hostSchema.js';
import { leaseFence, LeaseLostError, postgresLeaseStore } from './pgLease.js';

const WS = '01JC0000000000000000000000';
interface T { w: { epoch: number; seq: Generated<number> } }

describe.skipIf(!isPg)('postgresLeaseStore + leaseFence', () => {
  let t: TestPg | null = null;
  afterEach(async () => {
    await t?.drop();
    t = null;
  });

  async function setup() {
    t = await testPgSchema();
    const k = postgresKysely<unknown>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    await sql`CREATE SEQUENCE wseq`.execute(k);
    await sql`CREATE TABLE w (epoch BIGINT NOT NULL, seq BIGINT NOT NULL DEFAULT nextval('wseq'))`.execute(k);
    return postgresLeaseStore(postgresKysely(t.pool), WS);
  }
  const q = (text: string) => t!.pool.query(text.replaceAll('$S', t!.schema));
  const fenced = (holder: string, epoch: () => number | null, lost: Error[] = []): Kysely<T> =>
    postgresKysely<T>(t!.pool, { afterBeginWrite: leaseFence({ workspaceId: WS, holder, epoch, onLost: (e) => lost.push(e) }) });

  it('one holder; a live lease is refused; re-acquire by the holder bumps the epoch; release frees it', async () => {
    const s = await setup();
    expect(await s.tryAcquire('a', 0, 30_000)).toBe(1);
    expect(await s.tryAcquire('b', 0, 30_000)).toBeNull();
    expect(await s.renew('a', 1, 0, 30_000)).toBe(true);
    expect(await s.renew('a', 2, 0, 30_000)).toBe(false);
    expect(await s.tryAcquire('a', 0, 30_000)).toBe(2);
    await s.release('a', 2);
    expect(await s.tryAcquire('b', 0, 30_000)).toBe(3);
    expect(await s.renew('a', 2, 0, 30_000)).toBe(false);
  });

  it('judges expiry on the DB clock, never the caller’s', async () => {
    const s = await setup();
    await s.tryAcquire('a', 0, 30_000);
    expect(await s.tryAcquire('b', Date.now() + 3_600_000, 30_000)).toBeNull();
    await q(`UPDATE $S.host_lease SET expires_at = clock_timestamp() - interval '1 second'`);
    expect(await s.tryAcquire('b', 0, 30_000)).toBe(2);
  });

  it('a fenced write passes for the holder and fails, calling onLost, for anyone else', async () => {
    const s = await setup();
    const e = (await s.tryAcquire('a', 0, 30_000))!;
    await fenced('a', () => e).insertInto('w').values({ epoch: e }).execute();
    const lost: Error[] = [];
    await expect(fenced('b', () => e, lost).insertInto('w').values({ epoch: e }).execute()).rejects.toBeInstanceOf(LeaseLostError);
    await expect(fenced('a', () => null, lost).insertInto('w').values({ epoch: e }).execute()).rejects.toThrow(/not the holder/);
    await expect(fenced('a', () => e + 1, lost).insertInto('w').values({ epoch: e }).execute()).rejects.toThrow(/lease lost/);
    expect(lost).toHaveLength(3);
    expect((await q(`SELECT count(*)::int AS n FROM $S.w`)).rows[0].n).toBe(1);
  });

  it('calls onLost once per fence, and keeps refusing after', async () => {
    const s = await setup();
    const e = (await s.tryAcquire('a', 0, 30_000))!;
    const lost: Error[] = [];
    const k = fenced('b', () => e, lost);
    await expect(k.insertInto('w').values({ epoch: e }).execute()).rejects.toBeInstanceOf(LeaseLostError);
    await expect(k.insertInto('w').values({ epoch: e }).execute()).rejects.toBeInstanceOf(LeaseLostError);
    await expect(sql`select 1`.execute(k)).rejects.toBeInstanceOf(LeaseLostError);
    expect(lost).toHaveLength(1);
  });

  it.skipIf(!pgMultiConnection)('lease statements give up on a held row lock after lockTimeoutMs instead of waiting', async () => {
    const s0 = await setup();
    const s = postgresLeaseStore(postgresKysely(t!.pool), WS, { lockTimeoutMs: 200 });
    const e = (await s0.tryAcquire('a', 0, 30_000))!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inTx!: () => void;
    const entered = new Promise<void>((r) => (inTx = r));
    const tx = fenced('a', () => e).transaction().execute(async (trx) => {
      await trx.insertInto('w').values({ epoch: e }).execute();
      inTx();
      await gate;
    });
    await entered;
    const t0 = Date.now();
    await expect(s.renew('a', e, 0, 30_000)).rejects.toThrow(/lock timeout/);
    await expect(s.tryAcquire('a', 0, 30_000)).rejects.toThrow(/lock timeout/);
    expect(Date.now() - t0).toBeLessThan(3_000);
    release();
    await tx;
    expect(await s.renew('a', e, 0, 30_000)).toBe(true);
  }, 30_000);

  it.skipIf(!pgMultiConnection)('a holder left idle in a fenced transaction is rolled back, and a standby takes over within TTL + the idle timeout', async () => {
    const s = await setup();
    const ttl = 1_000;
    const idle = 1_000;
    const pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: t!.schema, max: 1, session: { idleInTransactionMs: idle } });
    pool.on('error', () => undefined);
    try {
      const e = (await s.tryAcquire('a', 0, ttl))!;
      const ka = postgresKysely<T>(pool, { afterBeginWrite: leaseFence({ workspaceId: WS, holder: 'a', epoch: () => e, onLost: () => undefined }) });
      let inTx!: () => void;
      const entered = new Promise<void>((r) => (inTx = r));
      // A partitioned holder: the transaction stays open, holding FOR SHARE, and never finishes.
      const stuck = ka.transaction().execute(async (trx) => {
        await trx.insertInto('w').values({ epoch: e }).execute();
        inTx();
        await new Promise(() => undefined);
      });
      void stuck.catch(() => undefined);
      await entered;
      const sb = postgresLeaseStore(postgresKysely(t!.pool), WS, { lockTimeoutMs: 200 });
      const t0 = Date.now();
      let got: number | null = null;
      while (got === null && Date.now() - t0 < 10_000) {
        got = await sb.tryAcquire('b', 0, 30_000).catch(() => null);
        if (got === null) await new Promise((r) => setTimeout(r, 100));
      }
      expect(got).toBe(e + 1);
      expect(Date.now() - t0).toBeLessThan(ttl + idle + 1_500);
      expect((await q(`SELECT count(*)::int AS n FROM $S.w`)).rows[0].n).toBe(0);
    } finally {
      // The stuck transaction's client is never released, so end() may not settle.
      await Promise.race([pool.end().catch(() => undefined), new Promise((r) => setTimeout(r, 500))]);
    }
  }, 30_000);

  it.skipIf(!pgMultiConnection)('a takeover waits for an in-flight fenced write; the stale holder then fails', async () => {
    const s = await setup();
    const lostA: Error[] = [];
    const epochA = (await s.tryAcquire('a', 0, 1_000))!;
    const ka = fenced('a', () => epochA, lostA);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inTx!: () => void;
    const entered = new Promise<void>((r) => (inTx = r));
    const txA = ka.transaction().execute(async (trx) => {
      await trx.insertInto('w').values({ epoch: epochA }).execute();
      inTx();
      await gate;
    });
    await entered;
    // Wait for expiry on the DB clock; a plain SELECT doesn't wait on A's FOR SHARE.
    while (!(await q(`SELECT expires_at <= clock_timestamp() AS e FROM $S.host_lease`)).rows[0].e) {
      await new Promise((r) => setTimeout(r, 100));
    }
    let acquired: number | null | undefined;
    const take = s.tryAcquire('b', 0, 30_000).then((e) => (acquired = e));
    await new Promise((r) => setTimeout(r, 300));
    expect(acquired).toBeUndefined();
    release();
    await txA;
    await take;
    expect(acquired).toBe(epochA + 1);
    await expect(ka.insertInto('w').values({ epoch: epochA }).execute()).rejects.toBeInstanceOf(LeaseLostError);
    expect(lostA).toHaveLength(1);
    await fenced('b', () => acquired!).insertInto('w').values({ epoch: acquired! }).execute();
    expect((await q(`SELECT epoch FROM $S.w ORDER BY seq`)).rows.map((r) => Number(r.epoch))).toEqual([epochA, epochA + 1]);
  }, 30_000);

  it.skipIf(!pgMultiConnection)('an acquire that waited on a fenced write judges expiry as of the grant, not its start', async () => {
    const s = await setup();
    const epochA = (await s.tryAcquire('a', 0, 1_000))!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inTx!: () => void;
    const entered = new Promise<void>((r) => (inTx = r));
    const txA = fenced('a', () => epochA).transaction().execute(async (trx) => {
      await trx.insertInto('w').values({ epoch: epochA }).execute();
      inTx();
      await gate;
    });
    await entered;
    expect((await q(`SELECT expires_at > clock_timestamp() AS live FROM $S.host_lease`)).rows[0].live).toBe(true);
    const take = s.tryAcquire('b', 0, 30_000);
    while (!(await q(`SELECT expires_at <= clock_timestamp() AS e FROM $S.host_lease`)).rows[0].e) {
      await new Promise((r) => setTimeout(r, 100));
    }
    release();
    await txA;
    expect(await take).toBe(epochA + 1);
  }, 30_000);

  it.skipIf(!pgMultiConnection)('under concurrent writers and repeated takeovers, no stale write commits after a takeover', async () => {
    const s = await setup();
    const holders = ['a', 'b', 'c'];
    const held = new Map<string, number | null>(holders.map((h) => [h, null]));
    // One write transaction at a time per handle (its write lock), so the epoch
    // the fence validated last is the one the open transaction runs under.
    const validated = new Map<string, number>();
    const handles = new Map(holders.map((h) => [h, postgresKysely<T>(t!.pool, {
      afterBeginWrite: async (exec) => {
        const e = held.get(h) ?? null;
        await leaseFence({ workspaceId: WS, holder: h, epoch: () => e, onLost: () => undefined })(exec);
        validated.set(h, e!);
      }
    })]));
    const takeovers: { epoch: number; seq: number }[] = [];
    let stop = false;
    const writer = async (h: string) => {
      let ok = 0;
      let refused = 0;
      while (!stop) {
        try {
          await handles.get(h)!.transaction().execute(async (trx) => {
            const e = validated.get(h)!;
            // Validated, not yet written: the window a takeover must not slip into.
            await new Promise((r) => setTimeout(r, Math.random() * 8));
            await trx.insertInto('w').values({ epoch: e }).execute();
          });
          ok++;
        } catch (err) {
          if (!(err instanceof LeaseLostError)) throw err;
          refused++;
          await new Promise((r) => setTimeout(r, 2));
        }
      }
      return { ok, refused };
    };
    const writers = holders.flatMap((h) => [writer(h), writer(h)]);
    for (let i = 0; i < 30; i++) {
      const h = holders[i % holders.length];
      await q(`UPDATE $S.host_lease SET expires_at = clock_timestamp() - interval '1 ms'`);
      const e = await s.tryAcquire(h, 0, 30_000);
      expect(e).not.toBeNull();
      takeovers.push({ epoch: e!, seq: Number((await q(`SELECT nextval('$S.wseq') AS n`)).rows[0].n) });
      held.set(h, e);
      await new Promise((r) => setTimeout(r, 20));
    }
    stop = true;
    const stats = await Promise.all(writers);
    expect(stats.reduce((n, x) => n + x.ok, 0)).toBeGreaterThan(30);
    expect(stats.reduce((n, x) => n + x.refused, 0)).toBeGreaterThan(0);
    const rows = (await q(`SELECT epoch, seq FROM $S.w`)).rows.map((r) => ({ epoch: Number(r.epoch), seq: Number(r.seq) }));
    for (const tk of takeovers) expect(rows.filter((r) => r.epoch < tk.epoch && r.seq > tk.seq)).toEqual([]);
  }, 60_000);
});
