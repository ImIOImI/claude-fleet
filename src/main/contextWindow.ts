// Per-model context-window size, in tokens.
//
// Pure module — no DB, no fs, no IPC. The observability layer feeds the
// session's latest model string (and observed max-tokens across all
// assistant turns) through `contextWindowFor` to get the effective limit
// for the terminal-pane context bar.
//
// Numbers are pulled from Anthropic's published context-window sizes for
// Claude 4.x. Refresh manually when Anthropic ships new variants; the
// table is deliberately small and obvious so a casual glance confirms
// it.

import { familyFor, type ModelFamily } from './pricing.js';

/** Claude 4.x standard context window per family, in tokens. */
export const FAMILY_WINDOWS: Record<ModelFamily, number> = {
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
};

/** Marker the 1M-context Claude variant carries in its model id. */
const ONE_MILLION_MARKER = /\[1m\]/i;
const ONE_MILLION_TOKENS = 1_000_000;

const DEFAULT_WINDOW = 200_000;

/**
 * Effective context window for one session in tokens. Two signals fold in:
 *
 * 1. **Model id.** A `[1m]` suffix marks the 1M-context variant (e.g.
 *    `claude-opus-4-7[1m]`). Otherwise we look up the family's standard
 *    window — all Claude 4.x families publish 200K today.
 *
 * 2. **Observed-usage upgrade.** Most sessions on the 1M variant don't
 *    carry the `[1m]` marker in the model string Claude Code writes to
 *    JSONL (the 1M window is a request-time beta header, invisible to
 *    transcripts). When the caller passes `observedMaxTokens` and it's
 *    already past the family default, the session must be on a wider
 *    window — bump the displayed limit to 1M so the bar doesn't peg at
 *    100% mid-conversation.
 *
 * Unknown or null model strings fall back to the 200K default; pricing.ts
 * is responsible for warning on unknown models, no need to double-warn.
 */
export function contextWindowFor(
  model: string | null,
  observedMaxTokens = 0,
): number {
  if (model && ONE_MILLION_MARKER.test(model)) return ONE_MILLION_TOKENS;
  const family = familyFor(model);
  const familyWindow = family ? FAMILY_WINDOWS[family] : DEFAULT_WINDOW;
  if (observedMaxTokens > familyWindow) return ONE_MILLION_TOKENS;
  return familyWindow;
}
