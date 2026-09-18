// session_stats + session_tool_counts rollup invariant tests (#390).
//
// The invariant: both rollups ≡ GROUP BY over events at every commit boundary.
// These tests exercise the three write paths that must maintain it:
//   1. ingestLine (upsert on new event, no-op on duplicate)
//   2. deleteSession (removes the session's rollup rows)
//   3. migrate() v14 DROP+backfill (drift self-heal after user_version reset)
//
// Task 2 adds:
//   4. Reader equivalence — summaryForSession reads rollups, not events
//   5. EXPLAIN pins — OBSERVED_MAX_SQL + TOP_TOOLS_SQL never mention events
//   6. EXPLAIN pin — LATEST_ASSISTANT_SQL uses a session-prefixed index
//
// NOTE: better-sqlite3 is ABI-broken in this container ("Module did not
// self-register"). The expected local outcome is a fast import failure — CI
// runs the real assertions. Gate locally with `npm run typecheck:node`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  openDb,
  closeDb,
  ingestLine,
  deleteSession,
  summaryForSession,
  OBSERVED_MAX_SQL,
  TOP_TOOLS_SQL,
  LATEST_ASSISTANT_SQL,
} from './db.js';

let dir: string;

// Two sessions for scoping / isolation tests.
const WS1 = '01WS1';
const WS2 = '01WS2';
const SES_A = 'ses-a';
const SES_B = 'ses-b';

// Build an assistant JSONL line with usage metadata. No tool_use content.
function assistantLine(
  uuid: string,
  opts: {
    inputTokens?: number;
    cacheRead?: number;
    cacheCreation?: number;
  } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-01T00:00:00Z',
    message: {
      model: 'claude-sonnet',
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        output_tokens: 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
      },
    },
  });
}

// Build a user JSONL line — no usage, no model, no tool_name → contributes to
// NEITHER session_stats nor session_tool_counts.
function userLine(uuid: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-01T00:00:00Z',
    message: { content },
  });
}

// Build an assistant JSONL line whose message.content[] contains a tool_use
// block. The outer event type is 'assistant'; extractToolDetail() reads
// content[0].type === 'tool_use' and pulls .name → tool_name column.
// This is the shape Claude Code actually writes for tool-call turns.
// The event also carries usage so it participates in session_stats.
function toolUseLine(
  uuid: string,
  toolName: string,
  opts: { inputTokens?: number } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-01T00:00:00Z',
    message: {
      model: 'claude-sonnet',
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [
        {
          type: 'tool_use',
          id: `toolu_${uuid}`,
          name: toolName,
          input: {},
        },
      ],
    },
  });
}

// Ground truth: recompute session_stats directly from events.
const STATS_GROUND_TRUTH_SQL = `
  SELECT session_id,
         COALESCE(MAX(
           COALESCE(input_tokens, 0)
           + COALESCE(cache_read_input_tokens, 0)
           + COALESCE(cache_creation_input_tokens, 0)
         ), 0) AS max_context_tokens
  FROM events WHERE type = 'assistant'
  GROUP BY session_id ORDER BY session_id`;

const STATS_ROLLUP_SQL = `
  SELECT session_id, max_context_tokens FROM session_stats ORDER BY session_id`;

// Ground truth: recompute session_tool_counts directly from events.
const TOOLS_GROUND_TRUTH_SQL = `
  SELECT session_id, tool_name, COUNT(*) AS count
  FROM events WHERE tool_name IS NOT NULL
  GROUP BY session_id, tool_name ORDER BY session_id, tool_name`;

const TOOLS_ROLLUP_SQL = `
  SELECT session_id, tool_name, count FROM session_tool_counts
  ORDER BY session_id, tool_name`;

