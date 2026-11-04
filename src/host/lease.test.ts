import { describe, expect, it, vi } from 'vitest';
import { LeaseManager, memoryLeaseStore, type LeaseStore } from './lease.js';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('memoryLeaseStore', () => {
  it('admits one holder until expiry, bumping the epoch on each take', async () => {
    const s = memoryLeaseStore();
    expect(await s.tryAcquire('a', 0, 30)).toBe(1);
    expect(await s.tryAcquire('b', 10, 30)).toBeNull();
    expect(await s.tryAcquire('b', 30, 30)).toBe(2);
    expect(await s.renew('a', 1, 31, 30)).toBe(false);
    expect(await s.renew('b', 2, 31, 30)).toBe(true);
  });

  it('renew is fenced by epoch, not just holder name', async () => {
    const s = memoryLeaseStore();
    expect(await s.tryAcquire('a', 0, 30)).toBe(1);
    expect(await s.tryAcquire('a', 30, 30)).toBe(2);
    expect(await s.renew('a', 1, 31, 30)).toBe(false);
  });

  it('release frees the lease only for the current holder and epoch', async () => {
    const s = memoryLeaseStore();
    await s.tryAcquire('a', 0, 30);
    await s.release('a', 99);
    expect(await s.tryAcquire('b', 1, 30)).toBeNull();
    await s.release('a', 1);
    expect(await s.tryAcquire('b', 1, 30)).toBe(2);
  });
});

