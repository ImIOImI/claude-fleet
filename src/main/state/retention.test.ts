import { describe, it, expect, beforeEach } from 'vitest';
import {
  costForSession, eventsForSession, ingestLine, insertEmbedding, maintenanceGet, maxEmbeddingId, recentToolCallsForSession,
  recordUsageEvent, retentionKeys, searchEmbeddings, stateKysely, withRawSqlite,
} from '../db.js';
import { encodeVector, EMBED_DIM, EMBED_MODEL_ID } from '../vectors.js';
import { indexSessionTurns } from '../transcriptIndex.js';
import { openTestState, queryRows, isPg } from '../store/testStore.js';
import { deflateLine } from './rawCodec.js';
import {
  AdaptiveBatch, compactEmbeddings, createThrottle, DAY_MS, dedupeAttachments, incrementalVacuum, retainEvents, startRetention, type PassResult, type SliceBudget, type Throttle,
} from './retention.js';

const WS = '01WS';
const SES = 'ses-old';
const NOW = Date.parse('2026-11-06T00:00:00Z');
const iso = (daysAgo: number, plusMs = 0) => new Date(NOW - daysAgo * DAY_MS + plusMs).toISOString();

const unthrottled: Throttle = { slice: (_step, fn) => fn({ targetMs: 35, expired: () => false, note: () => undefined }), stopped: () => false };

const toolUse = (id: string, daysAgo: number) => JSON.stringify({
  type: 'assistant', uuid: `a-${id}`, timestamp: iso(daysAgo), sessionId: SES,
  message: {
    model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: `/w/${id}.ts`, content: 'z'.repeat(5000) } }],
  },
});
const toolResult = (id: string, daysAgo: number) => JSON.stringify({
  type: 'user', uuid: `r-${id}`, timestamp: iso(daysAgo, 1000), sessionId: SES,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'y'.repeat(6000) }] },
  toolUseResult: { stdout: 'y'.repeat(6000) },
});
const text = (u: string, daysAgo: number) => JSON.stringify({
  type: 'assistant', uuid: u, timestamp: iso(daysAgo, 2000), sessionId: SES,
  message: { model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'prose '.repeat(200) }] },
});
const small = (u: string, daysAgo: number) => JSON.stringify({ type: 'system', uuid: u, timestamp: iso(daysAgo, 3000), sessionId: SES, subtype: 'x' });

const lines = [toolUse('t1', 40), toolResult('t1', 40), text('x1', 40), small('s1', 40), toolUse('t2', 5), toolResult('t2', 5)];

async function stored(): Promise<Map<string, { raw_jsonl: string; raw_z: unknown }>> {
  const rows = await queryRows<{ uuid: string; raw_jsonl: string; raw_z: unknown }>('SELECT uuid, raw_jsonl, raw_z FROM events');
  return new Map(rows.map((r) => [r.uuid, r]));
}
const isCompressed = (r: { raw_z: unknown }) => r.raw_z != null && (r.raw_z as Buffer).length > 0;

beforeEach(async () => {
  await openTestState('cf-retention-');
});

async function ingestAll(ls = lines): Promise<void> {
  for (const l of ls) await ingestLine(WS, SES, l);
}

