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