describe('LeaseManager', () => {
  it('starts standby and becomes holder on the first tick', async () => {
    const c = clock();
    const m = new LeaseManager({ holder: 'a', store: memoryLeaseStore(), now: c.now, monotonic: c.now });
    const acquired = vi.fn();
    m.on('acquired', acquired);
    expect(m.state).toBe('standby');
    await m.tick();
    expect(m.state).toBe('holder');
    expect(acquired).toHaveBeenCalledWith(1);
  });

  it('a second manager stays standby while the first renews', async () => {
    const c = clock();
    const store = memoryLeaseStore();
    const a = new LeaseManager({ holder: 'a', store, now: c.now, monotonic: c.now });
    const b = new LeaseManager({ holder: 'b', store, now: c.now, monotonic: c.now });
    await a.tick();
    for (let i = 0; i < 5; i++) {
      c.advance(10_000);
      await a.tick();
      await b.tick();
    }
    expect(a.state).toBe('holder');
    expect(b.state).toBe('standby');
  });

  it('takes over within one tick after the holder releases', async () => {
    const c = clock();
    const store = memoryLeaseStore();
    const a = new LeaseManager({ holder: 'a', store, now: c.now, monotonic: c.now });
    const b = new LeaseManager({ holder: 'b', store, now: c.now, monotonic: c.now });
    await a.tick();
    await a.stop();
    await b.tick();
    expect(b.state).toBe('holder');
    expect(b.epoch).toBe(2);
  });

  it('emits lost and halts when a renew is refused', async () => {
    const c = clock();
    const store = memoryLeaseStore();
    const a = new LeaseManager({ holder: 'a', store, now: c.now, monotonic: c.now });
    const lost = vi.fn();
    a.on('lost', lost);
    await a.tick();
    c.advance(31_000);
    expect(await store.tryAcquire('b', c.now(), 30_000)).toBe(2);
    await a.tick();
    expect(lost).toHaveBeenCalledOnce();
    expect(a.state).toBe('standby');
    c.advance(31_000);
    await a.tick();
    expect(a.state).toBe('standby');
  });

  it('survives store errors until its own TTL runs out, then loses', async () => {
    const c = clock();
    const inner = memoryLeaseStore();
    let failing = false;
    const store: LeaseStore = {
      tryAcquire: (...a) => inner.tryAcquire(...a),
      renew: async (...a) => {
        if (failing) throw new Error('db down');
        return inner.renew(...a);
      },
      release: (...a) => inner.release(...a)
    };
    const onError = vi.fn();
    const m = new LeaseManager({ holder: 'a', store, now: c.now, monotonic: c.now, onError });
    const lost = vi.fn();
    m.on('lost', lost);
    await m.tick();
    failing = true;
    c.advance(10_000);
    await m.tick();
    expect(m.state).toBe('holder');
    c.advance(20_000);
    await m.tick();
    expect(lost).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('loses about one renew interval before the TTL (safety margin)', async () => {
    const c = clock();
    const store = memoryLeaseStore();
    const m = new LeaseManager({ holder: 'a', store, now: c.now, monotonic: c.now, renewMs: 10_000, ttlMs: 30_000 });
    const lost = vi.fn();
    m.on('lost', lost);
    await m.tick();
    store.renew = async () => { throw new Error('db down'); };
    c.advance(20_000);
    await m.tick();
    expect(lost).toHaveBeenCalledOnce();
  });

  it('judges its deadline on the monotonic clock, not wall time', async () => {
    const wall = clock();
    const mono = clock();
    const store = memoryLeaseStore();
    const m = new LeaseManager({ holder: 'a', store, now: wall.now, monotonic: mono.now });
    await m.tick();
    store.renew = async () => { throw new Error('db down'); };
    wall.advance(3_600_000);
    mono.advance(10_000);
    await m.tick();
    expect(m.state).toBe('holder');
  });

  it('a hung renew loses at the deadline, and the hung tick settles', async () => {
    const inner = memoryLeaseStore();
    const store: LeaseStore = { ...inner, renew: () => new Promise<boolean>(() => undefined) };
    const m = new LeaseManager({ holder: 'a', store, renewMs: 20, ttlMs: 80 });
    const lost = vi.fn();
    m.on('lost', lost);
    await m.tick();
    const pending = m.tick();
    const settled = await Promise.race([pending.then(() => 'settled'), sleep(300).then(() => 'hung')]);
    expect(settled).toBe('settled');
    expect(lost).toHaveBeenCalledOnce();
    expect(m.state).toBe('standby');
  });

  it('a store timeout loses even if the timer fires just short of the deadline', async () => {
    const inner = memoryLeaseStore();
    const store: LeaseStore = { ...inner, renew: () => new Promise<boolean>(() => undefined) };
    const frozen = () => 0;
    const m = new LeaseManager({ holder: 'a', store, monotonic: frozen, renewMs: 20, ttlMs: 80 });
    const lost = vi.fn();
    m.on('lost', lost);
    await m.tick();
    await m.tick();
    expect(lost).toHaveBeenCalledOnce();
  });

  it('loses at the deadline even when no tick runs', async () => {
    const m = new LeaseManager({ holder: 'a', store: memoryLeaseStore(), renewMs: 20, ttlMs: 80 });
    const lost = vi.fn();
    m.on('lost', lost);
    await m.tick();
    await sleep(150);
    expect(lost).toHaveBeenCalledOnce();
    expect(m.state).toBe('standby');
  });

  it('stop() releases promptly while a renew hangs', async () => {
    const inner = memoryLeaseStore();
    const release = vi.fn(inner.release);
    const store: LeaseStore = { ...inner, release, renew: () => new Promise<boolean>(() => undefined) };
    const m = new LeaseManager({ holder: 'a', store, renewMs: 10_000, ttlMs: 30_000, stopWaitMs: 20 });
    await m.tick();
    void m.tick();
    const t0 = performance.now();
    await m.stop();
    expect(performance.now() - t0).toBeLessThan(500);
    expect(release).toHaveBeenCalledWith('a', 1);
    expect(m.state).toBe('standby');
  });

  it('stop() returns promptly when release itself hangs', async () => {
    const inner = memoryLeaseStore();
    const store: LeaseStore = { ...inner, release: () => new Promise<void>(() => undefined) };
    const m = new LeaseManager({ holder: 'a', store, stopWaitMs: 20 });
    await m.tick();
    const t0 = performance.now();
    await m.stop();
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('never emits acquired once stopping, but still releases what it took', async () => {
    const inner = memoryLeaseStore();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const release = vi.fn(inner.release);
    const store: LeaseStore = { ...inner, release, tryAcquire: async (...a) => { await gate; return inner.tryAcquire(...a); } };
    const m = new LeaseManager({ holder: 'a', store });
    const acquired = vi.fn();
    m.on('acquired', acquired);
    const t = m.tick();
    const stopping = m.stop();
    finish();
    await t;
    await stopping;
    expect(acquired).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('a', 1);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
