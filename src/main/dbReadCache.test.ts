import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ingestLine, deleteSession,
  summaryForSession, summaryForWorkspace, tokensSpentSince,
  SUMMARY_STALE_GRACE_MS, _summaryRecomputesForTests,
} from './db.js';
import { openTestState, type TestState } from './store/testStore.js';

const WS = '01WS';
const SES = 'ses-cache-1';
const assistantLine = (uuid: string, outputTokens: number) =>
  JSON.stringify({
    type: 'assistant', uuid, timestamp: '2026-07-01T00:00:00Z',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: outputTokens }, content: [{ type: 'text', text: 'hi' }] }
  });
const userLine = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content } });

let st: TestState;
beforeEach(async () => { st = await openTestState('cf-cache-'); });
afterEach(async () => { await st.close(); });

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
  it('DEBOUNCE (#383): a read inside the 3s grace serves the cached summary; a post-grace read reflects the ingest', async () => {
    // Arrange: prime the cache with a pre-ingest summary (user line only, no tokens).
    await ingestLine(WS, SES, userLine('u1', 'first'));
    const before = await summaryForSession(SES);
    expect(before).not.toBeNull();

    // Fake timers so we can advance Date.now() without sleeping.
    // NOTE: fixture timestamps are ISO strings parsed by Date.parse() — not
    // affected by fake timers. The only Date.now() consumer here is the cache's
    // staleAt horizon check in asyncCache.ts.
    vi.useFakeTimers();
    try {
      // Act: ingest an assistant event (adds outputTokens).
      await ingestLine(WS, SES, assistantLine('a1', 100));

      // Within grace — cache must serve the same pre-ingest object (no recompute).
      const withinGrace = await summaryForSession(SES);
      expect(withinGrace).toBe(before); // identity proves cache hit (debounce working)
      // outputTokens is unchanged because it is the same cached object.
      expect(withinGrace!.outputTokens).toBe(before!.outputTokens ?? 0);

      // Post grace — advance past the stale horizon; cache must recompute.
      vi.advanceTimersByTime(SUMMARY_STALE_GRACE_MS + 100);
      const afterGrace = await summaryForSession(SES);
      expect(afterGrace).not.toBe(before); // different object — was recomputed
      expect(afterGrace!.outputTokens).toBeGreaterThan(before!.outputTokens ?? 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repeated reads between ingests hit the cache (same object identity)', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    const a = await summaryForSession(SES);
    const b = await summaryForSession(SES);
    expect(b).toBe(a); // identity, not equality: proves no recompute
  });

  it('summaryForWorkspace serves the same cache (funnels into summaryForSession)', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    const direct = await summaryForSession(SES);
    const viaWorkspace = await summaryForWorkspace(WS);
    expect(viaWorkspace).toBe(direct);
  });

  it('a non-default topToolsLimit bypasses the cache', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    const a = await summaryForSession(SES, 3);
    const b = await summaryForSession(SES, 3);
    expect(b).not.toBe(a); // recomputed each time — deliberate bypass
  });

  it('deleteSession invalidates immediately', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    expect(await summaryForSession(SES)).not.toBeNull();
    await deleteSession(SES);
    expect(await summaryForSession(SES)).toBeNull();
  });

  it('the cached summary is frozen — decoration throws instead of corrupting the cache', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    const s = await summaryForSession(SES);
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => { (s as unknown as Record<string, unknown>).decorated = true; }).toThrow();
  });

  it('reopening a different DB never serves the previous DB values', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    expect(await summaryForSession(SES)).not.toBeNull();
    await st.close();
    st = await openTestState('cf-cache2-'); // fresh empty DB — the cached summary must not leak across
    expect(await summaryForSession(SES)).toBeNull();
  });
});

// Concurrent misses share one recompute. The write-during-recompute rules are
// unit-tested in asyncCache.test.ts: on the SQLite driver a read stores its
// result before a queued write can commit, so those races can't be provoked
// here.
describe('summaryForSession cache, in flight', () => {
  it('concurrent misses share one recompute', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    const before = _summaryRecomputesForTests();
    const [a, b] = await Promise.all([summaryForSession(SES), summaryForSession(SES)]);
    expect(b).toBe(a);
    expect(_summaryRecomputesForTests() - before).toBe(1);
  });
});

describe('tokensSpentSince cache', () => {
  it('STALENESS REGRESSION: an ingested token event is visible immediately', async () => {
    await ingestLine(WS, SES, assistantLine('a1', 100));
    const floor = Date.parse('2026-07-01T00:00:00Z') - 1000;
    const before = await tokensSpentSince(floor);
    expect(before).toBeGreaterThan(0);
    await ingestLine(WS, SES, assistantLine('a2', 5000));
    expect(await tokensSpentSince(floor)).toBeGreaterThan(before);
  });

  it('same 15s bucket serves the cache; different bucket recomputes', async () => {
    // Event at :05 (5s past midnight). floor = evTs - 20s ensures:
    //   floor and floor+14s share the same 15s bucket key (verified: both → 118857599)
    //   floor+15s lands in the next bucket (118857600)
    //   the event at evTs is within ALL three query windows (evTs >= floor+15s)
    // So value equality holds whether or not the cache fires.
    await ingestLine(WS, SES, assistantLine('a1', 100));
    const evTs = Date.parse('2026-07-01T00:00:05Z');
    const floor = evTs - 20_000;
    const a = await tokensSpentSince(floor);
    const b = await tokensSpentSince(floor + 14_000); // same 15s bucket key as floor
    const c = await tokensSpentSince(floor + 15_000); // different bucket key, same underlying data
    expect(b).toBe(a);
    expect(c).toBe(a); // same data → same value, but computed via a different key
  });

  it('deleteSession clears the spend cache (deleted tokens vanish)', async () => {
    await ingestLine(WS, SES, assistantLine('a1', 5000));
    const floor = Date.parse('2026-07-01T00:00:00Z') - 1000;
    const before = await tokensSpentSince(floor);
    await deleteSession(SES);
    expect(await tokensSpentSince(floor)).toBeLessThan(before);
  });
});
