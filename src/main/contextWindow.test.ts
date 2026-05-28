import { describe, it, expect } from 'vitest';
import { contextWindowFor, FAMILY_WINDOWS } from './contextWindow.js';

describe('contextWindowFor', () => {
  it('returns 200K for stock Claude 4.x families', () => {
    expect(contextWindowFor('claude-opus-4-7')).toBe(200_000);
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(200_000);
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-7-20251022')).toBe(200_000);
  });

  it('recognizes the [1m] marker on any family', () => {
    expect(contextWindowFor('claude-opus-4-7[1m]')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-6[1M]')).toBe(1_000_000);
    expect(contextWindowFor('CLAUDE-OPUS-4-7[1m]')).toBe(1_000_000);
  });

  it('falls back to 200K for unknown / null models', () => {
    expect(contextWindowFor(null)).toBe(200_000);
    expect(contextWindowFor('')).toBe(200_000);
    expect(contextWindowFor('gpt-4')).toBe(200_000);
  });

  it('auto-upgrades to 1M when observed usage exceeds the family default', () => {
    // The most common 1M scenario: model string is `claude-opus-4-7` with
    // no marker, but the session is on the 1M beta header. Observed
    // tokens crossing 200K is the giveaway.
    expect(contextWindowFor('claude-opus-4-7', 250_000)).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-6', 500_000)).toBe(1_000_000);
  });

  it('keeps 200K when observed usage is at or below the family default', () => {
    expect(contextWindowFor('claude-opus-4-7', 199_999)).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-7', 200_000)).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-7', 0)).toBe(200_000);
  });

  it('[1m] marker beats observed usage (no false-downgrade)', () => {
    // Explicit marker means 1M regardless of what observedMaxTokens says.
    expect(contextWindowFor('claude-opus-4-7[1m]', 50)).toBe(1_000_000);
  });

  it('FAMILY_WINDOWS exposes the per-family default for callers', () => {
    expect(FAMILY_WINDOWS.opus).toBe(200_000);
    expect(FAMILY_WINDOWS.sonnet).toBe(200_000);
    expect(FAMILY_WINDOWS.haiku).toBe(200_000);
  });
});
