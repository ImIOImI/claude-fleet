import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, insertUsageAnchor, latestAnchorCovering, latestLimitHitAnchor } from './db.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-anchor-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

const RESET = Date.parse('2026-07-12T18:00:00Z');
const WSTART = Date.parse('2026-07-12T13:00:00Z');
const HIT = Date.parse('2026-07-12T13:54:34Z');

const limitHit = {
  kind: 'limit-hit' as const, httpStatus: 429, scope: 'session' as const,
  resetAt: RESET, windowStart: WSTART, message: 'session limit', rateLimits: null, dedupKey: 'k1',
};

describe('usage_anchors', () => {
  it('inserts and finds the anchor covering a moment inside its window', () => {
    insertUsageAnchor('ws1', 'sess1', HIT, limitHit);
    const cov = latestAnchorCovering(HIT);
    expect(cov?.resetAt).toBe(RESET);
    expect(cov?.windowStart).toBe(WSTART);
    expect(cov?.kind).toBe('limit-hit');
    expect(cov?.ts).toBe(HIT);
  });

  it('returns null when the moment is outside every window', () => {
    insertUsageAnchor('ws1', 'sess1', HIT, limitHit);
    expect(latestAnchorCovering(Date.parse('2026-07-12T19:00:00Z'))).toBeNull();
  });

  it('dedups on dedup_key (idempotent re-ingest)', () => {
    insertUsageAnchor('ws1', 'sess1', HIT, limitHit);
    insertUsageAnchor('ws1', 'sess1', HIT, limitHit);
    expect(latestLimitHitAnchor()?.resetAt).toBe(RESET);
  });

  it('latestLimitHitAnchor ignores throttle rows', () => {
    insertUsageAnchor('ws1', 's', HIT, { kind: 'throttle', httpStatus: 429, scope: null, resetAt: null, windowStart: null, message: null, rateLimits: '{}', dedupKey: 't1' });
    expect(latestLimitHitAnchor()).toBeNull();
  });
});
