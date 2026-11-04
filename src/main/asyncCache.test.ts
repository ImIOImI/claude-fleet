import { describe, expect, it } from 'vitest';
import { asyncKeyedCache } from './asyncCache.js';

/** A compute whose promise the test settles by hand. */
function deferred<V>(): { promise: Promise<V>; resolve: (v: V) => void; reject: (e: Error) => void } {
  let resolve!: (v: V) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<V>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('asyncKeyedCache', () => {
  it('computes once per key and serves hits without recomputing', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    expect(await c.get('a', async () => { calls += 1; return 42; })).toBe(42);
    expect(await c.get('a', async () => { calls += 1; return 99; })).toBe(42);
    expect(calls).toBe(1);
  });

  it('caches null results too (a miss is not "falsy")', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number | null>({ maxEntries: 8 });
    expect(await c.get('a', async () => { calls += 1; return null; })).toBeNull();
    expect(await c.get('a', async () => { calls += 1; return null; })).toBeNull();
    expect(calls).toBe(1);
  });

  it('invalidate(key) forces recompute for that key only', async () => {
    let a = 0; let b = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    await c.get('a', async () => ++a);
    await c.get('b', async () => ++b);
    c.invalidate('a');
    expect(await c.get('a', async () => ++a)).toBe(2);
    expect(await c.get('b', async () => ++b)).toBe(1);
  });

  it('clear() drops everything', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    await c.get('a', async () => ++calls);
    c.clear();
    await c.get('a', async () => ++calls);
    expect(calls).toBe(2);
  });

  it('exceeding maxEntries clears the whole cache (cap-clear, no LRU)', async () => {
    let recomputes = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 2 });
    await c.get('a', async () => 1);
    await c.get('b', async () => 2);
    await c.get('c', async () => 3);
    await c.get('a', async () => { recomputes += 1; return 1; });
    expect(recomputes).toBe(1);
    await c.get('c', async () => { recomputes += 1; return 3; });
    expect(recomputes).toBe(1);
  });

  it('ttlMs expires entries (fake clock)', async () => {
    let t = 1000; let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8, ttlMs: 500, now: () => t });
    await c.get('a', async () => ++calls);
    t = 1499;
    await c.get('a', async () => ++calls);
    expect(calls).toBe(1);
    t = 1500;
    await c.get('a', async () => ++calls);
    expect(calls).toBe(2);
  });

  it('a rejected compute rejects every sharer and caches nothing', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    const d = deferred<number>();
    const first = c.get('a', () => { calls += 1; return d.promise; });
    const second = c.get('a', async () => { calls += 1; return 5; });
    d.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(await c.get('a', async () => { calls += 1; return 7; })).toBe(7);
    expect(calls).toBe(2);
  });

  it('a compute that throws synchronously rejects and caches nothing', async () => {
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    await expect(c.get('a', () => { throw new Error('sync boom'); })).rejects.toThrow('sync boom');
    expect(await c.get('a', async () => 7)).toBe(7);
  });
});

describe('in-flight semantics', () => {
  it('concurrent misses on one key share a single compute', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    const d = deferred<number>();
    const p1 = c.get('a', () => { calls += 1; return d.promise; });
    const p2 = c.get('a', () => { calls += 1; return Promise.resolve(2); });
    expect(p2).toBe(p1);
    d.resolve(1);
    expect(await Promise.all([p1, p2])).toEqual([1, 1]);
    expect(calls).toBe(1);
  });

  it('an invalidate during the compute wins: the result is returned, not stored', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    const d = deferred<number>();
    const stale = c.get('a', () => { calls += 1; return d.promise; });
    c.invalidate('a');
    const fresh = c.get('a', async () => { calls += 1; return 2; });
    expect(fresh).not.toBe(stale);
    d.resolve(1);
    expect(await stale).toBe(1);
    expect(await fresh).toBe(2);
    expect(await c.get('a', async () => { calls += 1; return 3; })).toBe(2);
    expect(calls).toBe(2);
  });

  it('a clear during the compute wins the same way', async () => {
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    const d = deferred<number>();
    const stale = c.get('a', () => d.promise);
    c.clear();
    d.resolve(1);
    expect(await stale).toBe(1);
    expect(await c.get('a', async () => 2)).toBe(2);
  });

  it('a markStale during the compute caps the stored result', async () => {
    let t = 0; let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8, ttlMs: 30_000, now: () => t });
    const d = deferred<number>();
    const p = c.get('a', () => { calls += 1; return d.promise; });
    c.markStale('a', 3_000);
    d.resolve(1);
    await p;
    t = 2_999;
    expect(await c.get('a', async () => { calls += 1; return 2; })).toBe(1);
    t = 3_000;
    expect(await c.get('a', async () => { calls += 1; return 2; })).toBe(2);
    expect(calls).toBe(2);
  });
});

describe('markStale', () => {
  it('is a no-op for missing keys', async () => {
    const c = asyncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => 0 });
    c.markStale('absent', 1_000);
    let computes = 0;
    await c.get('absent', async () => ++computes);
    expect(computes).toBe(1);
  });

  it('caps remaining lifetime without extending it', async () => {
    let t = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => t });
    let computes = 0;
    await c.get('k', async () => ++computes);
    t = 1_000;
    c.markStale('k', 3_000);
    t = 2_000;
    c.markStale('k', 10_000);
    t = 3_999;
    await c.get('k', async () => ++computes);
    expect(computes).toBe(1);
    t = 4_000;
    await c.get('k', async () => ++computes);
    expect(computes).toBe(2);
    t = 5_000;
    await c.get('k', async () => ++computes);
    expect(computes).toBe(2);
  });

  it('the tighter of TTL and stale horizon wins', async () => {
    let t = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 4, ttlMs: 5_000, now: () => t });
    let computes = 0;
    await c.get('k', async () => ++computes);
    t = 1_000;
    c.markStale('k', 10_000);
    t = 5_000;
    await c.get('k', async () => ++computes);
    expect(computes).toBe(2);
  });

  // The #383 storm: an event every 200ms + a poll every 1500ms for 60s.
  it('bounds the recompute storm to the grace cadence', async () => {
    let t = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => t });
    let computes = 0;
    for (t = 0; t <= 60_000; t += 100) {
      if (t % 200 === 0) c.markStale('s', 3_000);
      if (t % 1_500 === 0) await c.get('s', async () => ++computes);
    }
    expect(computes).toBe(14);
  });
});
