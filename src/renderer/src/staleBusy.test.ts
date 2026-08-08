import { describe, it, expect } from 'vitest';
import { busyFlagIsStale, BUSY_SILENCE_TIMEOUT_MS } from './staleBusy';

// Level-triggered backstop for #283: the busy flag is edge-sourced (title
// events), so a lost idle edge would otherwise be wrong forever. A genuinely
// busy claude re-asserts its spinner title ~1/s — that's PTY output — so
// busy + prolonged PTY silence ⇒ the flag is stale and must be cleared.
describe('busyFlagIsStale', () => {
  const t0 = 1_000_000;

  it('never flags an idle session, regardless of silence', () => {
    expect(busyFlagIsStale(false, t0, t0 + BUSY_SILENCE_TIMEOUT_MS * 10)).toBe(false);
  });

  it('keeps busy while output is fresh', () => {
    expect(busyFlagIsStale(true, t0, t0)).toBe(false);
    expect(busyFlagIsStale(true, t0, t0 + BUSY_SILENCE_TIMEOUT_MS - 1)).toBe(false);
  });

  it('flags busy as stale once the PTY has been silent past the timeout', () => {
    expect(busyFlagIsStale(true, t0, t0 + BUSY_SILENCE_TIMEOUT_MS)).toBe(true);
    expect(busyFlagIsStale(true, t0, t0 + BUSY_SILENCE_TIMEOUT_MS * 100)).toBe(true);
  });

  it('timeout leaves generous headroom over the ~1s spinner cadence', () => {
    // The spinner title repaints roughly once a second while claude works; the
    // timeout must be far above that so a slow frame never flickers the chip.
    expect(BUSY_SILENCE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
