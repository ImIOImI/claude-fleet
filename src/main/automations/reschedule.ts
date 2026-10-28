// Run-chosen next fire (#437). Pure. A run requests `{in: "4h"}` or
// `{at: "<ISO>"}`; when the run ends well the host applies it, never sooner
// than the definition's approved `reschedule.min` after the run ended.
import { parseDuration } from './definition.js';

/** Requests further out than this are refused (a typo, not a plan). */
export const MAX_NEXT_MS = 365 * 86_400_000;

export type NextRequest = { ok: true; at: number } | { ok: false; error: string };

export function parseNextRequest(raw: unknown, now: number): NextRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'next must be {"in": "4h"} or {"at": "<ISO time>"}' };
  const o = raw as Record<string, unknown>;
  const hasIn = o.in !== undefined;
  const hasAt = o.at !== undefined;
  if (hasIn === hasAt) return { ok: false, error: 'next needs exactly one of in (a duration like "4h") or at (an ISO time)' };
  let at: number;
  if (hasIn) {
    const ms = parseDuration(o.in);
    if (ms === null) return { ok: false, error: `next.in: a duration like "90s", "30m", "4h" or "2d" (got ${JSON.stringify(o.in)})` };
    at = now + ms;
  } else {
    at = typeof o.at === 'string' ? Date.parse(o.at) : NaN;
    if (!Number.isFinite(at)) return { ok: false, error: `next.at: an ISO time like "2026-10-29T09:00:00Z" (got ${JSON.stringify(o.at)})` };
  }
  if (at - now > MAX_NEXT_MS) return { ok: false, error: 'next: at most 365 days ahead' };
  return { ok: true, at };
}

/** The approved floor: never sooner than `minMs` after `endedAt`. */
export function applyFloor(requestedAt: number, endedAt: number, minMs: number): { at: number; clamped: boolean } {
  const floor = endedAt + minMs;
  return requestedAt < floor ? { at: floor, clamped: true } : { at: requestedAt, clamped: false };
}
