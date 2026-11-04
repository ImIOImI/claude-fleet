// Keyed serial task queue: tasks under one key run strictly one after another
// in enqueue order; different keys run independently. The JSONL watcher keys
// it by file path so a file's batches can never overlap or reorder (async
// store part 2 — ingest is async now, so the old "the loop can't interleave"
// guarantee has to be explicit).

export interface KeyedSerialQueue {
  /** Run `task` once every task enqueued earlier under `key` has settled. A
   *  rejection goes to `onError` and does not break the chain. The returned
   *  promise settles with the task and never rejects. */
  enqueue(key: string, task: () => Promise<void>): Promise<void>;
  /** Resolves once every task enqueued so far, under any key, has settled. */
  drain(): Promise<void>;
  /** Keys with a queued or running task. */
  activeKeys(): number;
}

export function keyedSerialQueue(onError: (key: string, err: unknown) => void): KeyedSerialQueue {
  const tails = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();
  return {
    enqueue(key, task) {
      const prev = tails.get(key) ?? Promise.resolve();
      const next = prev.then(task).catch((err: unknown) => {
        onError(key, err);
      });
      tails.set(key, next);
      inflight.add(next);
      void next.finally(() => {
        inflight.delete(next);
        // Self-cleaning: drop the tail only if nothing was chained after it.
        if (tails.get(key) === next) tails.delete(key);
      });
      return next;
    },
    async drain() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
    activeKeys() {
      return tails.size;
    }
  };
}
