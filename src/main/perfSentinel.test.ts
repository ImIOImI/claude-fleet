import { afterEach, describe, expect, it } from 'vitest';
import {
  armSentinel, disarmSentinel, sentinelStatus, sentinelWindowFor,
  type SentinelWorkerLike
} from './perfSentinel.js';

type MsgCb = (win: { p50: number; p99: number; max: number }) => void;
type OnceCb = () => void;
function fakeWorker(): { worker: SentinelWorkerLike; emit: MsgCb; die: () => void; terminated: () => boolean } {
  let cb: MsgCb = () => {};
  let onceCbs: OnceCb[] = [];
  let terminated = false;
  return {
    worker: {
      on: (_e, c) => { cb = c; },
      once: (_e, c) => { onceCbs.push(c); },
      unref: () => {},
      terminate: () => { terminated = true; }
    },
    emit: (w) => cb(w),
    die: () => { for (const c of onceCbs) c(); },
    terminated: () => terminated
  };
}

afterEach(() => disarmSentinel());

describe('stall sentinel', () => {
  it('disarmed by default; sentinelWindowFor is null; status is empty', () => {
    expect(sentinelStatus()).toEqual({ enabled: false, startedAt: null, expiresAt: null, lastWorkerWindow: null, workerDead: false });
    expect(sentinelWindowFor(1000)).toBeNull();
  });

  it('armed: fresh worker windows produce aligned/unaligned verdicts', () => {
    const f = fakeWorker();
    let clock = 10_000;
    armSentinel(undefined, { workerFactory: () => f.worker, sampleIntervalMs: 5000, now: () => clock });
    f.emit({ p50: 2, p99: 10, max: 120 }); // worker stalled too
    clock = 11_000;
    expect(sentinelWindowFor(clock)).toEqual({ workerMaxMs: 120, aligned: true, ageMs: 1000 });
    f.emit({ p50: 2, p99: 10, max: 12 }); // worker healthy
    expect(sentinelWindowFor(clock)).toEqual({ workerMaxMs: 12, aligned: false, ageMs: 0 });
  });

  it('armed but window older than 2 intervals reports stale (starvation evidence itself)', () => {
    const f = fakeWorker();
    let clock = 10_000;
    armSentinel(undefined, { workerFactory: () => f.worker, sampleIntervalMs: 5000, now: () => clock });
    f.emit({ p50: 1, p99: 2, max: 3 });
    clock = 10_000 + 10_001; // > 2 × 5000
    expect(sentinelWindowFor(clock)).toEqual({ stale: true, ageMs: 10_001 });
  });

  it('armed with no window yet reports stale with age since start', () => {
    const f = fakeWorker();
    let clock = 10_000;
    armSentinel(undefined, { workerFactory: () => f.worker, sampleIntervalMs: 5000, now: () => clock });
    clock = 30_001; // silence > 2 intervals — worker never reported
    expect(sentinelWindowFor(clock)).toEqual({ stale: true, ageMs: 20_001 });
  });

  it('ttlHours sets expiresAt and re-arming resets it; disarm terminates the worker', () => {
    const f = fakeWorker();
    const clock = 50_000;
    armSentinel({ ttlHours: 1 }, { workerFactory: () => f.worker, now: () => clock });
    expect(sentinelStatus().expiresAt).toBe(clock + 3_600_000);
    const f2 = fakeWorker();
    armSentinel(undefined, { workerFactory: () => f2.worker, now: () => clock });
    expect(f.terminated()).toBe(true); // re-arm replaced the old worker
    expect(sentinelStatus().expiresAt).toBeNull();
    disarmSentinel();
    expect(f2.terminated()).toBe(true);
    expect(sentinelStatus().enabled).toBe(false);
  });

  it('smoke: a real worker thread reports at least one window', async () => {
    armSentinel(undefined, { sampleIntervalMs: 50 });
    await new Promise((r) => setTimeout(r, 400));
    const s = sentinelStatus();
    expect(s.enabled).toBe(true);
    expect(s.lastWorkerWindow).not.toBeNull();
    expect(s.lastWorkerWindow!.max).toBeGreaterThanOrEqual(0);
  });

  it('dead worker: sentinelWindowFor returns { dead: true } and sentinelStatus reports workerDead', () => {
    const f = fakeWorker();
    let clock = 10_000;
    armSentinel(undefined, { workerFactory: () => f.worker, sampleIntervalMs: 5000, now: () => clock });
    expect(sentinelStatus().workerDead).toBe(false);
    f.die();
    expect(sentinelWindowFor(clock)).toEqual({ dead: true });
    expect(sentinelStatus().workerDead).toBe(true);
  });

  it('dead worker: once callbacks do not fire for a replaced (re-armed) state', () => {
    const f = fakeWorker();
    let clock = 10_000;
    armSentinel(undefined, { workerFactory: () => f.worker, sampleIntervalMs: 5000, now: () => clock });
    const f2 = fakeWorker();
    armSentinel(undefined, { workerFactory: () => f2.worker, sampleIntervalMs: 5000, now: () => clock });
    // fire old worker's once — must NOT mark current state as dead
    f.die();
    expect(sentinelStatus().workerDead).toBe(false);
    expect(sentinelWindowFor(clock)).not.toEqual({ dead: true });
  });
});
