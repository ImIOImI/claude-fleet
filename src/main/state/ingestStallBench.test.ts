// Host-scale bench for the per-ingest work (#583): ingest one batch into a hot
// session, then the three things that follow it on the host — the summary
// broadcast, watcher-triggered turn/summary indexing, and the renderer's
// sessions:list. Reports per-phase sync SQLite ms (p50/p95) and the costliest
// statements.
//
// Skipped unless INGEST_STALL_BENCH=1. The DB (~350k events, 1,500 sessions,
// three 20k-event hot sessions) takes a few minutes to build; set
// INGEST_STALL_DB=<dir> to build once and reuse it (the bench copies it per run).
//   INGEST_STALL_BENCH=1 INGEST_STALL_DB=/tmp/isb npx vitest run src/main/state/ingestStallBench.test.ts
import { describe, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from '../db.js';
import { setSqliteQueryObserver } from '../store/kysely.js';
import { indexSessionTurnsWith } from '../transcriptIndexCore.js';
import { indexSessionSummaries } from '../transcriptIndex.js';
import { EMBED_DIM, EMBED_MODEL_ID, EMPTY_VECTOR, encodeVector } from '../vectors.js';

const ON = process.env.INGEST_STALL_BENCH === '1';
const N_SESSIONS = 1500;
const HOT = ['hot0', 'hot1', 'hot2'];
const HOT_EVENTS = 20_000;
const COLD_EVENTS = 190; // ≈ 1,497 × 190 + 60k ≈ 345k events
const WORKSPACES = 6;
const T0 = 1_780_000_000_000;
const ROUNDS = Number(process.env.INGEST_STALL_ROUNDS ?? 30);
const BATCH = 12;
/** ~64% of the line mix is user/assistant: 12,500 lines ≈ 8k turns. */
const DRAIN_LINES = 12_500;

const pad = (n: number, c = 'x') => c.repeat(n);
const ATT = Array.from({ length: 8 }, (_, v) => ({
  type: 'deferred_tools_delta',
  added: Array.from({ length: 120 }, (_, t) => ({ name: `mcp__s__tool_${v}_${t}`, description: pad(100, 'd') })),
}));

/** One transcript line of the host's type mix: attachment 18%, tool_result 21%, tool_use 21%, assistant text 19%, user 3%, other 18%. */
function line(sid: string, i: number, ts: number): string {
  const base = { uuid: `${sid}-${i}`, parentUuid: `${sid}-${i - 1}`, sessionId: sid, timestamp: new Date(ts).toISOString(), cwd: '/workspace' };
  const r = i % 100;
  if (r < 18) return JSON.stringify({ ...base, type: 'attachment', attachment: ATT[i % ATT.length], rendered: [{ content: pad(3000, 'r') + (i % 8) }] });
  if (r < 39) {
    return JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${sid}-tu${i - 1}`, is_error: i % 37 === 0, content: pad(4500, 'y') }] } });
  }
  if (r < 60) {
    return JSON.stringify({ ...base, type: 'assistant', message: { model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500, service_tier: 'standard' },
      content: [{ type: 'tool_use', id: `${sid}-tu${i}`, name: ['Bash', 'Read', 'Edit', 'Grep'][i % 4], input: { command: 'ls -la ' + pad(300), file_path: `/workspace/f${i % 50}.ts` } }] } });
  }
  if (r < 79) {
    return JSON.stringify({ ...base, type: 'assistant', message: { model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 200, service_tier: 'standard' },
      content: [{ type: 'text', text: `answer ${i} ` + pad(2500, 'a') }] } });
  }
  if (r < 82) return JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: `prompt ${i} ` + pad(300, 'p') } });
  return JSON.stringify({ ...base, type: ['queue-operation', 'system', 'last-prompt', 'file-history-snapshot'][i % 4], content: pad(400, 'o') });
}

async function ingestSession(ws: string, sid: string, from: number, n: number, t0: number): Promise<void> {
  const all: string[] = [];
  for (let i = from; i < from + n; i++) all.push(line(sid, i, t0 + i * 2000));
  for (let i = 0; i < all.length; i += 500) await db.ingestBatch(ws, sid, all.slice(i, i + 500));
}

/** Every user/assistant event gets its turn embedding (a placeholder unless it carries text), as the host's backfill leaves it. */
async function embedAll(): Promise<void> {
  await db.withRawSqlite((d) => {
    const rows = d.prepare(`SELECT id, workspace_id, session_id, ts, raw_jsonl FROM events WHERE type IN ('user','assistant') ORDER BY id`).all() as Array<{ id: number; workspace_id: string; session_id: string; ts: number; raw_jsonl: string }>;
    const vec = new Float32Array(EMBED_DIM);
    vec[1] = 1;
    const text = encodeVector(vec);
    const ins = d.prepare(`INSERT INTO embeddings (workspace_id, session_id, kind, ref_event_id, ts, text, model_id, dim, vec, dedup_key) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    d.transaction(() => {
      for (const r of rows) {
        const hasText = r.raw_jsonl.includes('"type":"text"') || r.raw_jsonl.includes('"content":"prompt');
        ins.run(r.workspace_id, r.session_id, 'turn', r.id, r.ts, hasText ? 'answer text' : '', EMBED_MODEL_ID, EMBED_DIM, hasText ? text : EMPTY_VECTOR, `t${r.id}`);
      }
    })();
  });
}

