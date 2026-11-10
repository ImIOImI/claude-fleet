// Retention slice-duration bench: builds a realistic history and records how
// long each throttled slice of a retention pass holds the main thread, per step.
//
// Skipped unless RETENTION_BENCH=1. Prints p50/p95/max per step and writes
// them to RETENTION_BENCH_OUT when set:
//   RETENTION_BENCH=1 RETENTION_BENCH_OUT=/tmp/r.json npx vitest run src/main/state/retentionBench.test.ts
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestLine, stateKysely, withRawSqlite } from '../db.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from '../vectors.js';
import { isPg, openTestState } from '../store/testStore.js';
import {
  compactEmbeddings, createThrottle, DAY_MS, dedupeAttachments, incrementalVacuum, retainEvents, sweepOrphans, type Throttle,
} from './retention.js';

const ON = process.env.RETENTION_BENCH === '1';
const WS = '01KW00000000000000000000WS';
const ORPHAN = '01KW000000000000000000ZZZZ';
const NOW = Date.parse('2026-11-09T00:00:00Z');
const SESSIONS = Number(process.env.RETENTION_BENCH_SESSIONS ?? 12);
const TURNS = Number(process.env.RETENTION_BENCH_TURNS ?? 120);
const EMBEDDINGS = Number(process.env.RETENTION_BENCH_EMBEDDINGS ?? 20_000);

// Deterministic PRNG so runs compare.
let seed = 42;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const WORDS = 'the of and to in is for that on with as was by at from this are be or have an it not which their one all were when can'.split(' ')
  .concat('function const return import export await async interface type string number boolean null undefined error result value'.split(' '));
/** Prose-like text: compresses to roughly a third, like real transcripts. */
const prose = (bytes: number): string => {
  const out: string[] = [];
  let n = 0;
  while (n < bytes) {
    const w = rnd() < 0.15 ? Math.floor(rnd() * 1e9).toString(36) : WORDS[Math.floor(rnd() * WORDS.length)];
    out.push(w);
    n += w.length + 1;
  }
  return out.join(' ');
};
const between = (lo: number, hi: number): number => Math.floor(lo + rnd() * (hi - lo));

/** A few big boilerplate payloads re-recorded every turn (tool lists, instructions). */
const BOILER = Array.from({ length: 6 }, () => prose(between(20_000, 110_000)));

function sessionLines(ses: string, daysAgo: number): string[] {
  const ts = (i: number) => new Date(NOW - daysAgo * DAY_MS + i * 1000).toISOString();
  const ls: string[] = [];
  for (let i = 0; i < TURNS; i++) {
    const id = `${ses}-t${i}`;
    ls.push(JSON.stringify({ type: 'user', uuid: `${id}-u`, timestamp: ts(i * 10), sessionId: ses, message: { content: prose(between(100, 2000)) } }));
    ls.push(JSON.stringify({
      type: 'attachment', uuid: `${id}-at`, timestamp: ts(i * 10 + 1), sessionId: ses,
      attachment: { type: 'deferred_tools_delta', content: BOILER[i % BOILER.length] }, rendered: BOILER[(i + 1) % BOILER.length].slice(0, 8000),
    }));
    ls.push(JSON.stringify({
      type: 'assistant', uuid: `${id}-tu`, timestamp: ts(i * 10 + 2), sessionId: ses,
      message: { model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Write', input: { file_path: `/w/${id}.ts`, content: prose(between(2000, 60_000)) } }] },
    }));
    ls.push(JSON.stringify({
      type: 'user', uuid: `${id}-tr`, timestamp: ts(i * 10 + 3), sessionId: ses,
      message: { content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, is_error: false, content: prose(between(1000, 100_000)) }] },
      toolUseResult: { stdout: prose(between(500, 20_000)) },
    }));
    ls.push(JSON.stringify({
      type: 'assistant', uuid: `${id}-a`, timestamp: ts(i * 10 + 4), sessionId: ses,
      message: { model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: prose(between(200, 4000)) }] },
    }));
  }
  return ls;
}

interface StepStats { slices: number; p50: number; p95: number; max: number; totalMs: number }
const stats = (xs: number[]): StepStats => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  const r = (x: number) => Math.round(x * 10) / 10;
  return { slices: s.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(s.at(-1) ?? 0), totalMs: r(s.reduce((a, b) => a + b, 0)) };
};

