// One spawn per macrotask: a ConPTY spawn is ~100 ms of sync native work on
// main; foreground tasks run first. Pure module so it loads under vitest.

export class SpawnCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnCancelledError';
  }
}

export interface SpawnQueueOpts {
  /** Defers to the next macrotask. Injectable for tests. */
  yieldFn?: (cb: () => void) => void;
}

export interface SpawnQueue {
  /** Run `task` once every earlier task has finished, after a macrotask
   *  yield. `foreground` tasks run ahead of queued background ones (FIFO
   *  within each lane). A task already pending under `key` is replaced: its
   *  caller rejects with SpawnCancelledError, the new task takes its place,
   *  and a foreground replacement promotes it to the foreground lane. */
  run<T>(key: string, task: () => T | Promise<T>, opts?: { foreground?: boolean }): Promise<T>;
  /** Drop the pending task under `key`; its caller rejects with
   *  SpawnCancelledError. False when nothing was pending. */
  cancel(key: string, reason?: string): boolean;
  /** `cancel` every pending task whose key matches. Returns how many. */
  cancelMatching(match: (key: string) => boolean, reason?: string): number;
  has(key: string): boolean;
  /** Tasks waiting to run (excludes one currently running). */
  readonly pending: number;
}

interface Entry {
  key: string;
  foreground: boolean;
  exec: () => Promise<void>;
  cancel: (reason: string) => void;
}

export function createSpawnQueue(opts: SpawnQueueOpts = {}): SpawnQueue {
  const yieldFn = opts.yieldFn ?? ((cb) => void setImmediate(cb));
  const queue: Entry[] = [];
  let draining = false;

  const pump = async (): Promise<void> => {
    const next = queue.shift();
    if (!next) {
      draining = false;
      return;
    }
    await next.exec();
    yieldFn(() => void pump());
  };

  const insert = (entry: Entry): void => {
    if (!entry.foreground) {
      queue.push(entry);
      return;
    }
    const firstBackground = queue.findIndex((e) => !e.foreground);
    if (firstBackground < 0) queue.push(entry);
    else queue.splice(firstBackground, 0, entry);
  };

  const cancelAt = (i: number, reason: string): void => {
    const [entry] = queue.splice(i, 1);
    entry.cancel(reason);
  };

  return {
    run<T>(key: string, task: () => T | Promise<T>, runOpts?: { foreground?: boolean }): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const entry: Entry = {
          key,
          foreground: runOpts?.foreground === true,
          exec: async () => {
            try {
              resolve(await task());
            } catch (err) {
              reject(err);
            }
          },
          cancel: (reason) => reject(new SpawnCancelledError(reason))
        };
        const i = queue.findIndex((e) => e.key === key);
        if (i >= 0) {
          const prev = queue[i];
          prev.cancel('superseded by a newer attach');
          if (entry.foreground && !prev.foreground) {
            queue.splice(i, 1);
            insert(entry);
          } else {
            entry.foreground = prev.foreground;
            queue[i] = entry;
          }
        } else {
          insert(entry);
        }
        if (!draining) {
          draining = true;
          yieldFn(() => void pump());
        }
      });
    },
    cancel(key: string, reason = 'cancelled'): boolean {
      const i = queue.findIndex((e) => e.key === key);
      if (i < 0) return false;
      cancelAt(i, reason);
      return true;
    },
    cancelMatching(match: (key: string) => boolean, reason = 'cancelled'): number {
      let n = 0;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (match(queue[i].key)) {
          cancelAt(i, reason);
          n++;
        }
      }
      return n;
    },
    has(key: string): boolean {
      return queue.some((e) => e.key === key);
    },
    get pending() {
      return queue.length;
    }
  };
}
