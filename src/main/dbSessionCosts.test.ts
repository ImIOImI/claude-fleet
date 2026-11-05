// session_costs rollup invariant tests (#383).
//
// The invariant: session_costs ≡ GROUP BY over events at every commit boundary.
// These tests exercise the three write paths that must maintain it:
//   1. ingestLine (upsert on new event, no-op on duplicate)
//   2. deleteSession (removes the session's rollup rows)
//   3. migrate() v13 DROP+backfill (drift self-heal after user_version reset)
//
// NOTE: better-sqlite3 is ABI-broken in this container ("Module did not
// self-register"). The expected local outcome is a fast import failure — CI
// runs the real assertions. Gate locally with `npm run typecheck:node`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openDb,
  closeDb,
  ingestLine,
  deleteSession,
  renameSession,
  costForSession,
  costForWorkspace,
  listSessions,
  summaryForSession,
  _summaryRecomputesForTests,
  stateKysely,
  listSessionCostsQuery,
} from './db.js';
import { explainPlan } from './state/explainPlan.js';
import { openTestState, queryRows, isPg, type TestState } from './store/testStore.js';

let dir: string;

// Two workspaces, two sessions per workspace for the multi-workspace case.
const WS1 = '01WS1';
const WS2 = '01WS2';
const SES_A = 'ses-a';
const SES_B = 'ses-b';

// Build an assistant JSONL line with usage metadata. If serviceTier is
// omitted the field is absent (NULL → '' sentinel in rollup).
function assistantLine(
  uuid: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  opts: {
    cacheRead?: number;
    cacheCreation?: number;
    serviceTier?: string;
  } = {},
): string {
  const usage: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: opts.cacheRead ?? 0,
    cache_creation_input_tokens: opts.cacheCreation ?? 0,
  };
  if (opts.serviceTier !== undefined) {
    usage.service_tier = opts.serviceTier;
  }
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-01T00:00:00Z',
    message: { model, usage },
  });
}

// Build a user JSONL line — no usage, no model → contributes to the (''.'')
// rollup row with 0 tokens and event_count += 1.
function userLine(uuid: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-01T00:00:00Z',
    message: { content },
  });
}

// Ground truth: recompute the rollup directly from events. ORDER BY makes
// deep-equality comparisons deterministic.
const GROUND_TRUTH_SQL = `
  SELECT session_id, workspace_id,
         COALESCE(model, '')         AS model,
         COALESCE(service_tier, '')  AS service_tier,
         COALESCE(SUM(input_tokens), 0)                AS input_tokens,
         COALESCE(SUM(output_tokens), 0)               AS output_tokens,
         COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
         COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
         COUNT(id)                                     AS event_count
  FROM events
  GROUP BY session_id, workspace_id, COALESCE(model,''), COALESCE(service_tier,'')
  ORDER BY session_id, workspace_id, model, service_tier`;

const ROLLUP_SQL = `
  SELECT session_id, workspace_id, model, service_tier, input_tokens,
         output_tokens, cache_read_input_tokens, cache_creation_input_tokens, event_count
  FROM session_costs
  ORDER BY session_id, workspace_id, model, service_tier`;

async function expectRollupMatchesEvents(): Promise<void> {
  expect((await queryRows(ROLLUP_SQL))).toEqual((await queryRows(GROUND_TRUTH_SQL)));
}

let st: TestState;
beforeEach(async () => {
  st = await openTestState('cf-costs-');
  dir = st.dir;
});
afterEach(async () => {
  await st.close();
});