async function build(dir: string): Promise<void> {
  db.openDb(dir);
  for (let s = 0; s < N_SESSIONS; s++) {
    const sid = s < HOT.length ? HOT[s] : `s${s}`;
    await ingestSession(`ws${s % WORKSPACES}`, sid, 0, s < HOT.length ? HOT_EVENTS : COLD_EVENTS, T0 + s * 60_000);
  }
  for (let s = 0; s < 400; s++) {
    await db.withRawSqlite((d) => d.prepare(`INSERT INTO session_summaries (session_id, workspace_id, generated_at, source_max_event_id, summary, model, tags) VALUES (?,?,?,?,?,?,?)`)
      .run(`s${s + 3}`, `ws${(s + 3) % WORKSPACES}`, T0 + s, s * 100, `chapter ${s}`, 'haiku', '["perf","db"]'));
  }
  await embedAll();
  await indexSessionSummaries(async (t) => t.map(() => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; }));
  await db.closeDb();
}

type Stmt = { sql: string; ms: number };
let current: Stmt[] | null = null;
setSqliteQueryObserver((sql, ms) => { current?.push({ sql, ms }); });

async function phase<T>(fn: () => Promise<T>): Promise<{ ms: number; stmts: Stmt[] }> {
  current = [];
  await fn();
  const stmts = current;
  current = null;
  return { ms: stmts.reduce((a, s) => a + s.ms, 0), stmts };
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

describe.skipIf(!ON)('ingest stall bench (#583)', () => {
  it('per-ingest sync SQLite cost at host scale', async () => {
    const base = process.env.INGEST_STALL_DB ?? mkdtempSync(join(tmpdir(), 'cf-isb-'));
    if (!existsSync(join(base, 'state.db'))) {
      mkdirSync(base, { recursive: true });
      const t = performance.now();
      await build(base);
      console.log(`built ${base} in ${((performance.now() - t) / 1000).toFixed(0)} s`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'cf-isb-run-'));
    copyFileSync(join(base, 'state.db'), join(dir, 'state.db'));
    db.openDb(dir);
    try {
      const embed = async (texts: string[]) => texts.map(() => { const v = new Float32Array(EMBED_DIM); v[2] = 1; return v; });
      const span = <T,>(_n: string, fn: () => Promise<T>) => fn();
      const phases: Record<string, number[]> = { ingest: [], broadcast: [], summary_uncached: [], index_turns: [], index_summaries: [], list_ws: [], list_all: [] };
      const top = new Map<string, number[]>();
      const note = (name: string, r: { ms: number; stmts: Stmt[] }) => {
        phases[name].push(r.ms);
        for (const s of r.stmts) {
          const k = `${name} | ${s.sql.replace(/\s+/g, ' ').slice(0, 160)}`;
          (top.get(k) ?? top.set(k, []).get(k)!).push(s.ms);
        }
      };
      let next = HOT_EVENTS;
      for (let r = 0; r < ROUNDS; r++) {
        const sid = HOT[r % HOT.length];
        const ws = `ws${HOT.indexOf(sid) % WORKSPACES}`;
        note('ingest', await phase(() => ingestSession(ws, sid, next, BATCH, T0 + 10 ** 9)));
        next += BATCH;
        note('broadcast', await phase(() => db.summaryForWorkspace(ws)));
        // A non-default topTools limit bypasses the cache: the recompute a broadcast pays once the grace expires.
        note('summary_uncached', await phase(() => db.summaryForSession(sid, 6)));
        note('index_turns', await phase(() => indexSessionTurnsWith(span, sid, embed)));
        note('index_summaries', await phase(() => indexSessionSummaries(embed)));
        note('list_ws', await phase(() => db.listSessions(ws)));
        note('list_all', await phase(() => db.listSessions()));
      }
      // Backlog drain: a session with ~8k unembedded turns indexed in EMBED_BATCH reads.
      await ingestSession('ws0', 'drain', 0, DRAIN_LINES, T0 + 2 * 10 ** 9);
      const drain = await phase(() => indexSessionTurnsWith(span, 'drain', embed));
      const drainReads = drain.stmts.filter((x) => /left join "embeddings"|"embeddings" as "em" where "em"."ref_event_id"/.test(x.sql));
      console.log(`drain: ${drainReads.length} pending-turn reads, ${drain.ms.toFixed(1)} ms sync total, reads ${drainReads.reduce((a, x) => a + x.ms, 0).toFixed(1)} ms`);
      const out: Record<string, { p50: number; p95: number }> = {};
      for (const [k, xs] of Object.entries(phases)) out[k] = { p50: +pct(xs, 0.5).toFixed(2), p95: +pct(xs, 0.95).toFixed(2) };
      console.table(out);
      const rows = [...top.entries()].map(([k, xs]) => ({ stmt: k, n: xs.length, p50: +pct(xs, 0.5).toFixed(2), p95: +pct(xs, 0.95).toFixed(2) }))
        .sort((a, b) => b.p50 - a.p50).slice(0, 15);
      console.table(rows);
      if (process.env.INGEST_STALL_OUT) writeFileSync(process.env.INGEST_STALL_OUT, JSON.stringify({ phases: out, top: rows, drain: { reads: drainReads.length, sync_ms: drain.ms, read_ms: drainReads.reduce((a, x) => a + x.ms, 0) } }, null, 2));
    } finally {
      await db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 3_600_000);
});