describe.skipIf(!ON || isPg)('retention slice bench', () => {
  it('records per-step slice durations', { timeout: 30 * 60_000 }, async () => {
    const state = await openTestState('cf-retention-bench-');
    await withRawSqlite((d) => { d.pragma('auto_vacuum = INCREMENTAL'); d.exec('VACUUM'); });

    // History: SESSIONS old sessions in the live workspace plus one orphaned workspace.
    const originals = new Map<string, string>();
    for (let s = 0; s < SESSIONS; s++) {
      const ws = s === SESSIONS - 1 ? ORPHAN : WS;
      const ses = `ses-${s}`;
      for (const l of sessionLines(ses, 40 + s)) {
        await ingestLine(ws, ses, l);
        const o = JSON.parse(l) as { type: string; uuid: string };
        if (o.type === 'attachment') originals.set(o.uuid, l);
      }
    }
    // Attachment rows as a pre-v17 app stored them: full line, no blob reference.
    const k = stateKysely();
    for (const [uuid, l] of originals) await k.updateTable('events').set({ raw_jsonl: l, raw_z: null, att_ref: null }).where('uuid', '=', uuid).execute();
    await k.deleteFrom('event_blobs').execute();
    // Legacy embeddings: float32 vectors, ~85% zero-vector placeholders.
    const vec = new Float32Array(EMBED_DIM).map((_, i) => Math.sin(i));
    for (let i = 0; i < EMBEDDINGS; i += 500) {
      await k.insertInto('embeddings').values(Array.from({ length: Math.min(500, EMBEDDINGS - i) }, (_, j) => {
        const placeholder = rnd() < 0.85;
        return {
          workspace_id: WS, session_id: 'ses-0', kind: 'turn', ref_event_id: i + j + 1, ts: NOW, text: placeholder ? '' : prose(300),
          model_id: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(placeholder ? new Float32Array(EMBED_DIM) : vec), dedup_key: `e${i + j}`,
        };
      })).execute();
    }

    const durations: Record<string, number[]> = {};
    let step = '';
    // RETENTION_BENCH_TARGET_MS lowers the slice target to emulate a slower host
// (9 ms here ≈ 35 ms on a machine 4× slower); builds without budgets ignore it.
    const targetMs = Number(process.env.RETENTION_BENCH_TARGET_MS ?? 35);
    // Builds with walCheckpointer checkpoint from a worker, as startRetention does.
    const ck = await import('./walCheckpointer.js' as string)
      .then((m: { startWalCheckpointer(p: string): Promise<{ request(): void; close(): Promise<void> } | null> }) => m.startWalCheckpointer(join(state.dir, 'state.db')))
      .catch(() => null);
    const base = createThrottle({ minSleepMs: 0, idleRatio: 0, targetMs, afterSlice: () => ck?.request() } as Parameters<typeof createThrottle>[0]);
    // Pass-through either slice signature, so the same file measures before and after.
    const baseSlice = base.slice as (...args: unknown[]) => Promise<unknown>;
    const t: Throttle = {
      stopped: () => base.stopped(),
      slice: (async (...args: unknown[]) => {
        const t0 = performance.now();
        try {
          return await baseSlice(...args);
        } finally {
          (durations[step] ??= []).push(performance.now() - t0);
        }
      }) as Throttle['slice'],
    };
    const run = async (name: string, fn: () => Promise<unknown>) => { step = name; await fn(); };
    await run('orphans', () => sweepOrphans({ listManifestIds: async () => [WS], stateDirExists: () => false }, t));
    await run('attachments', () => dedupeAttachments(t));
    await run('events', () => retainEvents(NOW, t));
    await run('embeddings', () => compactEmbeddings(t));
    await run('vacuum', () => incrementalVacuum(t));

    await ck?.close();
    const out = Object.fromEntries(Object.entries(durations).map(([s, xs]) => [s, stats(xs)]));
    console.table(out);
    if (process.env.RETENTION_BENCH_OUT) writeFileSync(process.env.RETENTION_BENCH_OUT, JSON.stringify({ ...out, walWorker: ck !== null }, null, 2));
  });
});
