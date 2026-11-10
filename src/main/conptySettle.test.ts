// Unit tests for the debounced ConPTY re-settle (#268 follow-up: the #269
// one-shot jitter did not hold on Windows — see the conpty-render-bug handoff).
// The settler must (a) re-fire after EVERY resize burst, not once at spawn,
// and (b) read the pty's size at fire time, never a stale captured size —
// the #269 timer replayed spawn-time cols and could clobber a renderer
// resize that landed inside its 250 ms window, CREATING the very
// width divergence it was meant to fix.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConptySettler, CONPTY_SETTLE_DEBOUNCE_MS } from './conptySettle.js';

describe('createConptySettler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(size: { cols: number; rows: number }) {
    const resizes: Array<[number, number]> = [];
    const settled: Array<{ cols: number; rows: number }> = [];
    const settler = createConptySettler({
      resize: (c, r) => resizes.push([c, r]),
      getSize: () => ({ ...size }),
      onSettle: (info) => settled.push(info)
    });
    return { resizes, settled, settler, size };
  }

  it('settles after the debounce window: jitter one column down, then back to the real size', () => {
    const h = harness({ cols: 167, rows: 40 });
    h.settler.schedule();
    expect(h.resizes).toEqual([]); // nothing until the window elapses
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS);
    expect(h.resizes).toEqual([
      [166, 40],
      [167, 40]
    ]);
  });

  it('debounces a resize burst into a single settle at the end', () => {
    const h = harness({ cols: 167, rows: 40 });
    h.settler.schedule();
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS - 50);
    h.settler.schedule();
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS - 50);
    h.settler.schedule();
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS);
    expect(h.resizes).toEqual([
      [166, 40],
      [167, 40]
    ]);
  });

  it('reads the pty size at fire time, not schedule time (the #269 stale-cols race)', () => {
    // Spawn at 193 wide, renderer fits to 167 inside the debounce window —
    // the settle must land on 167, NOT drag the pty back to 193.
    const h = harness({ cols: 193, rows: 40 });
    h.settler.schedule();
    h.size.cols = 167; // renderer resize landed; pty is now 167
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS);
    expect(h.resizes).toEqual([
      [166, 40],
      [167, 40]
    ]);
  });

  it('jitters up instead of down when the pty is 1 column wide', () => {
    const h = harness({ cols: 1, rows: 40 });
    h.settler.schedule();
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS);
    expect(h.resizes).toEqual([
      [2, 40],
      [1, 40]
    ]);
  });

  it('reports each settle via onSettle', () => {
    const h = harness({ cols: 120, rows: 30 });
    h.settler.schedule();
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS);
    expect(h.settled).toEqual([{ cols: 120, rows: 30 }]);
  });

  it('settles again on a later burst (re-settle on every resize, not one-shot)', () => {
    const h = harness({ cols: 167, rows: 40 });
    h.settler.schedule();
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS);
    h.size.cols = 150;
    h.settler.schedule();
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS);
    expect(h.resizes).toEqual([
      [166, 40],
      [167, 40],
      [149, 40],
      [150, 40]
    ]);
  });

  it('dispose cancels a pending settle and disarms future schedules', () => {
    const h = harness({ cols: 167, rows: 40 });
    h.settler.schedule();
    h.settler.dispose();
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS * 2);
    h.settler.schedule(); // post-exit: must stay inert
    vi.advanceTimersByTime(CONPTY_SETTLE_DEBOUNCE_MS * 2);
    expect(h.resizes).toEqual([]);
    expect(h.settled).toEqual([]);
  });
});
