import { describe, it, expect, vi, beforeEach } from 'vitest';
import { costFor, familyFor, RATES } from './pricing.js';

beforeEach(() => {
  // pricing.ts warns once per unknown model/tier; the warnedX sets are
  // module-scoped so a stub here keeps test output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('familyFor', () => {
  it.each([
    ['claude-opus-4-7', 'opus'],
    ['claude-opus-4-7-20251022', 'opus'],
    ['claude-sonnet-4-6', 'sonnet'],
    ['claude-haiku-4-5', 'haiku'],
    ['CLAUDE-OPUS-4', 'opus'],
  ] as const)('%s → %s', (model, family) => {
    expect(familyFor(model)).toBe(family);
  });

  it('returns null for unknown / null', () => {
    expect(familyFor(null)).toBeNull();
    expect(familyFor('')).toBeNull();
    expect(familyFor('gpt-4')).toBeNull();
  });
});

describe('costFor', () => {
  const ZERO = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  it('returns 0 for zero tokens', () => {
    expect(costFor('claude-opus-4-7', 'standard', ZERO)).toBe(0);
  });

  it('prices 1M input tokens at the published Opus rate ($15)', () => {
    expect(
      costFor('claude-opus-4-7', 'standard', { ...ZERO, inputTokens: 1_000_000 }),
    ).toBeCloseTo(15, 6);
  });

  it('prices 1M output tokens at the published Opus rate ($75)', () => {
    expect(
      costFor('claude-opus-4-7', 'standard', { ...ZERO, outputTokens: 1_000_000 }),
    ).toBeCloseTo(75, 6);
  });

  it('cache-read is 10% of input for every family (the published discount)', () => {
    for (const family of ['opus', 'sonnet', 'haiku'] as const) {
      const r = RATES[family];
      expect(r.cacheRead).toBeCloseTo(r.input * 0.1, 6);
    }
  });

  it('cache-creation (5min) is 1.25× input for every family (the published premium)', () => {
    for (const family of ['opus', 'sonnet', 'haiku'] as const) {
      const r = RATES[family];
      expect(r.cacheCreation).toBeCloseTo(r.input * 1.25, 6);
    }
  });

  it('sums all four token types correctly for Sonnet', () => {
    // 1M input @ $3, 500K output @ $15 ($7.50), 2M cache-read @ $0.30 ($0.60),
    // 100K cache-creation @ $3.75 ($0.375) → $11.475
    const usd = costFor('claude-sonnet-4-6', 'standard', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadInputTokens: 2_000_000,
      cacheCreationInputTokens: 100_000,
    });
    expect(usd).toBeCloseTo(3 + 7.5 + 0.6 + 0.375, 6);
  });

  it('batch tier halves the price', () => {
    const std = costFor('claude-opus-4-7', 'standard', { ...ZERO, inputTokens: 1_000_000 });
    const batch = costFor('claude-opus-4-7', 'batch', { ...ZERO, inputTokens: 1_000_000 });
    expect(batch).toBeCloseTo(std / 2, 6);
  });

  it('treats null service_tier as standard', () => {
    expect(
      costFor('claude-haiku-4-5', null, { ...ZERO, inputTokens: 1_000_000 }),
    ).toBeCloseTo(1, 6); // $1/1M input for Haiku
  });

  it('returns 0 for unknown model (warns once)', () => {
    expect(
      costFor('gpt-4', 'standard', { ...ZERO, inputTokens: 1_000_000 }),
    ).toBe(0);
  });

  it('priority tier falls back to 1× and warns once', () => {
    const std = costFor('claude-sonnet-4-6', 'standard', { ...ZERO, inputTokens: 1_000_000 });
    const prio = costFor('claude-sonnet-4-6', 'priority', { ...ZERO, inputTokens: 1_000_000 });
    expect(prio).toBeCloseTo(std, 6);
  });
});

describe('qwen endpoints are unpriced', () => {
  const ZERO = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  it('familyFor(qwen) is null', () => {
    expect(familyFor('qwen3-coder:30b')).toBeNull();
  });

  it('costFor(qwen) is 0 (renders — in UI)', () => {
    expect(
      costFor('qwen3-coder:30b', 'standard', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
    ).toBe(0);
  });
});
