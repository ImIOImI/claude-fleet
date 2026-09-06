import { describe, expect, it } from 'vitest';
import { syncKeyedCache } from './syncCache.js';

describe('syncKeyedCache', () => {
  it('computes once per key and serves hits without recomputing', () => {
    let calls = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8 });
    expect(c.get('a', () => { calls += 1; return 42; })).toBe(42);
    expect(c.get('a', () => { calls += 1; return 99; })).toBe(42);
    expect(calls).toBe(1);
  });

  it('caches null and undefined results too (a miss is not "falsy")', () => {
    let calls = 0;
    const c = syncKeyedCache<number | null>({ maxEntries: 8 });
    expect(c.get('a', () => { calls += 1; return null; })).toBeNull();
    expect(c.get('a', () => { calls += 1; return null; })).toBeNull();
    expect(calls).toBe(1);
  });

  it('invalidate(key) forces recompute for that key only', () => {
    let a = 0; let b = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8 });
    c.get('a', () => { a += 1; return a; });
    c.get('b', () => { b += 1; return b; });
    c.invalidate('a');
    expect(c.get('a', () => { a += 1; return a; })).toBe(2);
    expect(c.get('b', () => { b += 1; return b; })).toBe(1);
  });

  it('clear() drops everything', () => {
    let calls = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8 });
    c.get('a', () => { calls += 1; return 1; });
    c.clear();
    c.get('a', () => { calls += 1; return 1; });
    expect(calls).toBe(2);
  });

  it('exceeding maxEntries clears the whole cache (cap-clear, no LRU)', () => {
    let recomputes = 0;
    const c = syncKeyedCache<number>({ maxEntries: 2 });
    c.get('a', () => 1);
    c.get('b', () => 2);
    c.get('c', () => 3); // third insert exceeds the cap → everything cleared, then 'c' cached
    c.get('a', () => { recomputes += 1; return 1; });
    expect(recomputes).toBe(1); // 'a' was evicted by the clear
    c.get('c', () => { recomputes += 1; return 3; });
    expect(recomputes).toBe(1); // 'c' survived (it was inserted after the clear)
  });

  it('ttlMs expires entries (fake clock)', () => {
    let t = 1000; let calls = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8, ttlMs: 500, now: () => t });
    c.get('a', () => { calls += 1; return 1; });
    t = 1499;
    c.get('a', () => { calls += 1; return 1; });
    expect(calls).toBe(1);
    t = 1500;
    c.get('a', () => { calls += 1; return 1; });
    expect(calls).toBe(2);
  });

  it('a compute() that throws caches nothing', () => {
    let calls = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8 });
    expect(() => c.get('a', () => { calls += 1; throw new Error('boom'); })).toThrow('boom');
    expect(c.get('a', () => { calls += 1; return 7; })).toBe(7);
    expect(calls).toBe(2);
  });
});

describe('markStale', () => {
  it('is a no-op for missing keys', () => {
    let t = 0;
    const c = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => t });
    c.markStale('absent', 1_000); // must not throw or create an entry
    let computes = 0;
    c.get('absent', () => ++computes);
    expect(computes).toBe(1);
  });

  it('caps remaining lifetime without extending it', () => {
    let t = 0;
    const c = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => t });
    let computes = 0;
    c.get('k', () => ++computes);            // cached at t=0, TTL horizon 30s
    t = 1_000;
    c.markStale('k', 3_000);                 // stale horizon now t=4000
    t = 2_000;
    c.markStale('k', 10_000);                // t=12000 later than t=4000 → must NOT extend
    t = 3_999;
    c.get('k', () => ++computes);
    expect(computes).toBe(1);                // still fresh
    t = 4_000;
    c.get('k', () => ++computes);
    expect(computes).toBe(2);                // stale horizon hit → recompute
    t = 5_000;
    c.get('k', () => ++computes);
    expect(computes).toBe(2);                // recompute cleared the cap
  });

  it('the tighter of TTL and stale horizon wins', () => {
    let t = 0;
    const c = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 5_000, now: () => t });
    let computes = 0;
    c.get('k', () => ++computes);            // TTL horizon t=5000
    t = 1_000;
    c.markStale('k', 10_000);                // stale horizon t=11000 — TTL is tighter
    t = 5_000;
    c.get('k', () => ++computes);
    expect(computes).toBe(2);                // TTL still expired it at t=5000
  });

  // The #383 storm, reproduced: an event every 200ms + a poll every 1500ms
  // for a simulated 60s. invalidate-per-event (the shipped policy) recomputes
  // on EVERY poll; markStale(3s) bounds recomputes to the grace cadence.
  it('reproduces the recompute storm and bounds it', () => {
    let t = 0;
    const now = (): number => t;
    const old = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now });
    const fixed = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now });
    let oldComputes = 0;
    let fixedComputes = 0;
    for (t = 0; t <= 60_000; t += 100) {
      if (t % 200 === 0) {
        old.invalidate('s');
        fixed.markStale('s', 3_000);
      }
      if (t % 1_500 === 0) {
        old.get('s', () => ++oldComputes);
        fixed.get('s', () => ++fixedComputes);
      }
    }
    expect(oldComputes).toBe(41);            // every one of the 41 polls recomputed
    // Fixed cadence: recompute at t=0, then each stale horizon lands mid-poll-
    // gap so the next 1.5s-grid poll at +4.5s recomputes → 0,4500,…,58500.
    expect(fixedComputes).toBe(14);
    expect(fixedComputes).toBeLessThanOrEqual(60_000 / 3_000 + 1);
  });
});
