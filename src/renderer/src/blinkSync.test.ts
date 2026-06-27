import { describe, it, expect } from 'vitest';
import { blinkDelayMs, BLINK_CYCLE_MS } from './blinkSync';

// All "busy" indicators across the app (workspace chips, session tabs, the
// left-rail Sessions rows) must pulse in lockstep even though they mount at
// arbitrary, unrelated times. The pulse animation has a fixed period; aligning
// each element's `animation-delay` to a shared wall-clock phase makes the pulse
// position depend only on the clock, not on when the element happened to mount.
describe('blinkDelayMs', () => {
  it('returns 0 at the start of a cycle', () => {
    expect(blinkDelayMs(0)).toBe(0);
    expect(blinkDelayMs(BLINK_CYCLE_MS)).toBe(0);
    expect(blinkDelayMs(BLINK_CYCLE_MS * 5)).toBe(0);
  });

  it('returns the negative offset into the current cycle', () => {
    expect(blinkDelayMs(250)).toBe(-250);
    expect(blinkDelayMs(999)).toBe(-999);
  });

  // The whole point: two elements that begin animating at different absolute
  // times but at the same phase get the same delay → they pulse together.
  it('is identical for times one full cycle apart (the sync property)', () => {
    expect(blinkDelayMs(250)).toBe(blinkDelayMs(250 + BLINK_CYCLE_MS));
    expect(blinkDelayMs(742)).toBe(blinkDelayMs(742 + BLINK_CYCLE_MS * 9));
  });

  it('respects a custom cycle length', () => {
    expect(blinkDelayMs(700, 500)).toBe(-200);
    expect(blinkDelayMs(500, 500)).toBe(0);
  });

  it('handles negative clocks defensively (stays within (-cycle, 0])', () => {
    const d = blinkDelayMs(-100);
    expect(d).toBeLessThanOrEqual(0);
    expect(d).toBeGreaterThan(-BLINK_CYCLE_MS);
    expect(d).toBe(-900);
  });
});