describe('session_costs invariant', () => {
  it('mixed ingest: multi-session/multi-workspace rollup matches ground truth', async () => {
    // SES_A in WS1: two distinct models, one with a service_tier, plus user lines.
    await ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    await ingestLine(WS1, SES_A, assistantLine('a2', 'claude-3-haiku', 200, 80));
    await ingestLine(
      WS1,
      SES_A,
      assistantLine('a3', 'claude-3-opus', 300, 60, { serviceTier: 'batch' }),
    );
    await ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    await ingestLine(WS1, SES_A, userLine('u2', 'world'));

    // SES_B in WS2: single model, no service_tier, plus user lines.
    await ingestLine(WS2, SES_B, assistantLine('b1', 'claude-sonnet', 150, 70, { cacheRead: 10 }));
    await ingestLine(WS2, SES_B, assistantLine('b2', 'claude-sonnet', 50, 20));
    await ingestLine(WS2, SES_B, userLine('u3', 'ping'));

    await expectRollupMatchesEvents();
  });

  it('duplicate replay is a no-op: same uuid re-ingested does not double-count', async () => {
    await ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    await ingestLine(WS1, SES_A, userLine('u1', 'first'));

    // Snapshot the rollup before replay.
    const before = (await queryRows(ROLLUP_SQL));

    // Re-ingest the exact same assistant line (same uuid = same dedup_key).
    const result = await ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    expect(result.inserted).toBe(false);

    // Rollup must be unchanged AND still match ground truth.
    expect((await queryRows(ROLLUP_SQL))).toEqual(before);
    await expectRollupMatchesEvents();
  });

  it('deleteSession removes its rollup rows; peer session remains intact', async () => {
    // Two sessions in WS1.
    await ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    await ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    await ingestLine(WS1, SES_B, assistantLine('b1', 'claude-3-haiku', 200, 80));
    await ingestLine(WS1, SES_B, userLine('u2', 'world'));


    // Verify both sessions have rollup rows before deletion.
    const rowsBefore = (await queryRows(ROLLUP_SQL)) as Array<{ session_id: string }>;
    expect(rowsBefore.some((r) => r.session_id === SES_A)).toBe(true);
    expect(rowsBefore.some((r) => r.session_id === SES_B)).toBe(true);

    // Delete SES_A.
    await deleteSession(SES_A);

    // SES_A gone from session_costs; SES_B intact; ground truth still matches.
    const rowsAfter = (await queryRows(ROLLUP_SQL)) as Array<{ session_id: string }>;
    expect(rowsAfter.some((r) => r.session_id === SES_A)).toBe(false);
    expect(rowsAfter.some((r) => r.session_id === SES_B)).toBe(true);
    await expectRollupMatchesEvents();
  });

  it('cost readers return identical results from the rollup as from events', async () => {
    // Use the mixed ingest from case 1 so we exercise multi-model, NULL-model,
    // and multi-session data in one shot.
    //
    // SES_A in WS1: two distinct models (one with serviceTier) + user lines
    await ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    await ingestLine(WS1, SES_A, assistantLine('a2', 'claude-3-haiku', 200, 80));
    await ingestLine(
      WS1,
      SES_A,
      assistantLine('a3', 'claude-3-opus', 300, 60, { serviceTier: 'batch' }),
    );
    await ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    await ingestLine(WS1, SES_A, userLine('u2', 'world'));

    // SES_B in WS2: single model, no serviceTier, plus user line
    await ingestLine(WS2, SES_B, assistantLine('b1', 'claude-sonnet', 150, 70, { cacheRead: 10 }));
    await ingestLine(WS2, SES_B, assistantLine('b2', 'claude-sonnet', 50, 20));
    await ingestLine(WS2, SES_B, userLine('u3', 'ping'));


    // --- costForSession ---
    // Ground truth from events for SES_A:
    //   - (claude-3-opus, null):  input=100  output=50
    //   - (claude-3-haiku, null): input=200  output=80
    //   - (claude-3-opus, batch): input=300  output=60
    //   - (null, null):           user events, no tokens
    // Total tokens:
    const sesACostGT = {
      inputTokens: 100 + 200 + 300,
      outputTokens: 50 + 80 + 60,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const costA = await costForSession(SES_A);
    expect(costA.inputTokens).toBe(sesACostGT.inputTokens);
    expect(costA.outputTokens).toBe(sesACostGT.outputTokens);
    expect(costA.cacheReadInputTokens).toBe(sesACostGT.cacheReadInputTokens);
    expect(costA.cacheCreationInputTokens).toBe(sesACostGT.cacheCreationInputTokens);
    // USD must be positive (all known models).
    expect(costA.usd).toBeGreaterThan(0);

    // --- costForWorkspace ---
    // WS2 ground truth (SES_B only): claude-sonnet, no tier
    const wsCostGT = {
      inputTokens: 150 + 50,
      outputTokens: 70 + 20,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 0,
    };
    const costWS2 = await costForWorkspace(WS2);
    expect(costWS2.inputTokens).toBe(wsCostGT.inputTokens);
    expect(costWS2.outputTokens).toBe(wsCostGT.outputTokens);
    expect(costWS2.cacheReadInputTokens).toBe(wsCostGT.cacheReadInputTokens);
    expect(costWS2.cacheCreationInputTokens).toBe(wsCostGT.cacheCreationInputTokens);

    // --- listSessions ---
    // Insert session rows so listSessions can find them.
    await queryRows(`INSERT INTO sessions (id, workspace_id) VALUES (?,?) ON CONFLICT DO NOTHING`, [SES_A, WS1]);
    await queryRows(`INSERT INTO sessions (id, workspace_id) VALUES (?,?) ON CONFLICT DO NOTHING`, [SES_B, WS2]);

    const allRows = await listSessions();
    const rowA = allRows.find((r) => r.id === SES_A);
    const rowB = allRows.find((r) => r.id === SES_B);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    // SES_A: eventCount = 5 events (3 assistant + 2 user); must not lose NULL-model events
    expect(rowA!.eventCount).toBe(5);
    expect(rowA!.usd).toBeGreaterThan(0);

    // SES_B: eventCount = 3 (2 assistant + 1 user)
    expect(rowB!.eventCount).toBe(3);
    expect(rowB!.usd).toBeGreaterThan(0);

    // WS2-scoped listSessions should only return SES_B
    const ws2Rows = await listSessions(WS2);
    expect(ws2Rows.every((r) => r.workspaceId === WS2)).toBe(true);
    const rowBScoped = ws2Rows.find((r) => r.id === SES_B);
    expect(rowBScoped).toBeDefined();
    expect(rowBScoped!.eventCount).toBe(rowB!.eventCount);

    // --- summaryForSession ---
    // summaryForSession goes through the summary cache; bypasses it with
    // a non-default topToolsLimit so we get a fresh read from session_costs.
    const summary = await summaryForSession(SES_A, 3);
    expect(summary).not.toBeNull();
    expect(summary!.eventCount).toBe(5);
    expect(summary!.inputTokens).toBe(sesACostGT.inputTokens);
    expect(summary!.outputTokens).toBe(sesACostGT.outputTokens);
    expect(summary!.cacheReadInputTokens).toBe(sesACostGT.cacheReadInputTokens);
    expect(summary!.cacheCreationInputTokens).toBe(sesACostGT.cacheCreationInputTokens);
    expect(summary!.usd).toBeGreaterThan(0);
  });

  it.skipIf(isPg)('listSessions cost query never scans events (EXPLAIN QUERY PLAN pin)', async () => {
    const d = openDb(dir);
    for (const ws of [undefined, 'explain-dummy']) {
      const details = explainPlan(d, listSessionCostsQuery(stateKysely(), ws));
      expect(details).toContain('session_costs');
      expect(details).not.toMatch(/\bevents\b/);
    }
  });

  it.skipIf(isPg)('migration backfill rebuilds from events (drift self-heal)', async () => {
    // Ingest data at version 13 (the normal path).
    await ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    await ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    await ingestLine(WS2, SES_B, assistantLine('b1', 'claude-sonnet', 150, 70, { cacheRead: 10 }));

    // Wind the version back to 12 — simulates a future schema bump that will
    // re-run the v13 block with DROP + rebuild on next open.
    const d = openDb(dir);
    d.pragma('user_version = 12');
    await closeDb();

    // Re-open: migrate() sees current < 13, drops and rebuilds session_costs.
    openDb(dir);
    await expectRollupMatchesEvents();
  });

  it('ingest burst with interleaved summary reads recomputes at most twice (debounce end-to-end)', async () => {
    // Prime the cache once.
    await summaryForSession(SES_A);
    const before = _summaryRecomputesForTests();
    for (let i = 0; i < 200; i++) {
      await ingestLine(WS1, SES_A, assistantLine(`burst-${i}`, 'claude-3-opus', 10, 5));
      await summaryForSession(SES_A); // the renderer-poll stand-in
    }
    // Old policy: ~200 recomputes (every read after every ingest missed).
    // markStale(3s): the first read after the first markStale horizon may
    // recompute once; everything else inside the grace window is a hit.
    expect(_summaryRecomputesForTests() - before).toBeLessThanOrEqual(2);
  });

  it('renameSession invalidates summary cache (fix for missing invalidate call)', async () => {
    // Ingest some data and prime the summary cache.
    await ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    await ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    const summaryBefore = await summaryForSession(SES_A);
    expect(summaryBefore).not.toBeNull();

    // Track recomputes: the next summaryForSession call after renameSession
    // should trigger exactly one recompute (the cache invalidation), proving
    // that renameSession properly invalidated the cached summary.
    const recomputesBefore = _summaryRecomputesForTests();
    await renameSession(SES_A, 'new-name');
    const summaryAfter = await summaryForSession(SES_A);

    // Verify the recompute counter increased by exactly 1.
    expect(_summaryRecomputesForTests() - recomputesBefore).toBe(1);
    // Verify the summary is still valid (not null).
    expect(summaryAfter).not.toBeNull();
    // The summary should remain the same in content (no data changed, just
    // the user_set_name in the sessions table — which doesn't appear in
    // WorkspaceSummary but proves the summary was recomputed from fresh DB state).
  });
});

describe('rename/delete are awaited writes', () => {
  it('deleteSession removes every per-session row in one transaction', async () => {
    await ingestLine('w', 's-del', JSON.stringify({ type: 'assistant', uuid: 'd1', message: { model: 'claude-opus-4-1', usage: { output_tokens: 3 }, content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }));
    await deleteSession('s-del');
    for (const t of ['events', 'session_costs', 'session_stats', 'session_tool_counts', 'sessions']) {
      const col = t === 'sessions' ? 'id' : 'session_id';
      expect((await queryRows(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = 's-del'`))[0]).toEqual({ n: 0 });
    }
  });

  it('renameSession resolves after the row is updated', async () => {
    await ingestLine('w', 's-ren', JSON.stringify({ type: 'user', uuid: 'r1', message: { content: 'hi' } }));
    await renameSession('s-ren', '  Named  ');
    expect((await queryRows('SELECT user_set_name FROM sessions WHERE id = ?', ['s-ren']))[0]).toEqual({ user_set_name: 'Named' });
  });
});
