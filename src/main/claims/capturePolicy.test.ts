import { describe, expect, it } from 'vitest';
import { defaultCaptureSettings } from '../../preload/captureSettings.js';
import { bandTrigger, decideCapture, DEFAULT_CAPTURE_POLICY as P, policyFromSettings, type CapturePolicyConfig } from './capturePolicy.js';

const sig = (contextTokens: number, userTurns = 1, compactions = 0) =>
  ({ workspaceId: 'w', model: 'claude-sonnet-5', contextTokens, userTurns, compactions });
const MIN = 60_000;
const TWO: CapturePolicyConfig = { bands: [0.6, 0.85], turnsEvery: 0, minIntervalMs: 10 * MIN };

describe('decideCapture', () => {
  it('defaults to one band at 85% and no periodic capture', () => {
    expect(P).toEqual({ bands: [0.85], turnsEvery: 0, minIntervalMs: 10 * MIN });
    expect(decideCapture(sig(130_000, 200), undefined, false, P, 0).trigger).toBeNull();
    const a = decideCapture(sig(175_000), undefined, true, P, 0);
    expect(a.trigger).toBe('ctx-85');
    expect(decideCapture(sig(190_000), a.next, true, P, 20 * MIN).trigger).toBeNull();
  });
  it('fires each configured band once, respecting the 10-minute interval', () => {
    const a = decideCapture(sig(130_000), undefined, true, TWO, 0);
    expect(a.trigger).toBe('ctx-60');
    expect(decideCapture(sig(180_000), a.next, true, TWO, 5 * MIN).trigger).toBeNull();
    expect(decideCapture(sig(180_000), a.next, true, TWO, 11 * MIN).trigger).toBe('ctx-85');
  });
  it('jumping past several bands fires only the highest and marks the lower ones fired', () => {
    const a = decideCapture(sig(180_000), undefined, true, TWO, 0);
    expect(a.trigger).toBe('ctx-85');
    expect(a.next.fired).toEqual([0.6, 0.85]);
  });
  it('resets bands after a compaction', () => {
    const a = decideCapture(sig(130_000, 1, 0), undefined, true, TWO, 0);
    const b = decideCapture(sig(40_000, 2, 1), a.next, true, TWO, 20 * MIN);
    expect(b.trigger).toBeNull();
    expect(decideCapture(sig(125_000, 3, 1), b.next, true, TWO, 40 * MIN).trigger).toBe('ctx-60');
  });
  it('an empty band list disables context-fill capture', () => {
    expect(decideCapture(sig(199_000), undefined, true, { ...P, bands: [] }, 0).trigger).toBeNull();
  });
  it('turnsEvery 0 never fires periodic captures', () => {
    expect(decideCapture(sig(1_000, 500), undefined, false, P, 0).trigger).toBeNull();
  });
  it('fires turns every N user turns when configured', () => {
    const T = { ...TWO, turnsEvery: 30 };
    const a = decideCapture(sig(1_000, 10), undefined, true, T, 0);
    expect(a.trigger).toBeNull();
    expect(decideCapture(sig(1_000, 39), a.next, true, T, 20 * MIN).trigger).toBeNull();
    expect(decideCapture(sig(1_000, 40), a.next, true, T, 20 * MIN).trigger).toBe('turns');
  });
  it('captures history once for a never-captured session when periodic capture is on', () => {
    const T = { ...TWO, turnsEvery: 30 };
    expect(decideCapture(sig(1_000, 45), undefined, false, T, 0).trigger).toBe('turns');
    expect(decideCapture(sig(1_000, 45), undefined, true, T, 0).trigger).toBeNull();
  });
  it('uses the 1M window for [1m] models', () => {
    const s = { ...sig(300_000), model: 'claude-opus-5-5[1m]' };
    expect(decideCapture(s, undefined, true, TWO, 0).trigger).toBeNull();
  });
});

describe('policyFromSettings / bandTrigger', () => {
  it('maps settings to a sorted policy with the fixed 10-minute interval', () => {
    expect(policyFromSettings({ ...defaultCaptureSettings(), contextBands: [0.85, 0.6], turnsEvery: 40 }))
      .toEqual({ bands: [0.6, 0.85], turnsEvery: 40, minIntervalMs: 10 * MIN });
  });
  it('names band triggers by percent', () => {
    expect(bandTrigger(0.85)).toBe('ctx-85');
    expect(bandTrigger(0.6)).toBe('ctx-60');
  });
});