describe('retainEvents', () => {
  it('strips and compresses rows older than 30 days, leaves recent rows, keeps rollups', async () => {
    await ingestAll();
    const costBefore = await costForSession(SES);
    const toolsBefore = await recentToolCallsForSession(SES);
    const r = await retainEvents(NOW, unthrottled);
    expect(r.rows).toBeGreaterThan(0);
    expect(r.bytesAfter).toBeLessThan(r.bytesBefore);

    const evs = new Map((await eventsForSession(SES)).map((e) => [e.uuid, e]));
    const stub = JSON.parse(evs.get('r-t1')!.rawJsonl);
    expect(stub.fleetStripped).toBeDefined();
    expect(stub.message.content[0].tool_use_id).toBe('t1');
    expect(JSON.parse(evs.get('a-t1')!.rawJsonl).message.content[0].input.file_path).toBe('/w/t1.ts');
    expect(evs.get('x1')!.rawJsonl).toBe(lines[2]);
    expect(evs.get('s1')!.rawJsonl).toBe(lines[3]);
    expect(evs.get('a-t2')!.rawJsonl).toBe(lines[4]);
    expect(evs.get('r-t2')!.rawJsonl).toBe(lines[5]);

    const raw = await stored();
    expect(isCompressed(raw.get('x1')!)).toBe(!isPg);
    expect(isCompressed(raw.get('r-t1')!)).toBe(!isPg);
    expect(isCompressed(raw.get('s1')!)).toBe(false);
    expect(isCompressed(raw.get('r-t2')!)).toBe(false);
    if (!isPg) expect(raw.get('x1')!.raw_jsonl).toBe('');

    expect(await costForSession(SES)).toEqual(costBefore);
    expect(await recentToolCallsForSession(SES)).toEqual(toolsBefore);
  });

  it('keeps a stripped row stripped when its original line is ingested again', async () => {
    await ingestAll();
    await retainEvents(NOW, unthrottled);
    expect((await ingestLine(WS, SES, lines[1])).inserted).toBe(false);
    const ev = (await eventsForSession(SES)).find((e) => e.uuid === 'r-t1')!;
    expect(JSON.parse(ev.rawJsonl).fleetStripped).toBeDefined();
  });

  it('strips a resumed session only after 90 days, and catches up when it ages out', async () => {
    await ingestAll();
    await recordUsageEvent({ workspaceId: WS, sessionId: SES, kind: 'resumed' });
    await retainEvents(NOW, unthrottled);
    let ev = (await eventsForSession(SES)).find((e) => e.uuid === 'r-t1')!;
    expect(ev.rawJsonl).toBe(lines[1]);
    expect(isCompressed((await stored()).get('r-t1')!)).toBe(!isPg);

    await retainEvents(NOW + 60 * DAY_MS, unthrottled);
    ev = (await eventsForSession(SES)).find((e) => e.uuid === 'r-t1')!;
    expect(JSON.parse(ev.rawJsonl).fleetStripped).toBeDefined();
    expect(JSON.parse((await eventsForSession(SES)).find((e) => e.uuid === 'r-t2')!.rawJsonl).fleetStripped).toBeUndefined();
  });

  it('advances watermarks so a repeat pass writes nothing', async () => {
    await ingestAll();
    await retainEvents(NOW, unthrottled);
    expect((await retainEvents(NOW, unthrottled)).rows).toBe(0);
    const [w] = await queryRows<{ compressed_before: unknown; stripped_before: unknown }>(
      'SELECT compressed_before, stripped_before FROM event_retention WHERE session_id = ?', [SES]);
    expect(Number(w.compressed_before)).toBe(NOW - 30 * DAY_MS);
    expect(Number(w.stripped_before)).toBe(NOW - 30 * DAY_MS);
  });

  it('stops between slices and finishes on the next pass', async () => {
    const many = Array.from({ length: 30 }, (_, i) => toolResult(`m${i}`, 40));
    await ingestAll(many);
    let n = 0;
    const stopAfterOne: Throttle = { slice: (_step, fn) => { n++; return fn({ targetMs: 35, expired: () => false, note: () => undefined }); }, stopped: () => n >= 1 };
    await retainEvents(NOW, stopAfterOne, { sliceRows: 10 });
    const strippedNow = (await eventsForSession(SES)).filter((e) => JSON.parse(e.rawJsonl).fleetStripped).length;
    expect(strippedNow).toBe(10);
    expect(await queryRows('SELECT session_id FROM event_retention')).toEqual([]);
    await retainEvents(NOW, unthrottled, { sliceRows: 10 });
    expect((await eventsForSession(SES)).filter((e) => JSON.parse(e.rawJsonl).fleetStripped).length).toBe(30);
  });
});

