// state.db hot-path benchmark — the async store part 2 perf gate.
//
// Skipped unless STATE_BENCH=1. Written against the API both before and after
// the async port (`await` on a sync return is a no-op; `ingestBatch` is used
// when db.ts exports it, else the per-line loop the watcher ran before), so
// the same file measures both sides.
//
// Measure (writes the per-metric medians of RUNS runs):
//   STATE_BENCH=1 STATE_BENCH_OUT=/tmp/b1.json npx vitest run src/main/state/stateBench.test.ts
// Compare (no measuring; each side is the per-metric median of its files):
//   STATE_BENCH=1 STATE_BENCH_BASELINE=/tmp/a1.json,/tmp/a2.json,/tmp/a3.json \
//     STATE_BENCH_CANDIDATE=/tmp/b1.json,/tmp/b2.json,/tmp/b3.json npx vitest run src/main/state/stateBench.test.ts
//
// Machine noise is large (about ±25% on read metrics between quiet and busy
// minutes), so the gate is A/B: baseline and candidate runs alternate in one
// session (the plan's perf-gate task has the loop). Numbers are machine-specific.
//
// embed_insert_us_per_row needs db.insertEmbeddings (the batched insert),
// which exists at the pre-port baseline.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from '../db.js';
import { searchTranscripts } from '../transcriptIndex.js';
import { PerfStore } from '../perfStore.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from '../vectors.js';

const RUNS = 5;
const N_LINES = 6000;
const WATCHER_BATCH = 200;
const N_LIST_SESSIONS = 300;
const N_EMBEDDINGS = 5000;
/** transcriptIndex's EMBED_BATCH: the backfill inserts at most this many rows per call. */
const EMBED_BATCH_ROWS = 8;
const N_LOOKUPS = 2000;
const N_READ_ROUNDS = 50;
const N_WRITES = 500;
const N_PERF_ROWS = 5000;

type Metrics = Record<string, number>;

/** Pass when candidate ≤ baseline × (1 + tol) + slack (slack in the metric's
 *  own unit). Read metrics resolve to about ±25% in the container, so no gate
 *  is tighter than that; the µs-scale metrics also get an absolute slack,
 *  because a few µs of async overhead is a large ratio of a tiny number and
 *  far below one IPC round trip. */
export const GATE: Record<string, { tol: number; slack: number }> = {
  ingest_fresh_us_per_line: { tol: 0.25, slack: 0 },
  ingest_replay_us_per_line: { tol: 0.25, slack: 0 },
  summary_uncached_ms: { tol: 0.25, slack: 0 },
  summary_cached_us: { tol: 0.25, slack: 15 },
  lookup_mapping_us: { tol: 0.25, slack: 15 },
  events_page_ms: { tol: 0.25, slack: 0 },
  list_sessions_ms: { tol: 0.25, slack: 0.15 },
  read_round_stall_ms: { tol: 0.25, slack: 1 },
  search_ms: { tol: 0.25, slack: 0 },
  embed_insert_us_per_row: { tol: 0.25, slack: 0 },
  stall_p50_ms: { tol: 0.25, slack: 2 },
  stall_max_ms: { tol: 0.5, slack: 5 },
  record_mapping_us: { tol: 0.25, slack: 0 },
  record_error_us: { tol: 0.25, slack: 0 },
  perf_flush_ms: { tol: 0.25, slack: 0 },
};

function medianOfFiles(list: string): Metrics {
  const all = list.split(',').map((p) => JSON.parse(readFileSync(p.trim(), 'utf8')) as Metrics);
  const out: Metrics = {};
  for (const k of Object.keys(all[0])) out[k] = median(all.map((m) => m[k]));
  return out;
}