function expectRollupsMatchEvents(d: Database.Database): void {
  expect(d.prepare(STATS_ROLLUP_SQL).all()).toEqual(d.prepare(STATS_GROUND_TRUTH_SQL).all());
  expect(d.prepare(TOOLS_ROLLUP_SQL).all()).toEqual(d.prepare(TOOLS_GROUND_TRUTH_SQL).all());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-stats-'));
  openDb(dir);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('session_stats + session_tool_counts invariant', () => {
  it('mixed ingest: rollups match ground truth for multi-session, multi-tool data', () => {
    // SES_A: three assistant lines; the second has the highest context count so
    // MAX must pick it, not the last. A sum-instead-of-max bug would fail.
    //   line 1: input=100 + 0 + 0 = 100  (not the max)
    //   line 2: input=50  + 400 + 50 = 500  ← the MAX
    //   line 3: input=200 + 0 + 0 = 200  (not the max)
    ingestLine(WS1, SES_A, assistantLine('a1', { inputTokens: 100 }));
    ingestLine(WS1, SES_A, assistantLine('a2', { inputTokens: 50, cacheRead: 400, cacheCreation: 50 }));
    ingestLine(WS1, SES_A, assistantLine('a3', { inputTokens: 200 }));
    // Add a zero-token assistant line to SES_A AFTER the max—bearing line to prove MAX never lowers.
    //   line 4: input=0 + 0 + 0 = 0  (must not lower the max)
    ingestLine(WS1, SES_A, assistantLine('a4')); // no token opts → all 0
    // Tool calls for SES_A: 'Read' appears twice, 'Edit' once.
    ingestLine(WS1, SES_A, toolUseLine('t1', 'Read'));
    ingestLine(WS1, SES_A, toolUseLine('t2', 'Read'));
    ingestLine(WS1, SES_A, toolUseLine('t3', 'Edit'));
    // User lines contribute to NEITHER rollup.
    ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    ingestLine(WS1, SES_A, userLine('u2', 'world'));

    // SES_B: single assistant line with all-null token fields (→ candidate 0).
    // An assistant line with all-NULL tokens: must produce max_context_tokens=0,
    // not lower any pre-existing max (here it's the only event so 0 is correct).
    ingestLine(WS2, SES_B, assistantLine('b1')); // no token opts → all 0
    // One tool call for SES_B.
    ingestLine(WS2, SES_B, toolUseLine('t4', 'Bash'));

    const d = openDb(dir);
    expectRollupsMatchEvents(d);

    // Spot-check: SES_A max_context_tokens must be 500 (the a2 candidate, not lowered by a4's zeros).
    expect(d.prepare(`SELECT max_context_tokens FROM session_stats WHERE session_id = ?`).get(SES_A))
      .toEqual({ max_context_tokens: 500 });
    // Spot-check: SES_A tool counts are exactly 'Read'=2 and 'Edit'=1.
    expect(d.prepare(`SELECT count FROM session_tool_counts WHERE session_id = ? AND tool_name = ?`)
      .get(SES_A, 'Read'))
      .toEqual({ count: 2 });
    expect(d.prepare(`SELECT count FROM session_tool_counts WHERE session_id = ? AND tool_name = ?`)
      .get(SES_A, 'Edit'))
      .toEqual({ count: 1 });
    // Spot-check: SES_B max_context_tokens is 0 (only b1's zero-token line).
    expect(d.prepare(`SELECT max_context_tokens FROM session_stats WHERE session_id = ?`).get(SES_B))
      .toEqual({ max_context_tokens: 0 });
    // Spot-check: SES_B tool count is exactly 'Bash'=1.
    expect(d.prepare(`SELECT count FROM session_tool_counts WHERE session_id = ? AND tool_name = ?`)
      .get(SES_B, 'Bash'))
      .toEqual({ count: 1 });
  });

  it('sessions with no assistant events have NO session_stats row', () => {
    // Only user lines — no assistant events → no session_stats row.
    ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    ingestLine(WS1, SES_A, userLine('u2', 'world'));

    const d = openDb(dir);
    const statsRows = d.prepare(STATS_ROLLUP_SQL).all() as Array<{ session_id: string }>;
    expect(statsRows.some((r) => r.session_id === SES_A)).toBe(false);

    // Ground-truth query also returns no rows for this session.
    expectRollupsMatchEvents(d);
  });

  it('sessions with no tool calls have no session_tool_counts rows', () => {
    // Only pure assistant lines (no tool_use content) → no tool rows.
    ingestLine(WS1, SES_A, assistantLine('a1', { inputTokens: 100 }));

    const d = openDb(dir);
    const toolRows = d.prepare(TOOLS_ROLLUP_SQL).all() as Array<{ session_id: string }>;
    expect(toolRows.some((r) => r.session_id === SES_A)).toBe(false);

    expectRollupsMatchEvents(d);
  });

  it('duplicate replay is a no-op: same uuid does not inflate max or counts', () => {
    ingestLine(WS1, SES_A, assistantLine('a1', { inputTokens: 100 }));
    ingestLine(WS1, SES_A, toolUseLine('t1', 'Read'));

    const d = openDb(dir);
    const statsBefore = d.prepare(STATS_ROLLUP_SQL).all();
    const toolsBefore = d.prepare(TOOLS_ROLLUP_SQL).all();

    // Re-ingest the exact same lines (same uuid = same dedup_key).
    const r1 = ingestLine(WS1, SES_A, assistantLine('a1', { inputTokens: 100 }));
    const r2 = ingestLine(WS1, SES_A, toolUseLine('t1', 'Read'));
    expect(r1.inserted).toBe(false);
    expect(r2.inserted).toBe(false);

    // Both rollups must be unchanged AND still match ground truth.
    expect(d.prepare(STATS_ROLLUP_SQL).all()).toEqual(statsBefore);
    expect(d.prepare(TOOLS_ROLLUP_SQL).all()).toEqual(toolsBefore);
    expectRollupsMatchEvents(d);
  });

  it('deleteSession removes only that session from both rollup tables', () => {
    // Two sessions in WS1.
    ingestLine(WS1, SES_A, assistantLine('a1', { inputTokens: 100 }));
    ingestLine(WS1, SES_A, toolUseLine('t1', 'Read'));
    ingestLine(WS1, SES_B, assistantLine('b1', { inputTokens: 200 }));
    ingestLine(WS1, SES_B, toolUseLine('t2', 'Edit'));

    const d = openDb(dir);

    // Verify both sessions have rollup rows before deletion.
    const statsA = d
      .prepare(`SELECT session_id FROM session_stats WHERE session_id = ?`)
      .get(SES_A);
    const statsB = d
      .prepare(`SELECT session_id FROM session_stats WHERE session_id = ?`)
      .get(SES_B);
    expect(statsA).toBeTruthy();
    expect(statsB).toBeTruthy();

    // Delete SES_A.
    deleteSession(SES_A);

    // SES_A gone from both tables; SES_B intact.
    expect(
      d.prepare(`SELECT session_id FROM session_stats WHERE session_id = ?`).get(SES_A),
    ).toBeUndefined();
    expect(
      d.prepare(`SELECT session_id FROM session_tool_counts WHERE session_id = ?`).get(SES_A),
    ).toBeUndefined();
    expect(
      d.prepare(`SELECT session_id FROM session_stats WHERE session_id = ?`).get(SES_B),
    ).toBeTruthy();
    expect(
      d.prepare(`SELECT session_id FROM session_tool_counts WHERE session_id = ?`).get(SES_B),
    ).toBeTruthy();

    // Ground truth (events now only has SES_B rows) must still match rollup.
    expectRollupsMatchEvents(d);
  });

  it('migration rebuild reconstructs both tables and index from events', () => {
    // Ingest data at v14 (normal path).
    ingestLine(WS1, SES_A, assistantLine('a1', { inputTokens: 100 }));
    ingestLine(WS1, SES_A, toolUseLine('t1', 'Read'));
    ingestLine(WS2, SES_B, assistantLine('b1', { inputTokens: 200, cacheRead: 50 }));
    ingestLine(WS2, SES_B, toolUseLine('t2', 'Bash'));

    // Wind user_version back to 13 — simulates re-running the v14 block with
    // DROP + rebuild on next open (same drift self-heal as v13 did for costs).
    const d = openDb(dir);
    d.pragma('user_version = 13');
    closeDb();

    // Re-open: migrate() sees current < 14, drops and rebuilds both tables.
    openDb(dir);
    const d2 = openDb(dir);

    expectRollupsMatchEvents(d2);

    // The composite index must exist after migration.
    const idx = d2
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_session_type'`,
      )
      .get();
    expect(idx).toBeTruthy();
  });
});