describe('compactEmbeddings', () => {
  const vecOf = (seed: number): Float32Array => {
    const v = new Float32Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) v[i] = Math.sin(seed * 31 + i);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };

  async function seed(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const row = {
        workspaceId: WS, sessionId: SES, kind: 'turn' as const, refEventId: i + 1, ts: NOW, text: i % 2 ? '' : `turn ${i}`,
        modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(i % 2 ? new Float32Array(EMBED_DIM) : vecOf(i)), dedupKey: `t${i + 1}`,
      };
      if (isPg) await insertEmbedding(row);
      // Legacy rows: float32 vectors and zero-vector placeholders, as stored before v16.
      else await stateKysely().insertInto('embeddings').values({
        workspace_id: row.workspaceId, session_id: row.sessionId, kind: row.kind, ref_event_id: row.refEventId, ts: row.ts,
        text: row.text, model_id: row.modelId, dim: row.dim, vec: row.vec, dedup_key: row.dedupKey,
      }).execute();
    }
  }

  it('drops placeholder vectors, int8-encodes the rest (SQLite), and keeps ranking', async () => {
    await seed();
    const q = vecOf(2);
    const before = (await searchEmbeddings(q, [WS], { limit: 3 })).map((h) => h.text);
    const r = await compactEmbeddings(unthrottled, { sliceRows: 2 });
    expect(r.rows).toBe(isPg ? 2 : 5);
    const rows = await queryRows<{ text: string; n: unknown }>(
      isPg ? 'SELECT text, CASE WHEN vec IS NULL THEN 0 ELSE 1 END AS n FROM embeddings ORDER BY id'
           : 'SELECT text, length(vec) AS n FROM embeddings ORDER BY id');
    for (const row of rows) {
      if (row.text === '') expect(Number(row.n)).toBe(0);
      else expect(Number(row.n)).toBe(isPg ? 1 : EMBED_DIM + 4);
    }
    expect((await searchEmbeddings(q, [WS], { limit: 3 })).map((h) => h.text)).toEqual(before);
    expect(await maintenanceGet('embeddings.compacted_through_id')).toBe(String(await maxEmbeddingId()));
    expect((await compactEmbeddings(unthrottled)).rows).toBe(0);
  });

  it('stores new placeholders without a vector', async () => {
    await ingestLine(WS, SES, toolResult('p1', 1));
    await indexSessionTurns(SES, async (texts) => texts.map(() => vecOf(9)));
    const [row] = await queryRows<{ n: unknown }>(
      isPg ? 'SELECT CASE WHEN vec IS NULL THEN 0 ELSE 1 END AS n FROM embeddings' : 'SELECT length(vec) AS n FROM embeddings');
    expect(Number(row.n)).toBe(0);
  });
});

describe('createThrottle', () => {
  it('sleeps max(250, 9 × slice time) after each slice', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const t = createThrottle({ now: () => clock, sleep: async (ms) => { sleeps.push(ms); } });
    await t.slice('x', async () => { clock += 10; });
    await t.slice('x', async () => { clock += 100; });
    expect(sleeps).toEqual([250, 900]);
  });

  it('gives each slice a budget that expires at the target', async () => {
    let clock = 0;
    const t = createThrottle({ now: () => clock, sleep: async () => undefined, targetMs: 35 });
    const seen: boolean[] = [];
    await t.slice('x', async (b) => {
      seen.push(b.expired());
      clock += 34;
      seen.push(b.expired());
      clock += 1;
      seen.push(b.expired());
    });
    // A new slice starts a fresh budget.
    await t.slice('x', async (b) => { seen.push(b.expired()); });
    expect(seen).toEqual([false, false, true, false]);
  });

  it('stop() cuts a sleep short and marks the throttle stopped', async () => {
    const t = createThrottle({ minSleepMs: 60_000 });
    const p = t.slice('x', async () => 1);
    await new Promise((r) => setTimeout(r, 10));
    t.stop();
    await expect(p).resolves.toBe(1);
    expect(t.stopped()).toBe(true);
  });
});

describe('AdaptiveBatch', () => {
  it('cuts in proportion on overshoot, grows slowly while well under, and stays in bounds', () => {
    const b = new AdaptiveBatch(1000, 10, 2000);
    b.observe(350, 35); // 10× over: 1000 × 35/350 × 0.8
    expect(b.size).toBe(80);
    b.observe(30, 35); // under target but not well under: unchanged
    expect(b.size).toBe(80);
    b.observe(5, 35);
    expect(b.size).toBe(100);
    b.observe(100_000, 35);
    expect(b.size).toBe(10);
    for (let i = 0; i < 100; i++) b.observe(1, 35);
    expect(b.size).toBe(2000);
  });
});

/** A throttle whose budget is spent before the slice starts: each slice may do only its one guaranteed unit. */
function spentThrottle(): Throttle & { slices: number; steps: string[] } {
  const t = {
    slices: 0,
    steps: [] as string[],
    slice: <T>(step: string, fn: (b: SliceBudget) => Promise<T>) => {
      t.slices++;
      t.steps.push(step);
      return fn({ targetMs: 35, expired: () => true, note: () => undefined });
    },
    stopped: () => false,
  };
  return t;
}