function lines(n: number, sid: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(1_782_864_000_000 + i * 1000).toISOString();
    if (i % 3 === 0) {
      out.push(JSON.stringify({ type: 'assistant', uuid: `${sid}-a${i}`, timestamp: ts, message: {
        model: 'claude-opus-4-1',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, service_tier: 'standard' },
        content: [{ type: 'tool_use', id: `tu${i}`, name: i % 2 ? 'Bash' : 'Read', input: { command: 'ls -la ' + 'x'.repeat(200) } }] } }));
    } else if (i % 3 === 1) {
      out.push(JSON.stringify({ type: 'user', uuid: `${sid}-u${i}`, timestamp: ts, message: { role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu${i - 1}`, is_error: false, content: 'y'.repeat(800) }] } }));
    } else {
      out.push(JSON.stringify({ type: 'user', uuid: `${sid}-p${i}`, timestamp: ts, message: { role: 'user', content: `prompt ${i}` } }));
    }
  }
  return out;
}

/** The watcher's per-batch ingest, on whichever API this db.ts has. */
async function ingestLikeWatcher(ws: string, sid: string, all: string[]): Promise<void> {
  const mod = db as unknown as { ingestBatch?: (w: string, s: string, l: string[]) => Promise<unknown> };
  for (let i = 0; i < all.length; i += WATCHER_BATCH) {
    const batch = all.slice(i, i + WATCHER_BATCH);
    if (mod.ingestBatch) await mod.ingestBatch(ws, sid, batch);
    else for (const l of batch) await db.ingestLine(ws, sid, l);
  }
}

async function time(fn: () => Promise<unknown> | unknown): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

/** Gaps between consecutive 0 ms timer ticks: how long the loop went without
 *  reaching its timers phase. Under load (ingest + readers running
 *  concurrently), the median reflects both; it is not an idle floor — run it
 *  with nothing else competing to measure one side alone. */
function stallProbe(): { stop: () => number[] } {
  const gaps: number[] = [];
  let last = performance.now();
  let on = true;
  const tick = (): void => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (on) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return { stop: () => { on = false; return gaps; } };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function oneRun(): Promise<Metrics> {
  const dir = mkdtempSync(join(tmpdir(), 'cf-state-bench-'));
  const m: Metrics = {};
  try {
    const raw = db.openDb(dir);
    const big = lines(N_LINES, 'big');
    m.ingest_fresh_us_per_line = ((await time(() => ingestLikeWatcher('ws', 'big', big))) * 1000) / N_LINES;
    m.ingest_replay_us_per_line = ((await time(() => ingestLikeWatcher('ws', 'big', big))) * 1000) / N_LINES;

    // summaryForSession with a non-default topTools limit bypasses the cache: the recompute cost.
    const sums: number[] = [];
    for (let i = 0; i < 100; i++) sums.push(await time(() => db.summaryForSession('big', 6)));
    m.summary_uncached_ms = median(sums);
    await db.learnBrokerSessionMapping('ws', 'tab-big', 'big');
    const hits: number[] = [];
    for (let i = 0; i < 200; i++) hits.push(await time(() => db.summaryForBrokerSession('ws', 'tab-big')));
    m.summary_cached_us = median(hits) * 1000;
    m.lookup_mapping_us = ((await time(async () => {
      for (let i = 0; i < N_LOOKUPS; i++) await db.lookupBrokerSession('ws', 'tab-big');
    })) * 1000) / N_LOOKUPS;
    const pages: number[] = [];
    for (let i = 0; i < 50; i++) pages.push(await time(() => db.eventsForSession('big', 0, 500)));
    m.events_page_ms = median(pages);

    for (let s = 0; s < N_LIST_SESSIONS; s++) await ingestLikeWatcher(`ws${s % 7}`, `s${s}`, lines(20, `s${s}`));
    const lists: number[] = [];
    for (let i = 0; i < 30; i++) lists.push(await time(() => db.listSessions()));
    m.list_sessions_ms = median(lists);

    // Event-loop stall while a fresh session ingests with readers polling alongside.
    let ingesting = true;
    const loop = stallProbe();
    const ingest = (async () => {
      const all = lines(N_LINES, 'stall');
      // The watcher's async file read between batches is a macrotask boundary.
      for (let i = 0; i < all.length; i += WATCHER_BATCH) {
        await ingestLikeWatcher('ws', 'stall', all.slice(i, i + WATCHER_BATCH));
        await new Promise<void>((r) => setImmediate(r));
      }
    })().finally(() => { ingesting = false; });
    const readers = (async () => {
      while (ingesting) {
        await db.summaryForSession('big', 6);
        await db.listSessions();
        await db.eventsForSession('big', 0, 200);
        await new Promise<void>((r) => setImmediate(r));
      }
    })();
    await Promise.all([ingest, readers]);
    const gaps = loop.stop().sort((a, b) => a - b);
    m.stall_p50_ms = median(gaps);
    m.stall_max_ms = gaps[gaps.length - 1];

    // Reader-only stall: no concurrent ingest, so each probe gap is ~one reader round.
    // stall_p50_ms above can't isolate a reader regression — it's dominated by ingest.
    const readLoop = stallProbe();
    for (let i = 0; i < N_READ_ROUNDS; i++) {
      await db.summaryForSession('big', 6);
      await db.listSessions();
      await db.eventsForSession('big', 0, 200);
      await new Promise<void>((r) => setImmediate(r));
    }
    m.read_round_stall_ms = median(readLoop.stop());

    const rows = Array.from({ length: N_EMBEDDINGS }, (_, i) => {
      const vec = new Float32Array(EMBED_DIM);
      vec[i % EMBED_DIM] = 1;
      return { workspaceId: `ws${i % 7}`, sessionId: `s${i % N_LIST_SESSIONS}`, kind: 'turn' as const, refEventId: i, ts: i,
        text: `turn ${i}`, modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(vec), dedupKey: `t${i}` };
    });
    m.embed_insert_us_per_row = ((await time(async () => {
      for (let i = 0; i < rows.length; i += EMBED_BATCH_ROWS) await db.insertEmbeddings(rows.slice(i, i + EMBED_BATCH_ROWS));
    })) * 1000) / N_EMBEDDINGS;
    const embed = async (texts: string[]) => texts.map(() => { const v = new Float32Array(EMBED_DIM); v[3] = 1; return v; });
    const allowed = new Set(Array.from({ length: 7 }, (_, i) => `ws${i}`));
    const searches: number[] = [];
    for (let i = 0; i < 10; i++) searches.push(await time(() => searchTranscripts('q', allowed, embed, { limit: 10 }, raw)));
    m.search_ms = median(searches);

    m.record_mapping_us = ((await time(async () => {
      for (let i = 0; i < N_WRITES; i++) await db.recordBrokerSessionMapping('ws', `tab-${i}`, `s${i % N_LIST_SESSIONS}`);
    })) * 1000) / N_WRITES;
    m.record_error_us = ((await time(async () => {
      for (let i = 0; i < N_WRITES; i++) await db.recordError({ ts: i, source: 'main', type: 'bench', message: 'm' });
    })) * 1000) / N_WRITES;

    // Pre-port PerfStore takes the raw handle; the ported one (it has a
    // flushChain field) takes the Kysely handle.
    const probe = new PerfStore(raw as never);
    const store = 'flushChain' in probe
      ? new PerfStore((db as unknown as { stateKysely: () => unknown }).stateKysely() as never)
      : probe;
    for (let i = 0; i < N_PERF_ROWS; i++) store.enqueue({ ts: i, kind: 'stall', durMs: 60, meta: { p50: 1 } });
    m.perf_flush_ms = await time(() => store.flush());
    return m;
  } finally {
    await db.closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.STATE_BENCH !== '1')('state.db hot-path benchmark', () => {
  it('measures every hot path (median of RUNS), or compares saved runs', async () => {
    if (process.env.STATE_BENCH_BASELINE && process.env.STATE_BENCH_CANDIDATE) {
      const base = medianOfFiles(process.env.STATE_BENCH_BASELINE);
      const cand = medianOfFiles(process.env.STATE_BENCH_CANDIDATE);
      const rows = Object.keys(GATE).map((k) => ({
        metric: k, baseline: base[k], candidate: cand[k], change: `${(((cand[k] - base[k]) / base[k]) * 100).toFixed(1)}%`,
        limit: `+${GATE[k].tol * 100}%${GATE[k].slack ? ` +${GATE[k].slack}` : ''}`,
        ok: cand[k] <= base[k] * (1 + GATE[k].tol) + GATE[k].slack,
      }));
      console.log('STATE_BENCH_COMPARE ' + JSON.stringify(rows, null, 2));
      expect(rows.filter((r) => !r.ok).map((r) => r.metric)).toEqual([]);
      return;
    }
    const runs: Metrics[] = [];
    for (let r = 0; r < RUNS; r++) runs.push(await oneRun());
    const result: Metrics = {};
    for (const k of Object.keys(runs[0])) result[k] = Number(median(runs.map((x) => x[k])).toFixed(3));
    console.log('STATE_BENCH ' + JSON.stringify(result));
    if (process.env.STATE_BENCH_OUT) writeFileSync(process.env.STATE_BENCH_OUT, JSON.stringify(result, null, 2) + '\n');
  }, 600_000);
});