describe('summary reader equivalence + EXPLAIN pins (Task 2)', () => {
  it('summaryForSession reads max/topTools from rollups, not events', () => {
    // Reproduce case-1 data (same as 'mixed ingest' above) so we can assert
    // hardcoded expected values derived from the known fixture.
    //   SES_A max: a2's 50+400+50 = 500 (the winner; a3=200, a4=0 don't lower it)
    //   SES_A tools: Read=2, Edit=1 (count desc then name asc)
    //   SES_B max: 0  (b1's all-zero line)
    //   SES_B tools: [{name:'Bash', count:1}]
    ingestLine(WS1, SES_A, assistantLine('a1', { inputTokens: 100 }));
    ingestLine(WS1, SES_A, assistantLine('a2', { inputTokens: 50, cacheRead: 400, cacheCreation: 50 }));
    ingestLine(WS1, SES_A, assistantLine('a3', { inputTokens: 200 }));
    ingestLine(WS1, SES_A, assistantLine('a4'));
    ingestLine(WS1, SES_A, toolUseLine('t1', 'Read'));
    ingestLine(WS1, SES_A, toolUseLine('t2', 'Read'));
    ingestLine(WS1, SES_A, toolUseLine('t3', 'Edit'));
    ingestLine(WS1, SES_A, userLine('u1', 'hello'));

    ingestLine(WS2, SES_B, assistantLine('b1'));
    ingestLine(WS2, SES_B, toolUseLine('t4', 'Bash'));

    const summaryA = summaryForSession(SES_A);
    expect(summaryA).not.toBeNull();

    // contextWindowTokens: contextWindowFor('claude-sonnet', 500) → 200_000
    // (500 ≤ 200K family window, [1m] marker absent)
    expect(summaryA!.contextWindowTokens).toBe(200_000);

    // topTools must be count-desc, then name-asc for ties (deterministic).
    // Read=2 first, Edit=1 second — no ties here.
    expect(summaryA!.topTools).toEqual([
      { name: 'Read', count: 2 },
      { name: 'Edit', count: 1 },
    ]);

    const summaryB = summaryForSession(SES_B);
    expect(summaryB).not.toBeNull();
    // SES_B has only zero-token assistant events → observedMax=0 → 200K window.
    expect(summaryB!.contextWindowTokens).toBe(200_000);
    expect(summaryB!.topTools).toEqual([{ name: 'Bash', count: 1 }]);
  });

  it('session with no assistant events: absent-row semantics yield safe defaults', () => {
    // Only user lines — no assistant events. session_stats has no row for SES_A.
    // summaryForSession must not throw and must expose:
    //   contextWindowTokens = 200_000 (contextWindowFor(null, 0))
    //   topTools = []
    //   lastTurnContextTokens = null
    ingestLine(WS1, SES_A, userLine('u1', 'hello'));

    const summary = summaryForSession(SES_A);
    expect(summary).not.toBeNull();
    expect(summary!.contextWindowTokens).toBe(200_000);
    expect(summary!.topTools).toEqual([]);
    expect(summary!.lastTurnContextTokens).toBeNull();
  });

  it('observedMax/topTools EXPLAIN plans never touch events', () => {
    // Pin: both rollup queries must be served from their tables, not events.
    // If either plan mentions 'events', a future schema drift broke the query.
    const d = openDb(dir);

    // OBSERVED_MAX_SQL has one ? (session_id).
    const maxPlan = d
      .prepare(`EXPLAIN QUERY PLAN ${OBSERVED_MAX_SQL}`)
      .all('x') as Array<{ detail: string }>;
    const maxDetails = maxPlan.map((r) => r.detail).join(' | ');
    expect(maxDetails).not.toMatch(/\bevents\b/);

    // TOP_TOOLS_SQL has two ? (session_id, limit).
    const toolsPlan = d
      .prepare(`EXPLAIN QUERY PLAN ${TOP_TOOLS_SQL}`)
      .all('x', 5) as Array<{ detail: string }>;
    const toolsDetails = toolsPlan.map((r) => r.detail).join(' | ');
    expect(toolsDetails).not.toMatch(/\bevents\b/);
  });

  it('LATEST_ASSISTANT_SQL EXPLAIN plan uses a session-prefixed index', () => {
    // Pin: the query must use idx_events_session_type (or idx_events_session_ts)
    // and must NOT use the bare idx_events_type index (which scans the entire
    // table for assistant events across all sessions).
    const d = openDb(dir);

    const plan = d
      .prepare(`EXPLAIN QUERY PLAN ${LATEST_ASSISTANT_SQL}`)
      .all('x') as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail).join(' | ');

    // Must use a session-prefixed index (session_type or session_ts).
    expect(details).toMatch(/idx_events_session_type|idx_events_session_ts/);
    // Must NOT fall back to the bare type index (no session prefix → table scan).
    expect(details).not.toMatch(/\bidx_events_type\b/);
  });
});
