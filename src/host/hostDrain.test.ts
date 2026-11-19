import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerState } from '../main/broker.js';
import { APP_QUIT_MID_RUN } from '../main/automations/automationStore.js';
import type { GatePhase } from './drainGate.js';
import { memoryDrainStore } from './drainStore.js';
import { freshRunId, startHostDrain } from './hostDrain.js';
import { createLogger } from './log.js';
import { closeHostAutomationsRigs, hostAutomationsRig } from './testHostAutomations.js';

afterEach(closeHostAutomationsRigs);

function fakeGate(initial: GatePhase = 'serving') {
  let phase = initial;
  const subs = new Set<(p: GatePhase, s: BrokerState | null) => void>();
  return {
    phase: () => phase,
    subscribe: (fn: (p: GatePhase, s: BrokerState | null) => void) => { subs.add(fn); return () => subs.delete(fn); },
    push(p: GatePhase, s: BrokerState | null) { phase = p; for (const fn of [...subs]) fn(p, s); }
  };
}
const owners = (m: Record<string, string>) => ({ latestSessionOf: async (ids: readonly string[]) => new Map(ids.filter((i) => m[i]).map((i) => [i, m[i]])) });
const quiet = createLogger(() => undefined);
const draining = (instance: string, sessions: BrokerState['sessions']): BrokerState => ({ instance, phase: 'draining', sessions });
const ann = { kind: 'user' as const, id: 'ann' };

describe('freshRunId', () => {
  it('parses auto-<ULID>-<step> only', () => {
    expect(freshRunId('auto-01JC0000000000000000000000-review')).toBe('01JC0000000000000000000000');
    expect(freshRunId('tab-1')).toBeNull();
    expect(freshRunId('auto-short-review')).toBeNull();
    expect(freshRunId('auto-01JC0000000000000000000000-')).toBeNull();
  });
});

