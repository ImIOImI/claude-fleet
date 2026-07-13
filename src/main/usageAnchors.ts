// Pure detection + parsing for Anthropic rate-limit "anchor" events (#plan-usage).
// No DB / fs — db.ts:ingestLine calls extractAnchor and persists the result.

export type AnchorScope = 'session' | 'weekly' | 'opus-weekly';

export interface AnchorInput {
  kind: 'limit-hit' | 'throttle';
  httpStatus: number | null;
  scope: AnchorScope | null;
  resetAt: number | null;
  windowStart: number | null;
  message: string | null;
  rateLimits: string | null;
  dedupKey: string;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Parse a human reset string like "…resets 6pm (UTC)" into the next matching
 *  absolute UTC epoch ms, plus the limit scope. Returns null when no absolute
 *  "(UTC)" clock time is present (we don't guess relative phrasings). */
export function parseResetText(text: string, nowMs: number): { resetAt: number; scope: AnchorScope } | null {
  const scope: AnchorScope = /week/i.test(text)
    ? (/opus/i.test(text) ? 'opus-weekly' : 'weekly')
    : 'session';
  const m = /resets?\s+(\d{1,2})\s*(am|pm)\s*\(UTC\)/i.exec(text);
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[2])) hour += 12;
  const n = new Date(nowMs);
  const reset = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), hour, 0, 0, 0));
  if (reset.getTime() <= nowMs) reset.setUTCDate(reset.getUTCDate() + 1);
  return { resetAt: reset.getTime(), scope };
}

function firstText(parsed: Record<string, unknown>): string | null {
  const message = parsed.message as Record<string, unknown> | null;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text') {
        const t = (c as Record<string, unknown>).text;
        if (typeof t === 'string') return t;
      }
    }
  }
  return null;
}

/** Detect a rate-limit anchor in a parsed transcript line. Two shapes:
 *  (a) the assistant 429 synthetic (error:"rate_limit" / apiErrorStatus:429),
 *      whose content text carries the human reset string; and
 *  (b) a system/api_error whose error.rateLimits is a populated object. */
export function extractAnchor(
  parsed: Record<string, unknown>,
  tsMs: number,
  dedupKey: string
): AnchorInput | null {
  if (parsed.error === 'rate_limit') {
    const message = firstText(parsed);
    const reset = message ? parseResetText(message, tsMs) : null;
    return {
      kind: 'limit-hit',
      httpStatus: typeof parsed.apiErrorStatus === 'number' ? (parsed.apiErrorStatus as number) : 429,
      scope: reset?.scope ?? null,
      resetAt: reset?.resetAt ?? null,
      windowStart: reset && reset.scope === 'session' ? reset.resetAt - FIVE_HOURS_MS : null,
      message,
      rateLimits: null,
      dedupKey,
    };
  }

  if (parsed.type === 'system' && parsed.subtype === 'api_error') {
    const err = parsed.error as Record<string, unknown> | null;
    const rl = err && typeof err === 'object' ? err.rateLimits : null;
    if (rl && typeof rl === 'object') {
      return {
        kind: 'throttle',
        httpStatus: typeof err?.status === 'number' ? (err.status as number) : null,
        scope: null,
        resetAt: null,
        windowStart: null,
        message: typeof err?.formatted === 'string' ? (err.formatted as string) : null,
        rateLimits: JSON.stringify(rl),
        dedupKey,
      };
    }
  }
  return null;
}
