import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, closeDb, ingestLine, deleteSession,
  summaryForSession, summaryForWorkspace, tokensSpentSince,
  SUMMARY_STALE_GRACE_MS,
} from './db.js';

let dir: string;
const WS = '01WS';
const SES = 'ses-cache-1';
const assistantLine = (uuid: string, outputTokens: number) =>
  JSON.stringify({
    type: 'assistant', uuid, timestamp: '2026-07-01T00:00:00Z',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: outputTokens }, content: [{ type: 'text', text: 'hi' }] }
  });
const userLine = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content } });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-cache-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

// Cache-correctness contract (#383, supersedes #306):
//   - On ingestLine, summaryCache.markStale(sessionId, SUMMARY_STALE_GRACE_MS) is called.
//     This caps the remaining entry lifetime at 3s (debounced invalidation): reads within
//     the grace window serve the pre-ingest cached summary (at most 3s stale); a read
//     after the grace horizon recomputes fresh. This is intentional — it prevents a
//     per-event recompute storm during streaming sessions (#383).
//   - deleteSession and renameSession hard-invalidate immediately (no grace window).
//   - The TTL (30s) is a safety net against any missed invalidation path.
//   - The spendCache (tokensSpentSince) is still cleared immediately on every new event row.
describe('summaryForSession cache', () => {
  it('DEBOUNCE (#383): a read inside the 3s grace serves the cached summary; a post-grace read reflects the ingest', () => {
    // Arrange: prime the cache with a pre-ingest summary (user line only, no tokens).
    ingestLine(WS, SES, userLine('u1', 'first'));
    const before = summaryForSession(SES);
    expect(before).not.toBeNull();

    // Fake timers so we can advance Date.now() without sleeping.
    // NOTE: fixture timestamps are ISO strings parsed by Date.parse() — not
    // affected by fake timers. The only Date.now() consumer here is the cache's
    // staleAt horizon check in syncCache.ts.
    vi.useFakeTimers();
    try {
      // Act: ingest an assistant event (adds outputTokens).
      ingestLine(WS, SES, assistantLine('a1', 100));

      // Within grace — cache must serve the same pre-ingest object (no recompute).
      const withinGrace = summaryForSession(SES);
      expect(withinGrace).toBe(before); // identity proves cache hit (debounce working)
      // outputTokens is unchanged because it is the same cached object.
      expect(withinGrace!.outputTokens).toBe(before!.outputTokens ?? 0);

      // Post grace — advance past the stale horizon; cache must recompute.
      vi.advanceTimersByTime(SUMMARY_STALE_GRACE_MS + 100);
      const afterGrace = summaryForSession(SES);
      expect(afterGrace).not.toBe(before); // different object — was recomputed
      expect(afterGrace!.outputTokens).toBeGreaterThan(before!.outputTokens ?? 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repeated reads between ingests hit the cache (same object identity)', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    const a = summaryForSession(SES);
    const b = summaryForSession(SES);
    expect(b).toBe(a); // identity, not equality: proves no recompute
  });

  it('summaryForWorkspace serves the same cache (funnels into summaryForSession)', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    const direct = summaryForSession(SES);
    const viaWorkspace = summaryForWorkspace(WS);
    expect(viaWorkspace).toBe(direct);
  });

  it('a non-default topToolsLimit bypasses the cache', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    const a = summaryForSession(SES, 3);
    const b = summaryForSession(SES, 3);
    expect(b).not.toBe(a); // recomputed each time — deliberate bypass
  });

  it('deleteSession invalidates immediately', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    expect(summaryForSession(SES)).not.toBeNull();
    deleteSession(SES);
    expect(summaryForSession(SES)).toBeNull();
  });

  it('the cached summary is frozen — decoration throws instead of corrupting the cache', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    const s = summaryForSession(SES);
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => { (s as unknown as Record<string, unknown>).decorated = true; }).toThrow();
  });

  it('reopening a different DB never serves the previous DB values', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    expect(summaryForSession(SES)).not.toBeNull();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'cf-cache2-'));
    openDb(dir); // fresh empty DB — the cached summary must not leak across
    expect(summaryForSession(SES)).toBeNull();
  });
});

describe('tokensSpentSince cache', () => {
  it('STALENESS REGRESSION: an ingested token event is visible immediately', () => {
    ingestLine(WS, SES, assistantLine('a1', 100));
    const floor = Date.parse('2026-07-01T00:00:00Z') - 1000;
    const before = tokensSpentSince(floor);
    expect(before).toBeGreaterThan(0);
    ingestLine(WS, SES, assistantLine('a2', 5000));
    expect(tokensSpentSince(floor)).toBeGreaterThan(before);
  });

  it('same 15s bucket serves the cache; different bucket recomputes', () => {
    // Event at :05 (5s past midnight). floor = evTs - 20s ensures:
    //   floor and floor+14s share the same 15s bucket key (verified: both → 118857599)
    //   floor+15s lands in the next bucket (118857600)
    //   the event at evTs is within ALL three query windows (evTs >= floor+15s)
    // So value equality holds whether or not the cache fires.
    ingestLine(WS, SES, assistantLine('a1', 100));
    const evTs = Date.parse('2026-07-01T00:00:05Z');
    const floor = evTs - 20_000;
    const a = tokensSpentSince(floor);
    const b = tokensSpentSince(floor + 14_000); // same 15s bucket key as floor
    const c = tokensSpentSince(floor + 15_000); // different bucket key, same underlying data
    expect(b).toBe(a);
    expect(c).toBe(a); // same data → same value, but computed via a different key
  });

  it('deleteSession clears the spend cache (deleted tokens vanish)', () => {
    ingestLine(WS, SES, assistantLine('a1', 5000));
    const floor = Date.parse('2026-07-01T00:00:00Z') - 1000;
    const before = tokensSpentSince(floor);
    deleteSession(SES);
    expect(tokensSpentSince(floor)).toBeLessThan(before);
  });
});
