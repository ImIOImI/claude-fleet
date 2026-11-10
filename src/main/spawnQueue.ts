// Serializes local PTY spawns. A ConPTY spawn is ~100 ms of synchronous
// native work on the main thread; restoring many local tabs at launch used
// to run them back to back. The queue runs one spawn per macrotask so IPC
// and first paint interleave, and lets the visible tab jump the line.
//
// Pure module (no node-pty/electron imports) so it loads under vitest.

export interface SpawnQueueOpts {
  /** Defers to the next macrotask. Injectable for tests. */
  yieldFn?: (cb: () => void) => void;
}

export interface SpawnQueue {
  /** Run `task` once every earlier task has run, after a macrotask yield.
   *  `foreground` tasks run ahead of queued background ones (FIFO within
   *  each class). Rejects with whatever `task` throws. */
  run<T>(task: () => T, opts?: { foreground?: boolean }): Promise<T>;
  /** Tasks waiting to run (excludes one currently running). */
  readonly pending: number;
}

interface Entry {
  foreground: boolean;
  exec: () => void;
}

export function createSpawnQueue(opts: SpawnQueueOpts = {}): SpawnQueue {
  const yieldFn = opts.yieldFn ?? ((cb) => void setImmediate(cb));
  const queue: Entry[] = [];
  let draining = false;

  const pump = (): void => {
    const next = queue.shift();
    if (!next) {
      draining = false;
      return;
    }
    next.exec();
    yieldFn(pump);
  };

  return {
    run<T>(task: () => T, runOpts?: { foreground?: boolean }): Promise<T> {
      const foreground = runOpts?.foreground === true;
      return new Promise<T>((resolve, reject) => {
        const entry: Entry = {
          foreground,
          exec: () => {
            try {
              resolve(task());
            } catch (err) {
              reject(err);
            }
          }
        };
        if (foreground) {
          const firstBackground = queue.findIndex((e) => !e.foreground);
          if (firstBackground < 0) queue.push(entry);
          else queue.splice(firstBackground, 0, entry);
        } else {
          queue.push(entry);
        }
        if (!draining) {
          draining = true;
          yieldFn(pump);
        }
      });
    },
    get pending() {
      return queue.length;
    }
  };
}
