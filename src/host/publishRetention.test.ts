import { describe, expect, it } from 'vitest';
import { PUBLISH_PRUNE_BATCH } from './publishStore.js';
import { PUBLISH_PRUNE_EVERY_MS, PUBLISH_PRUNE_MAX_BATCHES, startPublishRetention } from './publishRetention.js';

const flush = () => new Promise((ok) => setTimeout(ok, 0));

function rig(results: Array<number | Error>) {
  const calls: Array<number | undefined> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const r = startPublishRetention({
    publish: {
      prune: async (_now, limit) => {
        calls.push(limit);
        const next = results.shift() ?? 0;
        if (next instanceof Error) throw next;
        return next;
      }
    },
    log: { log: (level, msg) => void logs.push({ level, msg }) },
    schedule: (fn, ms) => { timers.push({ fn, ms }); return () => void timers.splice(timers.findIndex((t) => t.fn === fn), 1); }
  });
  return { r, calls, timers, logs };
}

describe('startPublishRetention', () => {
  it('prunes once at start, then every hour', async () => {
    const h = rig([0, 0]);
    await flush();
    expect(h.calls).toEqual([PUBLISH_PRUNE_BATCH]);
    expect(h.timers.map((t) => t.ms)).toEqual([PUBLISH_PRUNE_EVERY_MS]);
    h.timers.shift()!.fn();
    await flush();
    expect(h.calls).toHaveLength(2);
    h.r.stop();
  });

  it('drains full batches but at most a bounded number per tick', async () => {
    const h = rig(Array.from({ length: 20 }, () => PUBLISH_PRUNE_BATCH));
    await flush();
    expect(h.calls).toHaveLength(PUBLISH_PRUNE_MAX_BATCHES);
    expect(h.logs).toEqual([{ level: 'info', msg: 'published sessions past retention removed' }]);
    h.r.stop();
  });

  it('stops after a short batch', async () => {
    const h = rig([PUBLISH_PRUNE_BATCH, 3]);
    await flush();
    expect(h.calls).toHaveLength(2);
    h.r.stop();
  });

  it('a failed tick is logged and the timer keeps going; stop cancels it', async () => {
    const h = rig([new Error('fenced off')]);
    await flush();
    expect(h.logs).toEqual([{ level: 'warn', msg: 'publish retention failed' }]);
    expect(h.timers).toHaveLength(1);
    h.r.stop();
    expect(h.timers).toHaveLength(0);
  });
});
