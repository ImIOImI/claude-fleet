import { describe, expect, it } from 'vitest';
import type { StoreStatus } from '../../preload/storeTypes.js';
import { StoreSupervisor, type SupervisorDeps } from './storeSupervisor.js';

/** sleep() parks until the test calls tick(). */
function clock() {
  const parked: Array<() => void> = [];
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => new Promise<void>((r) => { waits.push(ms); parked.push(r); }),
    /** Wait until the supervisor sleeps. */
    async parked() {
      for (let i = 0; i < 100 && parked.length === 0; i++) await new Promise((r) => setImmediate(r));
      if (parked.length === 0) throw new Error('the supervisor never slept');
    },
    /** End the current sleep, then wait for the next one. */
    async tick() {
      await this.parked();
      parked.shift()!();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

type Stores = { id: number };

function harness(over: Partial<SupervisorDeps<Stores>> = {}) {
  const c = clock();
  const calls: string[] = [];
  let opens = 0;
  const deps: SupervisorDeps<Stores> = {
    choice: 'managed',
    open: async () => { opens++; calls.push(`open ${opens}`); return { id: opens }; },
    prepare: async (_s, onProgress) => { onProgress({ source: 'state', table: 'events', copied: 5, total: 10 }); return null; },
    ready: async (s) => { calls.push(`ready ${s.id}`); },
    ping: async () => undefined,
    recovered: (s) => { calls.push(`recovered ${s.id}`); },
    close: async (s) => { calls.push(`close ${s.id}`); },
    log: (type) => { calls.push(`log ${type}`); },
    sleep: c.sleep,
    ...over,
  };
  const sup = new StoreSupervisor(deps);
  const seen: StoreStatus[] = [];
  sup.on('status', (s: StoreStatus) => seen.push(s));
  return { sup, c, calls, seen };
}

describe('StoreSupervisor', () => {
  it('starts in starting, reports import progress, then ready once', async () => {
    const { sup, calls, seen } = harness();
    expect(sup.status()).toMatchObject({ choice: 'managed', phase: 'starting' });
    void sup.run();
    const stores = await sup.whenReady();
    expect(stores).toEqual({ id: 1 });
    expect(seen.map((s) => s.phase)).toEqual(['importing', 'ready']);
    expect(seen[0].progress).toEqual({ source: 'state', table: 'events', copied: 5, total: 10 });
    expect(sup.status()).toMatchObject({ phase: 'ready', progress: null, detail: null });
    expect(calls).toEqual(['open 1', 'ready 1']);
    sup.stop();
  });

  it('an open failure is down with its reason and retries with doubling backoff', async () => {
    let n = 0;
    const { sup, c, seen, calls } = harness({ open: async () => { if (++n < 3) throw new Error(`Docker is not running (${n})`); return { id: n }; } });
    void sup.run();
    await c.parked();
    expect(sup.status()).toMatchObject({ phase: 'down', detail: 'Docker is not running (1)' });
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'down', detail: 'Docker is not running (2)' });
    await c.tick();
    await sup.whenReady();
    expect(c.waits.slice(0, 2)).toEqual([1000, 2000]);
    expect(seen.filter((s) => s.phase === 'down').length).toBe(2);
    expect(calls.filter((x) => x === 'log store-open-failed').length).toBe(2);
    sup.stop();
  });

  it('the backoff stops doubling at maxBackoffMs', async () => {
    const { sup, c } = harness({ open: async () => { throw new Error('down'); }, maxBackoffMs: 4000 });
    void sup.run();
    for (let i = 0; i < 4; i++) await c.tick();
    expect(c.waits.slice(0, 5)).toEqual([1000, 2000, 4000, 4000, 4000]);
    sup.stop();
  });

  it('a failed copy closes the stores before retrying, and ready runs only once', async () => {
    let n = 0;
    const { sup, c, calls } = harness({ prepare: async () => { if (++n === 1) throw new Error('copy failed'); return 'inbox.db was not copied'; } });
    void sup.run();
    await c.tick();
    await sup.whenReady();
    expect(calls).toEqual(['open 1', 'close 1', 'log store-open-failed', 'open 2', 'ready 2']);
    expect(sup.status().notice).toBe('inbox.db was not copied');
    sup.stop();
  });

  it('a configured Postgres that never opens stays down: there is no ready and nothing else opens', async () => {
    const { sup, c, calls } = harness({ open: async () => { calls.push('open'); throw new Error('Docker is not running'); } });
    let ready = false;
    void sup.whenReady().then(() => { ready = true; });
    void sup.run();
    for (let i = 0; i < 5; i++) await c.tick();
    expect(ready).toBe(false);
    expect(sup.status()).toMatchObject({ choice: 'managed', phase: 'down', detail: 'Docker is not running' });
    expect(calls.filter((x) => !x.startsWith('open') && x !== 'log store-open-failed')).toEqual([]);
    sup.stop();
  });

  it('a failed ping is down and repairs; the next good ping is ready and recovered', async () => {
    let up = true;
    let repairs = 0;
    const { sup, c, calls } = harness({ ping: async () => { if (!up) throw new Error('connect ECONNREFUSED'); }, repair: async () => { repairs++; } });
    void sup.run();
    await sup.whenReady();
    up = false;
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'down', detail: 'connect ECONNREFUSED' });
    expect(repairs).toBe(1);
    await c.tick();
    expect(calls.filter((x) => x === 'log store-unreachable').length).toBe(1);
    up = true;
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'ready', detail: null });
    expect(calls.at(-1)).toBe('recovered 1');
    sup.stop();
  });

  it('a failed repair shows its reason', async () => {
    const { sup, c } = harness({
      ping: async () => { throw new Error('connect ECONNREFUSED'); },
      repair: async () => { throw new Error('the store moved to a new port; restart the app'); },
    });
    void sup.run();
    await sup.whenReady();
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'down', detail: 'the store moved to a new port; restart the app' });
    sup.stop();
  });

  it('exclusive() waits for a bring-up in flight and passes the stores it produced', async () => {
    let finishCopy!: () => void;
    const { sup, calls } = harness({
      prepare: () => new Promise<string | null>((r) => { finishCopy = () => r(null); }),
    });
    void sup.run();
    await settle();
    const got: Array<Stores | null> = [];
    const ex = sup.exclusive(async (s) => { got.push(s); calls.push('exclusive'); });
    await settle();
    expect(got).toEqual([]);
    finishCopy();
    await ex;
    expect(got).toEqual([{ id: 1 }]);
    expect(calls).toEqual(['open 1', 'ready 1', 'exclusive']);
    sup.stop();
  });

  it('exclusive() gets null while the store is down, and holds the next attempt until it returns', async () => {
    let n = 0;
    const { sup, c, calls } = harness({ open: async () => { calls.push(`open ${++n}`); if (n === 1) throw new Error('down'); return { id: n }; } });
    void sup.run();
    await c.parked();
    let release!: () => void;
    const ex = sup.exclusive(async (s) => {
      calls.push(`exclusive ${s === null ? 'null' : 'stores'}`);
      await new Promise<void>((r) => { release = r; });
    });
    await settle();
    await c.tick();
    expect(calls).toEqual(['open 1', 'log store-open-failed', 'exclusive null']);
    release();
    await ex;
    await sup.whenReady();
    expect(calls.slice(3)).toEqual(['open 2', 'ready 2']);
    sup.stop();
  });

  it('stop() inside exclusive() ends the bring-up: nothing opens or becomes ready afterwards', async () => {
    const { sup, c, calls } = harness({ open: async () => { calls.push('open'); throw new Error('down'); } });
    void sup.run();
    await c.parked();
    await sup.exclusive(async () => { sup.stop(); });
    await c.tick().catch(() => undefined);
    await settle();
    expect(calls.filter((x) => x === 'open').length).toBe(1);
  });

  it('stop() inside exclusive() also cancels an attempt already queued behind it', async () => {
    const { sup, c, calls } = harness({ open: async () => { calls.push('open'); throw new Error('down'); } });
    void sup.run();
    await c.parked();
    let release!: () => void;
    const ex = sup.exclusive(async () => {
      await new Promise<void>((r) => { release = r; });
      sup.stop();
    });
    await settle();
    await c.tick();
    release();
    await ex;
    await settle();
    expect(calls.filter((x) => x === 'open').length).toBe(1);
  });

  it('a failed service start is ready with its reason; later ticks retry it until it succeeds', async () => {
    let fails = 2;
    const { sup, c, calls } = harness({
      ready: async (s) => { calls.push(`ready ${s.id}`); if (fails-- > 0) throw new Error('History unavailable: connect ECONNRESET'); },
    });
    void sup.run();
    expect(await sup.whenReady()).toEqual({ id: 1 });
    expect(sup.status()).toMatchObject({ phase: 'ready', detail: 'History unavailable: connect ECONNRESET' });
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'ready', detail: 'History unavailable: connect ECONNRESET' });
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'ready', detail: null });
    await c.tick();
    expect(calls.filter((x) => x === 'ready 1').length).toBe(3);
    expect(calls.filter((x) => x === 'log store-ready-failed').length).toBe(1);
    sup.stop();
  });

  it('restartServices runs ready again and a failure is retried on the next tick', async () => {
    let fail = false;
    const { sup, c, calls } = harness({ ready: async (s) => { calls.push(`ready ${s.id}`); if (fail) { fail = false; throw new Error('Inbox unavailable: x'); } } });
    void sup.run();
    await sup.whenReady();
    fail = true;
    await sup.restartServices();
    expect(sup.status()).toMatchObject({ phase: 'ready', detail: 'Inbox unavailable: x' });
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'ready', detail: null });
    expect(calls.filter((x) => x === 'ready 1').length).toBe(3);
    sup.stop();
  });

  it('open progress shows as the starting detail', async () => {
    const { sup, seen } = harness({ open: async (progress) => { progress('Pulling the Postgres image…'); return { id: 1 }; } });
    void sup.run();
    await sup.whenReady();
    expect(seen[0]).toMatchObject({ phase: 'starting', detail: 'Pulling the Postgres image…' });
    sup.stop();
  });

  it('stop() during a bring-up closes what opened instead of running ready', async () => {
    let finishCopy!: () => void;
    const { sup, calls } = harness({ prepare: () => new Promise<string | null>((r) => { finishCopy = () => r(null); }) });
    const done = sup.run();
    await settle();
    sup.stop();
    finishCopy();
    await done;
    expect(calls).toEqual(['open 1', 'close 1']);
  });
});
