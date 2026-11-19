import { describe, expect, it } from 'vitest';
import type { BrokerState } from '../main/broker.js';
import { EventHub } from './events.js';
import { createLogger } from './log.js';
import { startDrainGate, type GatePhase } from './drainGate.js';
import { fakeBroker } from './testFakes.js';

const st = (phase: BrokerState['phase'], instance = 'i1', sessions: BrokerState['sessions'] = []): BrokerState =>
  ({ instance, phase, sessions, ...(phase !== 'serving' ? { softAt: 100, hardAt: 200 } : {}) });

function rig(opts: { legacyMs?: number } = {}) {
  const broker = fakeBroker([]);
  const events = new EventHub();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  events.add({ send: (t) => sent.push(JSON.parse(t)) });
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { fn, ms, live: true };
    timers.push(t);
    return () => { t.live = false; };
  };
  const fire = (ms: number) => { for (const t of timers.filter((x) => x.live && x.ms === ms)) { t.live = false; t.fn(); } };
  const gate = startDrainGate({ ops: broker.ops, log: createLogger(() => undefined), events, schedule, legacyMs: opts.legacyMs ?? 5000, retryMs: 1000, retryMaxMs: 4000 });
  const drain = () => sent.filter((e) => e.channel === 'broker:drain').map((e) => e.payload);
  return { broker, gate, drain, fire, timers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('DrainGate', () => {
  it('starts unknown, follows STATE, publishes sticky phases, remembers end reasons', async () => {
    const { broker, gate, drain } = rig();
    expect(gate.phase()).toBe('unknown');
    await tick();
    broker.pushState(st('serving'));
    expect(gate.phase()).toBe('serving');
    broker.pushState(st('draining', 'i1', [{ id: 'auto-R-s', alive: false, headless: true, ended: 'drain-interrupted' }]));
    expect(gate.phase()).toBe('draining');
    expect(gate.ended('auto-R-s')).toBe('drain-interrupted');
    broker.pushState(st('done'));
    expect(gate.phase()).toBe('draining');
    expect(drain()).toEqual([
      { phase: 'unknown', softAt: null, hardAt: null, instance: null },
      { phase: 'serving', softAt: null, hardAt: null, instance: 'i1' },
      { phase: 'draining', softAt: 100, hardAt: 200, instance: 'i1' }
    ]);
  });

  it('a dropped watch goes unknown and reconnects with doubling backoff; a new instance serves', async () => {
    const { broker, gate, fire, timers } = rig();
    await tick();
    broker.pushState(st('draining'));
    broker.setWatchable(false);
    broker.dropWatch();
    expect(gate.phase()).toBe('unknown');
    fire(1000);
    await tick();
    expect(timers.some((t) => t.live && t.ms === 2000)).toBe(true);
    broker.setWatchable(true);
    fire(2000);
    await tick();
    broker.pushState(st('serving', 'i2'));
    expect(gate.phase()).toBe('serving');
    expect(gate.last()?.instance).toBe('i2');
  });

  it('a broker that never sends STATE is legacy (treated as serving)', async () => {
    const { gate, fire, drain } = rig();
    await tick();
    fire(5000);
    expect(gate.phase()).toBe('legacy');
    expect(await gate.waitServing(10)).toBe(true);
    expect(drain().at(-1)).toEqual({ phase: 'serving', softAt: null, hardAt: null, instance: null });
  });

  it('a STATE before the legacy timer cancels it', async () => {
    const { broker, gate, fire } = rig();
    await tick();
    broker.pushState(st('draining'));
    fire(5000);
    expect(gate.phase()).toBe('draining');
  });

  it('a phase the codec mapped from an unknown value drains, as does done', async () => {
    const { broker, gate } = rig();
    await tick();
    broker.pushState(st('serving'));
    broker.pushState({ ...st('serving'), phase: 'weird' as BrokerState['phase'] });
    expect(gate.phase()).toBe('draining');
  });

  it('waitServing resolves when serving returns, or false after the bound', async () => {
    const { broker, gate, fire } = rig();
    await tick();
    broker.pushState(st('draining'));
    const seen: GatePhase[] = [];
    gate.subscribe((p) => seen.push(p));
    const w = gate.waitServing(60_000);
    broker.pushState(st('serving', 'i2'));
    expect(await w).toBe(true);
    broker.pushState(st('draining', 'i2'));
    const late = gate.waitServing(30_000);
    fire(30_000);
    expect(await late).toBe(false);
    expect(seen).toContain('serving');
  });

  it('stop closes the watch and schedules nothing more', async () => {
    const { broker, gate, timers } = rig();
    await tick();
    expect(broker.watchers.size).toBe(1);
    gate.stop();
    expect(broker.watchers.size).toBe(0);
    broker.dropWatch();
    expect(timers.filter((t) => t.live && t.ms === 1000)).toEqual([]);
  });

  it('without a watch op the gate is legacy at once', () => {
    const events = new EventHub();
    const gate = startDrainGate({ ops: {}, log: createLogger(() => undefined), events });
    expect(gate.phase()).toBe('legacy');
    gate.stop();
  });
});

describe('DrainGate watchdog', () => {
  it('a WATCH silent for 15 s after a STATE is closed and redialled; every STATE resets it', async () => {
    const { broker, gate, fire, timers } = rig();
    await tick();
    expect(timers.some((t) => t.live && t.ms === 15_000)).toBe(false);
    broker.pushState(st('draining'));
    const first = timers.find((t) => t.live && t.ms === 15_000)!;
    broker.pushState(st('draining'));
    expect(first.live).toBe(false);
    expect(timers.filter((t) => t.live && t.ms === 15_000)).toHaveLength(1);
    fire(15_000);
    expect(gate.phase()).toBe('unknown');
    expect(broker.watchers.size).toBe(0);
    expect(timers.some((t) => t.live && t.ms === 1000)).toBe(true);
    fire(1000);
    await tick();
    expect(broker.watchers.size).toBe(1);
    broker.pushState(st('serving', 'i2'));
    expect(gate.phase()).toBe('serving');
  });

  it('a legacy connection that never sent STATE is exempt', async () => {
    const { broker, gate, fire, timers } = rig();
    await tick();
    fire(5000);
    expect(gate.phase()).toBe('legacy');
    expect(timers.some((t) => t.live && t.ms === 15_000)).toBe(false);
    expect(broker.watchers.size).toBe(1);
  });

  it('a close after the watchdog fired is ignored', async () => {
    const { broker, gate, fire, timers } = rig();
    await tick();
    broker.pushState(st('serving'));
    const h = [...broker.watchers][0];
    const seen: GatePhase[] = [];
    gate.subscribe((p) => seen.push(p));
    fire(15_000);
    h.onClose();
    expect(seen).toEqual(['unknown']);
    expect(timers.filter((t) => t.live && t.ms === 1000)).toHaveLength(1);
    expect(gate.phase()).toBe('unknown');
  });
});

describe('DrainGate edge cases', () => {
  it('a watch that closes before it resolves never turns legacy', async () => {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const schedule = (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => { t.live = false; };
    };
    const ops = { watch: async (h: { onState(s: BrokerState): void; onClose(): void }) => { h.onClose(); return { stop: () => undefined }; } };
    const gate = startDrainGate({ ops, log: createLogger(() => undefined), events: new EventHub(), schedule });
    await tick();
    expect(timers.some((t) => t.live && t.ms === 5000)).toBe(false);
    expect(gate.phase()).toBe('unknown');
    gate.stop();
  });
});
