// Holder-only pass that applies the published-rows retention (D138): once at start, then hourly.
import type { Logger } from './log.js';
import { PUBLISH_PRUNE_BATCH, type PublishStore } from './publishStore.js';

export const PUBLISH_PRUNE_EVERY_MS = 3_600_000;
/** Per tick at most this many batches; a larger backlog drains over later ticks. */
export const PUBLISH_PRUNE_MAX_BATCHES = 5;

export function startPublishRetention(o: {
  publish: Pick<PublishStore, 'prune'>;
  log: Logger;
  everyMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}): { tick(): Promise<number>; stop(): void } {
  const schedule = o.schedule ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  });
  let stopped = false;
  let cancel: (() => void) | null = null;
  async function tick(): Promise<number> {
    let removed = 0;
    for (let i = 0; i < PUBLISH_PRUNE_MAX_BATCHES && !stopped; i++) {
      const n = await o.publish.prune(undefined, PUBLISH_PRUNE_BATCH);
      removed += n;
      if (n < PUBLISH_PRUNE_BATCH) break;
    }
    if (removed) o.log.log('info', 'published sessions past retention removed', { removed });
    return removed;
  }
  const loop = (): void => {
    cancel = null;
    void tick()
      .catch((err: Error) => o.log.log('warn', 'publish retention failed', { error: err.message }))
      .finally(() => {
        if (!stopped) cancel = schedule(loop, o.everyMs ?? PUBLISH_PRUNE_EVERY_MS);
      });
  };
  loop();
  return {
    tick,
    stop() {
      stopped = true;
      cancel?.();
      cancel = null;
    }
  };
}
