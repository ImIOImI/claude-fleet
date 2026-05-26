// USD pricing for Claude 4.x family at standard service tier.
//
// Pure module — no DB, no fs, no IPC. The cost layer in db.ts groups events
// by (model, service_tier) and feeds the resulting token sums through
// `costFor` to derive a USD amount.
//
// Rates are listed per million tokens, matching Anthropic's public pricing
// page. Refresh manually when Anthropic updates them; the file is
// deliberately small and obvious so a casual glance confirms the numbers.

export type ModelFamily = 'opus' | 'sonnet' | 'haiku';

export interface FamilyRates {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million tokens read from a prior cache write. */
  cacheRead: number;
  /** USD per million tokens written to the 5-minute ephemeral cache. */
  cacheCreation: number;
}

/** Claude 4.x standard-tier rates, USD per 1M tokens. */
export const RATES: Record<ModelFamily, FamilyRates> = {
  opus:   { input: 15, output: 75, cacheRead: 1.5,  cacheCreation: 18.75 },
  sonnet: { input: 3,  output: 15, cacheRead: 0.3,  cacheCreation: 3.75 },
  haiku:  { input: 1,  output: 5,  cacheRead: 0.1,  cacheCreation: 1.25 },
};

/**
 * Service-tier multiplier applied to the standard rate. Batch is the only
 * tier with a published discount (50%); priority pricing has historically
 * been per-model and is left at 1× until we see real priority usage in
 * transcripts and can pin numbers.
 */
const TIER_MULTIPLIER: Record<string, number> = {
  standard: 1,
  batch: 0.5,
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

const warnedModels = new Set<string>();
const warnedTiers = new Set<string>();

/**
 * Map a Claude Code-reported model string (e.g. `claude-opus-4-7`,
 * `claude-sonnet-4-6-20251022`) to its family. Returns null for unknown
 * strings; caller treats unknown as $0 contribution and warns once.
 */
export function familyFor(model: string | null): ModelFamily | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

/**
 * Compute USD for a bucket of tokens against one (model, service_tier)
 * pair. Returns 0 when the model is unrecognized; warns at most once per
 * unknown model + tier so repeated polls don't spam the log.
 */
export function costFor(
  model: string | null,
  serviceTier: string | null,
  tokens: TokenCounts,
): number {
  const family = familyFor(model);
  if (!family) {
    const key = model ?? '<null>';
    if (!warnedModels.has(key)) {
      warnedModels.add(key);
      console.warn(`[pricing] unknown model '${key}' — events contribute $0 to cost`);
    }
    return 0;
  }

  const tier = (serviceTier ?? 'standard').toLowerCase();
  const multiplier = TIER_MULTIPLIER[tier];
  if (multiplier === undefined) {
    if (!warnedTiers.has(tier)) {
      warnedTiers.add(tier);
      console.warn(`[pricing] unknown service_tier '${tier}' — pricing as standard`);
    }
  }
  const effectiveMultiplier = multiplier ?? 1;

  const rates = RATES[family];
  const usd =
    (tokens.inputTokens / 1_000_000) * rates.input +
    (tokens.outputTokens / 1_000_000) * rates.output +
    (tokens.cacheReadInputTokens / 1_000_000) * rates.cacheRead +
    (tokens.cacheCreationInputTokens / 1_000_000) * rates.cacheCreation;
  return usd * effectiveMultiplier;
}
