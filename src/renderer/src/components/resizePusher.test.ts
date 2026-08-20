// #268: a dropped pty:resize must never be recorded as delivered.
//
// The regression these pin: the old code set `lastSentCols = term.cols`
// BEFORE invoking pty:resize and discarded the result, so a resize that never
// reached the pty was remembered as sent. The #326 dedupe then suppressed
// every later resize at that same size, leaving claude laying out at a stale
// width for the rest of the session — which is what writes overflow fragments
// into the first columns of the transcript.

import { describe, it, expect, vi } from 'vitest';
import { createResizePusher } from './resizePusher';

/** Drain the microtask queue plus any scheduled retries the pusher armed. */
async function settle(runScheduled: () => void, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await Promise.resolve();
    runScheduled();
  }
  await Promise.resolve();
}

/** A harness with an injectable clock and a mutable terminal size. */
function harness(pushImpl: (c: number, r: number) => Promise<{ ok: boolean } | void>) {
  let size = { cols: 100, rows: 40 };
  const queue: Array<() => void> = [];
  const push = vi.fn(pushImpl);
  const onGiveUp = vi.fn();
  const pusher = createResizePusher({
    getSize: () => size,
    push,
    schedule: (fn) => void queue.push(fn),
    retryMs: 0,
    maxAttempts: 3,
    onGiveUp
  });
  const runScheduled = (): void => {
    const pending = queue.splice(0, queue.length);
    for (const fn of pending) fn();
  };
  return {
    pusher,
    push,
    onGiveUp,
    runScheduled,
    setSize: (cols: number, rows: number) => {
      size = { cols, rows };
    }
  };
}

describe('resizePusher (#268)', () => {
  it('advances the latch only after the pty confirms delivery', async () => {
    const h = harness(async () => ({ ok: true }));
    h.pusher.seed(100, 40);

    h.setSize(107, 45);
    h.pusher.request();
    await settle(h.runScheduled);

    expect(h.push).toHaveBeenCalledWith(107, 45);
    expect(h.pusher.delivered).toEqual({ cols: 107, rows: 45 });
  });

  it('does NOT latch a dropped resize, and retries it', async () => {
    // The core regression. One drop, then success.
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return calls === 1 ? { ok: false } : { ok: true };
    });
    h.pusher.seed(100, 40);

    h.setSize(107, 45);
    h.pusher.request();
    // After the failed push the latch must still be the old size — recording
    // 107x45 here is precisely the bug.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.pusher.delivered).toEqual({ cols: 100, rows: 40 });

    await settle(h.runScheduled);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(h.pusher.delivered).toEqual({ cols: 107, rows: 45 });
  });

  it('treats a rejected push as a drop, not a delivery', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ipc blew up');
      return { ok: true };
    });
    h.pusher.seed(100, 40);

    h.setSize(90, 30);
    h.pusher.request();
    await settle(h.runScheduled);

    expect(h.pusher.delivered).toEqual({ cols: 90, rows: 30 });
  });

  it('suppresses a resize to the size the pty already has (#326 dedupe intact)', async () => {
    const h = harness(async () => ({ ok: true }));
    h.pusher.seed(100, 40);

    h.pusher.request(); // size unchanged
    await settle(h.runScheduled);

    expect(h.push).not.toHaveBeenCalled();
  });

  it('gives up after maxAttempts on a permanently dead handle, and says so', async () => {
    const h = harness(async () => ({ ok: false }));
    h.pusher.seed(100, 40);

    h.setSize(107, 45);
    h.pusher.request();
    await settle(h.runScheduled, 12);

    // Bounded: a dead handle must not spin forever.
    expect(h.push).toHaveBeenCalledTimes(3);
    expect(h.onGiveUp).toHaveBeenCalledWith(107, 45, 3);
    expect(h.pusher.delivered).toEqual({ cols: 100, rows: 40 });
  });

  it('a newly requested size gets a fresh attempt budget after a give-up', async () => {
    let failing = true;
    const h = harness(async () => (failing ? { ok: false } : { ok: true }));
    h.pusher.seed(100, 40);

    h.setSize(107, 45);
    h.pusher.request();
    await settle(h.runScheduled, 12);
    expect(h.pusher.delivered).toEqual({ cols: 100, rows: 40 });

    // The user drags the window again: this must not be starved by the
    // previous size's exhausted budget.
    failing = false;
    h.setSize(120, 50);
    h.pusher.request();
    await settle(h.runScheduled);

    expect(h.pusher.delivered).toEqual({ cols: 120, rows: 50 });
  });

  it('converges on the latest size when the pane moves mid-flight', async () => {
    const h = harness(async () => ({ ok: true }));
    h.pusher.seed(100, 40);

    h.setSize(107, 45);
    h.pusher.request();
    // Pane keeps moving while the first push is in flight.
    h.setSize(130, 60);
    h.pusher.request();
    await settle(h.runScheduled);

    expect(h.pusher.delivered).toEqual({ cols: 130, rows: 60 });
  });

  it('treats a void result as delivered (backends that cannot report)', async () => {
    const h = harness(async () => undefined);
    h.pusher.seed(100, 40);

    h.setSize(107, 45);
    h.pusher.request();
    await settle(h.runScheduled);

    expect(h.pusher.delivered).toEqual({ cols: 107, rows: 45 });
  });

  it('stops pushing once disposed', async () => {
    const h = harness(async () => ({ ok: true }));
    h.pusher.seed(100, 40);
    h.pusher.dispose();

    h.setSize(107, 45);
    h.pusher.request();
    await settle(h.runScheduled);

    expect(h.push).not.toHaveBeenCalled();
  });
});