describe('slice budgets', () => {
  it('events: a spent budget still advances one row per slice and finishes every row once', async () => {
    const many = Array.from({ length: 12 }, (_, i) => toolResult(`b${i}`, 40));
    await ingestAll(many);
    const t = spentThrottle();
    const r = await retainEvents(NOW, t);
    expect(r.rows).toBe(12);
    expect((await eventsForSession(SES)).filter((e) => JSON.parse(e.rawJsonl).fleetStripped).length).toBe(12);
    expect(new Set(t.steps)).toEqual(new Set(['events']));
    expect(t.slices).toBeGreaterThanOrEqual(12);
    expect((await retainEvents(NOW, unthrottled)).rows).toBe(0);
  });

  it('events: rows left when the budget runs out are picked up by the next slice', async () => {
    const many = Array.from({ length: 9 }, (_, i) => toolResult(`c${i}`, 40));
    await ingestAll(many);
    let calls = 0;
    // Expires after every third row check.
    const t: Throttle = {
      slice: (_s, fn) => { let k = 0; calls++; return fn({ targetMs: 35, expired: () => ++k > 2, note: () => undefined }); },
      stopped: () => false,
    };
    const r = await retainEvents(NOW, t);
    expect(r.rows).toBe(9);
    expect(calls).toBeGreaterThan(3);
    expect((await eventsForSession(SES)).filter((e) => JSON.parse(e.rawJsonl).fleetStripped).length).toBe(9);
  });

  it.skipIf(isPg)('embeddings: a spent budget compacts one row per slice and finishes', async () => {
    for (let i = 0; i < 6; i++) {
      await stateKysely().insertInto('embeddings').values({
        workspace_id: WS, session_id: SES, kind: 'turn', ref_event_id: i + 1, ts: NOW, text: i % 2 ? '' : `turn ${i}`,
        model_id: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(new Float32Array(EMBED_DIM).fill(i % 2 ? 0 : 0.05)), dedup_key: `s${i}`,
      }).execute();
    }
    const t = spentThrottle();
    const r = await compactEmbeddings(t);
    expect(r.rows).toBe(6);
    expect(t.slices).toBeGreaterThanOrEqual(6);
    expect(await maintenanceGet('embeddings.compacted_through_id')).toBe(String(await maxEmbeddingId()));
  });
});

describe('incrementalVacuum', () => {
  it('frees pages down to the threshold on an incremental-mode SQLite db', async () => {
    if (isPg) {
      expect(await incrementalVacuum(unthrottled)).toBe(0);
      return;
    }
    await withRawSqlite((d) => { d.pragma('auto_vacuum = INCREMENTAL'); d.exec('VACUUM'); });
    const big = 'x'.repeat(8000);
    await stateKysely().insertInto('maintenance')
      .values(Array.from({ length: 3000 }, (_, i) => ({ key: `k${i}`, value: big }))).execute();
    await stateKysely().deleteFrom('maintenance').execute();
    const free = (await withRawSqlite((d) => d.pragma('freelist_count', { simple: true }) as number))!;
    expect(free).toBeGreaterThan(4096);
    const freed = await incrementalVacuum(unthrottled);
    expect(freed).toBeGreaterThan(1024);
    expect((await withRawSqlite((d) => d.pragma('freelist_count', { simple: true }) as number))!).toBeLessThanOrEqual(4096);
  });

  it('does nothing when auto_vacuum is not incremental', async () => {
    expect(await incrementalVacuum(unthrottled)).toBe(0);
  });
});

describe('startRetention', () => {
  it('runs a pass after the first delay and records first_pass_at', async () => {
    await ingestAll();
    const done = new Promise<PassResult>((resolve) => {
      const r = startRetention({
        listManifestIds: async () => [WS], stateDirExists: () => true, orphanSweep: true,
        firstDelayMs: 0, now: () => NOW, throttle: { minSleepMs: 0, idleRatio: 0 },
        onPass: (p) => { resolve(p); void r.stop(); },
      });
    });
    const p = await done;
    expect(p.events.rows).toBeGreaterThan(0);
    expect(await maintenanceGet('retention.first_pass_at')).toBe(String(NOW));
  });
});

describe('retainEvents edge cases', () => {
  it('skips an idle session already past its watermarks without a slice', async () => {
    await ingestAll();
    await retainEvents(NOW + 40 * DAY_MS, unthrottled);
    let slices = 0;
    const counting: Throttle = { slice: (_s, fn) => { slices++; return fn({ targetMs: 35, expired: () => false, note: () => undefined }); }, stopped: () => false };
    await retainEvents(NOW + 41 * DAY_MS, counting);
    expect(slices).toBe(0);
  });

  it('leaves a corrupt compressed row alone, still finishes the pass, and reads it as empty', async () => {
    await ingestAll();
    await stateKysely().updateTable('events').set({ raw_jsonl: '', raw_z: Buffer.from('not zlib') }).where('uuid', '=', 'x1').execute();
    await retainEvents(NOW, unthrottled);
    const evs = await eventsForSession(SES);
    expect(evs.find((e) => e.uuid === 'x1')!.rawJsonl).toBe('');
    expect(JSON.parse(evs.find((e) => e.uuid === 'r-t1')!.rawJsonl).fleetStripped).toBeDefined();
    expect((await stored()).get('x1')!.raw_z).toEqual(Buffer.from('not zlib'));
  });
});

