import { describe, expect, it } from 'vitest';
import { decideCapture, DEFAULT_CAPTURE_POLICY as P } from './capturePolicy.js';

const sig = (contextTokens: number, userTurns = 1, compactions = 0) =>
  ({ workspaceId: 'w', model: 'claude-sonnet-5', contextTokens, userTurns, compactions });
const MIN = 60_000;

describe('decideCapture', () => {
  it('fires ctx-60 once when fill first crosses 60%', () => {
    const a = decideCapture(sig(130_000), undefined, true, P, 0);
    expect(a.trigger).toBe('ctx-60');
    const b = decideCapture(sig(140_000), a.next, true, P, 20 * MIN);
    expect(b.trigger).toBeNull();
  });
  it('fires ctx-85 after ctx-60, respecting the 10-minute interval', () => {
    const a = decideCapture(sig(130_000), undefined, true, P, 0);
    expect(decideCapture(sig(180_000), a.next, true, P, 5 * MIN).trigger).toBeNull();
    expect(decideCapture(sig(180_000), a.next, true, P, 11 * MIN).trigger).toBe('ctx-85');
  });
  it('resets bands after a compaction', () => {
    const a = decideCapture(sig(130_000, 1, 0), undefined, true, P, 0);
    const b = decideCapture(sig(40_000, 2, 1), a.next, true, P, 20 * MIN);
    expect(b.trigger).toBeNull();
    expect(decideCapture(sig(125_000, 3, 1), b.next, true, P, 40 * MIN).trigger).toBe('ctx-60');
  });
  it('fires turns every 30 user turns', () => {
    const a = decideCapture(sig(1_000, 10), undefined, true, P, 0);
    expect(a.trigger).toBeNull();
    expect(decideCapture(sig(1_000, 39), a.next, true, P, 20 * MIN).trigger).toBeNull();
    expect(decideCapture(sig(1_000, 40), a.next, true, P, 20 * MIN).trigger).toBe('turns');
  });
  it('captures history once for a never-captured session with >= 30 turns', () => {
    expect(decideCapture(sig(1_000, 45), undefined, false, P, 0).trigger).toBe('turns');
    expect(decideCapture(sig(1_000, 45), undefined, true, P, 0).trigger).toBeNull();
  });
  it('uses the 1M window for [1m] models', () => {
    const s = { ...sig(300_000), model: 'claude-opus-5-5[1m]' };
    expect(decideCapture(s, undefined, true, P, 0).trigger).toBeNull();
  });
});
