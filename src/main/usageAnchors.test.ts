import { describe, it, expect } from 'vitest';
import { parseResetText, extractAnchor } from './usageAnchors.js';

// 2026-07-12T13:54:34Z — the real limit-hit moment.
const NOW = Date.parse('2026-07-12T13:54:34Z');

describe('parseResetText', () => {
  it('parses an absolute UTC pm reset to the next such hour', () => {
    const r = parseResetText("You've hit your session limit · resets 6pm (UTC)", NOW);
    expect(r).toEqual({ resetAt: Date.parse('2026-07-12T18:00:00Z'), scope: 'session' });
  });

  it('rolls to the next day when the hour already passed', () => {
    const r = parseResetText('resets 6am (UTC)', NOW); // 6am already passed at 13:54
    expect(r).toEqual({ resetAt: Date.parse('2026-07-13T06:00:00Z'), scope: 'session' });
  });

  it('classifies weekly and opus-weekly scopes', () => {
    expect(parseResetText('weekly limit resets 6pm (UTC)', NOW)?.scope).toBe('weekly');
    expect(parseResetText('weekly Opus limit resets 6pm (UTC)', NOW)?.scope).toBe('opus-weekly');
  });

  it('returns null when no absolute UTC time is present', () => {
    expect(parseResetText('resets soon', NOW)).toBeNull();
  });
});

describe('extractAnchor', () => {
  it('detects the assistant 429 synthetic and derives the session window', () => {
    const parsed = {
      type: 'assistant',
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 6pm (UTC)" }] },
    };
    const a = extractAnchor(parsed, NOW, 'uuid-1');
    expect(a?.kind).toBe('limit-hit');
    expect(a?.httpStatus).toBe(429);
    expect(a?.scope).toBe('session');
    expect(a?.resetAt).toBe(Date.parse('2026-07-12T18:00:00Z'));
    expect(a?.windowStart).toBe(Date.parse('2026-07-12T13:00:00Z')); // reset - 5h
    expect(a?.message).toContain('session limit');
    expect(a?.dedupKey).toBe('uuid-1');
  });

  it('detects a system/api_error carrying a populated rateLimits object', () => {
    const parsed = {
      type: 'system', subtype: 'api_error',
      error: { status: 429, formatted: '429 rate limited', rateLimits: { unified_remaining: 0 } },
    };
    const a = extractAnchor(parsed, NOW, 'uuid-2');
    expect(a?.kind).toBe('throttle');
    expect(a?.httpStatus).toBe(429);
    expect(a?.rateLimits).toBe(JSON.stringify({ unified_remaining: 0 }));
  });

  it('ignores a system/api_error whose rateLimits is null (e.g. 401 auth error)', () => {
    const parsed = { type: 'system', subtype: 'api_error', error: { status: 401, rateLimits: null } };
    expect(extractAnchor(parsed, NOW, 'k')).toBeNull();
  });

  it('ignores ordinary assistant events', () => {
    const parsed = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { output_tokens: 10 } } };
    expect(extractAnchor(parsed, NOW, 'k')).toBeNull();
  });
});