describe('host drain hooks', () => {
  it('queues one re-run for a drain-cut fresh step and starts it once when the new broker serves', async () => {
    const r = await hostAutomationsRig();
    const a = await r.createFreshAutomation('review');
    const run = await r.runtime.automations.run(a.id, { kind: 'manual', by: ann, args: {} });
    const sid = `auto-${run.id}-review`;
    await r.untilCreated(sid);
    const gate = fakeGate();
    const drains = memoryDrainStore();
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({}), log: quiet });
    r.gate.cut(sid, 'drain-interrupted');
    gate.push('draining', draining('i1', [{ id: sid, alive: false, headless: true, ended: 'drain-interrupted' }]));
    await r.runtime.automations.settle();
    await h.idle();
    expect(await r.runtime.store.getRun(run.id)).toMatchObject({ status: 'interrupted', error: 'review: interrupted by host restart' });
    gate.push('serving', { instance: 'i2', phase: 'serving', sessions: [] });
    await h.idle();
    gate.push('draining', draining('i2', [{ id: sid, alive: false, headless: true, ended: 'drain-interrupted' }]));
    gate.push('serving', { instance: 'i3', phase: 'serving', sessions: [] });
    await h.idle();
    const retries = (await r.runtime.store.runs(a.id, 10)).filter((x) => x.trigger.retryOf === run.id);
    expect(retries).toHaveLength(1);
    expect(retries[0].trigger).toMatchObject({ kind: 'manual', by: ann, retryOf: run.id });
    await r.untilCreated(`auto-${retries[0].id}-review`);
    await h.stop();
  });

  it('never re-runs a re-run, and skips a stale, finished or disabled original', async () => {
    const r = await hostAutomationsRig();
    const a = await r.createFreshAutomation('review');
    const off = await r.createFreshAutomation('review', 'off');
    await r.runtime.automations.setEnabled(off.id, false);
    const drains = memoryDrainStore();
    let t = 10;
    const gate = fakeGate('draining');
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({}), log: quiet, now: () => t });
    const cut = (id: string): BrokerState['sessions'][number] => ({ id: `auto-${id}-review`, alive: false, headless: true, ended: 'drain-killed' });
    const done = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'succeeded', 1);
    const retry = await r.runtime.store.startRun(a.raw, { kind: 'manual', retryOf: 'X' }, {}, 'interrupted', 2);
    const disabled = await r.runtime.store.startRun(off.raw, { kind: 'manual' }, {}, 'interrupted', 3);
    gate.push('draining', draining('i1', [cut(done.id), cut(retry.id), cut(disabled.id)]));
    await h.idle();
    expect(await drains.markRetry(retry.id, a.id, t)).toBe(true);
    gate.push('serving', { instance: 'i2', phase: 'serving', sessions: [] });
    await h.idle();
    const stale = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'interrupted', 4);
    gate.push('draining', draining('i2', [cut(stale.id)]));
    await h.idle();
    t = 10 + 24 * 3_600_000 + 1;
    gate.push('serving', { instance: 'i3', phase: 'serving', sessions: [] });
    await h.idle();
    const runs = [...(await r.runtime.store.runs(a.id, 10)), ...(await r.runtime.store.runs(off.id, 10))];
    expect(runs.filter((x) => x.trigger.retryOf && x.trigger.retryOf !== 'X')).toEqual([]);
    expect(r.broker.created).toEqual([]);
    await h.stop();
  });

  it('a host restart mid-drain: recover() reason is rewritten and the re-run queued when the drain ends it', async () => {
    const r = await hostAutomationsRig();
    const a = await r.createFreshAutomation('review');
    const cutRun = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'interrupted', 1, APP_QUIT_MID_RUN);
    const finished = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'interrupted', 2, APP_QUIT_MID_RUN);
    const drains = memoryDrainStore();
    const gate = fakeGate('draining');
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({}), log: quiet, now: () => 5 });
    gate.push('draining', draining('i1', [
      { id: `auto-${cutRun.id}-review`, alive: false, headless: true, ended: 'drain-interrupted' },
      { id: `auto-${finished.id}-review`, alive: false, headless: true, ended: 'exit' }
    ]));
    await h.idle();
    expect((await r.runtime.store.getRun(cutRun.id))!.error).toBe('interrupted by host restart');
    expect((await r.runtime.store.getRun(finished.id))!.error).toBe(APP_QUIT_MID_RUN);
    gate.push('serving', { instance: 'i2', phase: 'serving', sessions: [] });
    await h.idle();
    const runs = await r.runtime.store.runs(a.id, 10);
    expect(runs.filter((x) => x.trigger.retryOf === cutRun.id)).toHaveLength(1);
    expect(runs.filter((x) => x.trigger.retryOf === finished.id)).toHaveLength(0);
    await h.stop();
  });

  it('a pending re-run whose original still reads running is skipped with a warning', async () => {
    const r = await hostAutomationsRig();
    const a = await r.createFreshAutomation('review');
    const run = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'running', 1);
    const drains = memoryDrainStore();
    await drains.markRetry(run.id, a.id, 1);
    const lines: Array<{ level: string; msg: string }> = [];
    const log = createLogger((l) => lines.push(JSON.parse(l)));
    const h = startHostDrain({ gate: fakeGate('serving'), drains, automations: r.runtime, owners: owners({}), log, now: () => 5 });
    await h.idle();
    expect(lines.filter((l) => l.msg === 'automation re-run skipped').map((l) => l.level)).toEqual(['warn']);
    await h.stop();
  });

  it('a session a viewer named like a run (not headless) queues nothing', async () => {
    const r = await hostAutomationsRig();
    const a = await r.createFreshAutomation('review');
    const run = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'interrupted', 1, APP_QUIT_MID_RUN);
    const drains = memoryDrainStore();
    const gate = fakeGate('draining');
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({}), log: quiet, now: () => 5 });
    gate.push('draining', draining('i1', [{ id: `auto-${run.id}-review`, alive: false, ended: 'drain-interrupted' }]));
    await h.idle();
    expect(await drains.markRetry(run.id, a.id, 6)).toBe(true);
    expect((await r.runtime.store.getRun(run.id))!.error).toBe(APP_QUIT_MID_RUN);
    await h.stop();
  });

  it('a failed write is retried on the next STATE', async () => {
    const r = await hostAutomationsRig();
    const a = await r.createFreshAutomation('review');
    const run = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'interrupted', 1, APP_QUIT_MID_RUN);
    const drains = memoryDrainStore();
    let fail = true;
    const markRetry = drains.markRetry.bind(drains);
    drains.markRetry = async (...x) => { if (fail) throw new Error('fenced off'); return markRetry(...x); };
    const gate = fakeGate('draining');
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({}), log: quiet, now: () => 5 });
    const st = draining('i1', [{ id: `auto-${run.id}-review`, alive: false, headless: true, ended: 'drain-killed' }]);
    gate.push('draining', st);
    await h.idle();
    fail = false;
    gate.push('draining', st);
    await h.idle();
    expect(await drains.markRetry(run.id, a.id, 6)).toBe(false);
    await h.stop();
  });

  it('a lookup error on one claimed row settles it skipped and still dispatches the rest', async () => {
    const r = await hostAutomationsRig();
    const a = await r.createFreshAutomation('review');
    const bad = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'interrupted', 1);
    const good = await r.runtime.store.startRun(a.raw, { kind: 'manual' }, {}, 'interrupted', 2);
    const drains = memoryDrainStore();
    await drains.markRetry(bad.id, a.id, 3);
    await drains.markRetry(good.id, a.id, 3);
    const settled: Array<[string, unknown]> = [];
    const settle = drains.settle.bind(drains);
    drains.settle = async (id, o, n) => { settled.push([id, o]); return settle(id, o, n); };
    const getRun = r.runtime.store.getRun.bind(r.runtime.store);
    r.runtime.store.getRun = async (id) => { if (id === bad.id) throw new Error('db hiccup'); return getRun(id); };
    const gate = fakeGate('draining');
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({}), log: quiet, now: () => 4 });
    gate.push('serving', { instance: 'i2', phase: 'serving', sessions: [] });
    await h.idle();
    expect(settled).toContainEqual([bad.id, { skipped: 'db hiccup' }]);
    const retries = (await r.runtime.store.runs(a.id, 10)).filter((x) => x.trigger.retryOf === good.id);
    expect(retries).toHaveLength(1);
    await r.untilCreated(`auto-${retries[0].id}-review`);
    await h.stop();
  });

  it('records drained interactive sessions (not auto-, mapped through owners) while draining', async () => {
    const r = await hostAutomationsRig();
    const drains = memoryDrainStore();
    const gate = fakeGate();
    const h = startHostDrain({ gate, drains, automations: r.runtime, owners: owners({ tab1: 'c1', tab2: 'c2', tab3: 'c3' }), log: quiet, now: () => 500 });
    gate.push('serving', { instance: 'i1', phase: 'serving', sessions: [{ id: 'tab1', alive: true }] });
    await h.idle();
    expect(await drains.drained(0, 10)).toEqual([]);
    gate.push('draining', draining('i1', [
      { id: 'tab1', alive: true }, { id: 'tab2', alive: false, ended: 'drain-idle' }, { id: 'tab3', alive: false, ended: 'exit' },
      { id: 'auto-01JC0000000000000000000000-review', alive: true, headless: true }, { id: 'tab4', alive: true }
    ]));
    await h.idle();
    expect((await drains.drained(0, 10)).map((x) => [x.brokerSessionId, x.sessionId]).sort()).toEqual([['tab1', 'c1'], ['tab2', 'c2']]);
    await h.stop();
  });
});
