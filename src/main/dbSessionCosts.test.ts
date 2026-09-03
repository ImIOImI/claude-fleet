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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, closeDb, ingestLine, deleteSession } from './db.js';

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

function expectRollupMatchesEvents(d: Database.Database): void {
  expect(d.prepare(ROLLUP_SQL).all()).toEqual(d.prepare(GROUND_TRUTH_SQL).all());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-costs-'));
  openDb(dir);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('session_costs invariant', () => {
  it('mixed ingest: multi-session/multi-workspace rollup matches ground truth', () => {
    // SES_A in WS1: two distinct models, one with a service_tier, plus user lines.
    ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    ingestLine(WS1, SES_A, assistantLine('a2', 'claude-3-haiku', 200, 80));
    ingestLine(
      WS1,
      SES_A,
      assistantLine('a3', 'claude-3-opus', 300, 60, { serviceTier: 'batch' }),
    );
    ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    ingestLine(WS1, SES_A, userLine('u2', 'world'));

    // SES_B in WS2: single model, no service_tier, plus user lines.
    ingestLine(WS2, SES_B, assistantLine('b1', 'claude-sonnet', 150, 70, { cacheRead: 10 }));
    ingestLine(WS2, SES_B, assistantLine('b2', 'claude-sonnet', 50, 20));
    ingestLine(WS2, SES_B, userLine('u3', 'ping'));

    const d = openDb(dir);
    expectRollupMatchesEvents(d);
  });

  it('duplicate replay is a no-op: same uuid re-ingested does not double-count', () => {
    ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    ingestLine(WS1, SES_A, userLine('u1', 'first'));

    const d = openDb(dir);
    // Snapshot the rollup before replay.
    const before = d.prepare(ROLLUP_SQL).all();

    // Re-ingest the exact same assistant line (same uuid = same dedup_key).
    const result = ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    expect(result.inserted).toBe(false);

    // Rollup must be unchanged AND still match ground truth.
    expect(d.prepare(ROLLUP_SQL).all()).toEqual(before);
    expectRollupMatchesEvents(d);
  });

  it('deleteSession removes its rollup rows; peer session remains intact', () => {
    // Two sessions in WS1.
    ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    ingestLine(WS1, SES_B, assistantLine('b1', 'claude-3-haiku', 200, 80));
    ingestLine(WS1, SES_B, userLine('u2', 'world'));

    const d = openDb(dir);

    // Verify both sessions have rollup rows before deletion.
    const rowsBefore = d.prepare(ROLLUP_SQL).all() as Array<{ session_id: string }>;
    expect(rowsBefore.some((r) => r.session_id === SES_A)).toBe(true);
    expect(rowsBefore.some((r) => r.session_id === SES_B)).toBe(true);

    // Delete SES_A.
    deleteSession(SES_A);

    // SES_A gone from session_costs; SES_B intact; ground truth still matches.
    const rowsAfter = d.prepare(ROLLUP_SQL).all() as Array<{ session_id: string }>;
    expect(rowsAfter.some((r) => r.session_id === SES_A)).toBe(false);
    expect(rowsAfter.some((r) => r.session_id === SES_B)).toBe(true);
    expectRollupMatchesEvents(d);
  });

  it('migration backfill rebuilds from events (drift self-heal)', () => {
    // Ingest data at version 13 (the normal path).
    ingestLine(WS1, SES_A, assistantLine('a1', 'claude-3-opus', 100, 50));
    ingestLine(WS1, SES_A, userLine('u1', 'hello'));
    ingestLine(WS2, SES_B, assistantLine('b1', 'claude-sonnet', 150, 70, { cacheRead: 10 }));

    // Wind the version back to 12 — simulates a future schema bump that will
    // re-run the v13 block with DROP + rebuild on next open.
    const d = openDb(dir);
    d.pragma('user_version = 12');
    closeDb();

    // Re-open: migrate() sees current < 13, drops and rebuilds session_costs.
    openDb(dir);
    const d2 = openDb(dir);
    expectRollupMatchesEvents(d2);
  });
});
