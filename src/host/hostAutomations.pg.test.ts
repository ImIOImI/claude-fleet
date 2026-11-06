// Two hosts' automation runtimes on one schema, each with its own lease-fenced inbox store.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../main/automations/automationStore.js';
import { InboxStore } from '../main/inbox/inboxDb.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { INBOX_PG_TRACK } from '../main/store/migrations/inboxPg.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK } from './hostSchema.js';
import { createLogger } from './log.js';
import { leaseFence, postgresLeaseStore } from './pgLease.js';
import { fakeBroker } from './testFakes.js';
import { startHostAutomations, type HostAutomations } from './hostAutomations.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot' };
const daily = { definition: { name: 'nightly', triggers: [{ schedule: { cron: '0 3 * * *' } }], steps: [{ id: 'go', prompt: { workspace: '$self', mode: 'fresh', message: 'review' } }] }, enabled: true };

describe.skipIf(!isPg)('host automations under the lease', () => {
  let t: TestPg | null = null;
  const live: Array<HostAutomations | InboxStore> = [];
  afterEach(async () => {
    for (const x of live.splice(0).reverse()) await ('reconcile' in x ? x.stop() : x.close()).catch(() => undefined);
    await t?.drop();
    t = null;
  });

  async function host(holder: string, epoch: () => number | null, clock: { now: number }) {
    const inbox = await InboxStore.openPostgres(t!.pool, { migrate: false, afterBeginWrite: leaseFence({ workspaceId: WS.id, holder, epoch, onLost: () => undefined }) });
    const broker = fakeBroker([]);
    const h = await startHostAutomations({
      inbox, workspace: () => WS, ops: broker.ops, mcpArgs: [], events: { publish: () => undefined },
      log: createLogger(() => undefined), now: () => clock.now, tickMs: 3_600_000, settleMs: 50
    });
    live.push(inbox, h);
    return { h, broker };
  }

  async function setup() {
    t = await testPgSchema();
    const k = postgresKysely<unknown>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    await migratePostgres(k, t.schema, INBOX_PG_TRACK);
    return postgresLeaseStore(postgresKysely(t.pool), WS.id);
  }

  it('a due slot fires once across two hosts: the stale holder’s fenced write fails', async () => {
    const lease = await setup();
    const clock = { now: Date.parse('2026-11-06T02:00:00Z') };
    // b held the lease first and still believes it does (its runtime started, recover() ran fenced).
    const eb = (await lease.tryAcquire('b', 0, 60_000))!;
    const b = await host('b', () => eb, clock);
    await t!.pool.query(`UPDATE ${t!.schema}.host_lease SET expires_at = clock_timestamp() - interval '1 second'`);
    const ea = (await lease.tryAcquire('a', 0, 60_000))!;
    const a = await host('a', () => ea, clock);
    await a.h.reconcile([daily]);
    clock.now = Date.parse('2026-11-06T03:00:30Z');
    const [ra, rb] = await Promise.allSettled([a.h.tick(), b.h.tick()]);
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect((rb as PromiseRejectedResult).reason.message).toMatch(/lease|holder/);
    await expect.poll(() => a.broker.created.length + b.broker.created.length).toBe(1);
    expect(a.broker.created).toHaveLength(1);
    const runs = await t!.pool.query(`SELECT count(*)::int AS n FROM ${t!.schema}.runs`);
    expect(runs.rows[0].n).toBe(1);
  });

  it('a run on a host that loses the lease records nothing after the takeover', async () => {
    const lease = await setup();
    let ea: number | null = (await lease.tryAcquire('a', 0, 60_000))!;
    const clock = { now: Date.parse('2026-11-06T02:00:00Z') };
    const a = await host('a', () => ea, clock);
    await a.h.reconcile([daily]);
    clock.now = Date.parse('2026-11-06T03:00:30Z');
    await a.h.tick();
    await expect.poll(() => a.broker.created.length).toBe(1);
    await t!.pool.query(`UPDATE ${t!.schema}.host_lease SET holder = 'b', epoch = epoch + 1, expires_at = clock_timestamp() + interval '1 minute'`);
    ea = null;
    await a.broker.ops.attach(a.broker.created[0].id, { onHistory() {}, onOutput() {}, onEnded() {}, onGone() {} }).then(async (r) => { if (r.ok) await r.upstream.closeSession(); });
    await new Promise((r) => setTimeout(r, 3_000));
    const rows = await t!.pool.query(`SELECT status, ended_at FROM ${t!.schema}.runs`);
    expect(rows.rows).toEqual([{ status: 'running', ended_at: null }]);
    const steps = await t!.pool.query(`SELECT status FROM ${t!.schema}.step_runs`);
    expect(steps.rows).toEqual([{ status: 'running' }]);
  }, 20_000);

  it('a host that lost the lease starts no session: the spawn re-check is fenced', async () => {
    const lease = await setup();
    let ea: number | null = (await lease.tryAcquire('a', 0, 60_000))!;
    const clock = { now: Date.parse('2026-11-06T02:00:00Z') };
    const a = await host('a', () => ea, clock);
    await a.h.reconcile([daily]);
    // The lease goes after the step row is written, before the session starts.
    let started = 0;
    const startStep = AutomationStore.prototype.startStep;
    const spy = vi.spyOn(AutomationStore.prototype, 'startStep').mockImplementation(async function (this: AutomationStore, ...args) {
      const id = await startStep.apply(this, args);
      started++;
      ea = null;
      return id;
    });
    clock.now = Date.parse('2026-11-06T03:00:30Z');
    try {
      await a.h.tick();
      await a.h.automations.settle();
    } finally {
      spy.mockRestore();
    }
    expect(started).toBe(1);
    expect(a.broker.created).toEqual([]);
  });
});
