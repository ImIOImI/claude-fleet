import { describe, it, expect } from 'vitest';
import { ttlCache } from './ttlCache.js';

/** Manually-advanced clock so tests never sleep. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** A fetcher whose settlement the test controls, counting invocations. */
function deferredFetcher<T>(): {
  fetch: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  calls: () => number;
} {
  let calls = 0;
  let settle!: { resolve: (v: T) => void; reject: (e: Error) => void };
  return {
    fetch: () => {
      calls++;
      return new Promise<T>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    resolve: (v) => settle.resolve(v),
    reject: (e) => settle.reject(e),
    calls: () => calls
  };
}

describe('ttlCache', () => {
  it('resolves to the fetched value', async () => {
    const clock = fakeClock();
    const cache = ttlCache(async () => 'value', 1000, clock.now);
    expect(await cache.get()).toBe('value');
  });

  it('serves a second get within the TTL from cache without refetching', async () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = ttlCache(
      async () => {
        calls++;
        return calls;
      },
      1000,
      clock.now
    );
    expect(await cache.get()).toBe(1);
    clock.advance(999);
    expect(await cache.get()).toBe(1);
    expect(calls).toBe(1);
  });

  it('refetches after the TTL expires', async () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = ttlCache(
      async () => {
        calls++;
        return calls;
      },
      1000,
      clock.now
    );
    expect(await cache.get()).toBe(1);
    clock.advance(1000);
    expect(await cache.get()).toBe(2);
    expect(calls).toBe(2);
  });

  it('shares one in-flight fetch across concurrent gets', async () => {
    const clock = fakeClock();
    const d = deferredFetcher<string>();
    const cache = ttlCache(d.fetch, 1000, clock.now);
    const a = cache.get();
    const b = cache.get();
    d.resolve('shared');
    expect(await a).toBe('shared');
    expect(await b).toBe('shared');
    expect(d.calls()).toBe(1);
  });

  it('does not stampede when the fetch outlives the TTL', async () => {
    const clock = fakeClock();
    const d = deferredFetcher<string>();
    const cache = ttlCache(d.fetch, 1000, clock.now);
    const a = cache.get();
    clock.advance(5000); // fetch still in flight, well past the TTL
    const b = cache.get();
    d.resolve('slow');
    expect(await a).toBe('slow');
    expect(await b).toBe('slow');
    expect(d.calls()).toBe(1);
  });

  it('starts the freshness window at resolution, not at fetch start', async () => {
    const clock = fakeClock();
    const d = deferredFetcher<string>();
    const cache = ttlCache(d.fetch, 1000, clock.now);
    const a = cache.get();
    clock.advance(5000); // slower than the TTL
    d.resolve('v1');
    expect(await a).toBe('v1');
    clock.advance(999); // within TTL of the *resolution*
    expect(await cache.get()).toBe('v1');
    expect(d.calls()).toBe(1);
  });

  it('does not cache a rejected fetch', async () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = ttlCache(
      async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'recovered';
      },
      1000,
      clock.now
    );
    await expect(cache.get()).rejects.toThrow('boom');
    expect(await cache.get()).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('invalidate() forces the next get to refetch within the TTL', async () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = ttlCache(
      async () => {
        calls++;
        return calls;
      },
      1000,
      clock.now
    );
    expect(await cache.get()).toBe(1);
    cache.invalidate();
    expect(await cache.get()).toBe(2);
  });

  it('invalidate() during a fetch still lets in-flight callers resolve, but the next get refetches', async () => {
    const clock = fakeClock();
    const d = deferredFetcher<string>();
    const cache = ttlCache(d.fetch, 1000, clock.now);
    const a = cache.get();
    cache.invalidate();
    const b = cache.get(); // must be a NEW fetch — the invalidated one may carry pre-mutation state
    expect(d.calls()).toBe(2);
    d.resolve('v2');
    expect(await b).toBe('v2');
    void a; // first promise settles whenever its (abandoned) fetch does
  });
});