describe('retentionKeys', () => {
  it('reports each row\'s stored size without reading it', async () => {
    await ingestAll();
    const keys = await retentionKeys(SES, 0, NOW, null, 100, false);
    expect(keys.map((k) => k.bytes).sort((a, b) => a - b)).toEqual(lines.map((l) => Buffer.byteLength(l)).sort((a, b) => a - b));
  });
});

describe('insertEmbeddings storage', () => {
  it('stores int8 on SQLite and float32 on Postgres from a float32 input', async () => {
    const v = new Float32Array(EMBED_DIM); v[0] = 0.6; v[1] = 0.8;
    await insertEmbedding({ workspaceId: WS, sessionId: SES, kind: 'turn', refEventId: 1, ts: 1, text: 'x',
      modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(v), dedupKey: 't1' });
    if (isPg) {
      const [r] = await queryRows<{ v: string }>('SELECT vec::text AS v FROM embeddings');
      expect(r.v.startsWith('[0.6,0.8,')).toBe(true);
    } else {
      const [r] = await queryRows<{ n: number }>('SELECT length(vec) AS n FROM embeddings');
      expect(r.n).toBe(EMBED_DIM + 4);
    }
  });
});

describe('dedupeAttachments', () => {
  const att = (u: string) => JSON.stringify({ type: 'attachment', uuid: u, timestamp: iso(40), sessionId: SES,
    attachment: { type: 'skill_listing', content: 'skill '.repeat(400) }, cwd: '/w/'.padEnd(600, 'x') });

  /** Rows as a pre-v17 app wrote them: full line, no att_ref, no blob. */
  async function legacyRows(): Promise<string[]> {
    const ls = [att('p1'), att('p2'), att('p3')];
    for (const l of ls) await ingestLine(WS, SES, l);
    const k = stateKysely();
    for (const [i, l] of ls.entries()) {
      await k.updateTable('events').set(i === 1 ? { raw_jsonl: '', raw_z: deflateLine(l), att_ref: null } : { raw_jsonl: l, raw_z: null, att_ref: null })
        .where('uuid', '=', `p${i + 1}`).execute();
    }
    await k.deleteFrom('event_blobs').execute();
    return ls;
  }

  it.skipIf(isPg)('dedupes plain and compressed legacy rows, then resumes from its cursor', async () => {
    const ls = await legacyRows();
    const r = await dedupeAttachments(unthrottled, { sliceRows: 2 });
    expect(r.rows).toBe(3);
    expect(r.bytesSaved).toBeGreaterThan(0);
    expect(await queryRows('SELECT refs FROM event_blobs')).toEqual([{ refs: 3 }]);
    const evs = await eventsForSession(SES);
    expect(evs.map((e) => e.rawJsonl)).toEqual(ls);
    expect(Number(await maintenanceGet('attachments.deduped_through_id'))).toBe(Math.max(...evs.map((e) => e.id)));
    // The compressed source row's stub stays compressed; the plain ones stay plain.
    const raw = await stored();
    expect(isCompressed(raw.get('p2')!)).toBe(true);
    expect(isCompressed(raw.get('p1')!)).toBe(false);
    expect((await dedupeAttachments(unthrottled)).rows).toBe(0);
  });

  it.skipIf(isPg)('with a spent budget dedupes one row per slice and finishes', async () => {
    const ls = await legacyRows();
    const t = spentThrottle();
    expect((await dedupeAttachments(t)).rows).toBe(3);
    expect(t.slices).toBe(3);
    expect(await queryRows('SELECT refs FROM event_blobs')).toEqual([{ refs: 3 }]);
    expect((await eventsForSession(SES)).map((e) => e.rawJsonl)).toEqual(ls);
  });

  it.skipIf(isPg)('does nothing when stopped', async () => {
    await legacyRows();
    const stopped: Throttle = { slice: (_s, fn) => fn({ targetMs: 35, expired: () => false, note: () => undefined }), stopped: () => true };
    expect((await dedupeAttachments(stopped)).rows).toBe(0);
    expect(await queryRows('SELECT hash FROM event_blobs')).toEqual([]);
  });

  it('is a no-op on Postgres', async () => {
    if (!isPg) return;
    await ingestLine(WS, SES, att('p1'));
    expect((await dedupeAttachments(unthrottled)).rows).toBe(0);
  });
});

