import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, stateKysely } from './db.js';
import { PerfStore } from './perfStore.js';
import {
  initPerf, shutdownPerf, reconfigurePerf, perfSpan, perfSpanAsync, perfSetSpanContext, getEffectivePerf,
  recordPtyChunk, getPerfStatus, recordLatencySample, setPerfStateListener, perfNotePowerEvent, recordGcEntries,
  sampleMemory, setPerfMemorySource, recordBootProfile
} from './perf.js';
import { armSentinel, disarmSentinel, sentinelStatus } from './perfSentinel.js';
import type { EffectivePerfConfig } from './perfConfig.js';
import type Database from 'better-sqlite3';

const ON: EffectivePerfConfig = {
  recording: true, recordingSource: 'settings',
  otlp: { enabled: false, endpoint: null, source: 'settings' }
};
const OFF: EffectivePerfConfig = {
  recording: false, recordingSource: 'settings',
  otlp: { enabled: false, endpoint: null, source: 'settings' }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared fixtures — used by both describe blocks below.
let dir: string;
let db: Database.Database;
let store: PerfStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'perf-'));
  db = openDb(dir);
  store = new PerfStore(stateKysely());
});
afterEach(async () => {
  await shutdownPerf();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('perf tracer pipeline', () => {
  it('records spans >= 25ms as slow_op rows and drops fast spans', async () => {
    initPerf(store, ON);
    perfSpan('claude_fleet.test.slow', () => { const end = Date.now() + 40; while (Date.now() < end) { /* busy */ } });
    perfSpan('claude_fleet.test.fast', () => undefined);
    await shutdownPerf(); // forces span-processor + store flush
    const rows = db.prepare(`SELECT kind, name FROM perf_events WHERE kind = 'slow_op'`).all();
    expect(rows).toEqual([{ kind: 'slow_op', name: 'claude_fleet.test.slow' }]);
    const slow = db.prepare(`SELECT dur_ms, trace_id, span_id FROM perf_events WHERE name = 'claude_fleet.test.slow'`).get() as { dur_ms: number; trace_id: string; span_id: string };
    expect(slow.dur_ms).toBeGreaterThanOrEqual(25);
    expect(slow.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(slow.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('perfSpanAsync covers awaited work and rethrows', async () => {
    initPerf(store, ON);
    await expect(
      perfSpanAsync('claude_fleet.test.async', async () => { await sleep(40); throw new Error('boom'); })
    ).rejects.toThrow('boom');
    await shutdownPerf();
    const row = db.prepare(`SELECT dur_ms FROM perf_events WHERE name = 'claude_fleet.test.async'`).get() as { dur_ms: number };
    expect(row.dur_ms).toBeGreaterThanOrEqual(25);
  });

  it('while disabled, perfSpan still runs fn and records nothing', async () => {
    initPerf(store, OFF);
    expect(perfSpan('claude_fleet.test.noop', () => 7)).toBe(7);
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events`).get()).toEqual({ n: 0 });
  });

  it('reconfigure flips live without restart', async () => {
    initPerf(store, OFF);
    await reconfigurePerf(ON);
    expect(getEffectivePerf()?.recording).toBe(true);
    perfSpan('claude_fleet.test.slow2', () => { const end = Date.now() + 40; while (Date.now() < end) { /* busy */ } });
    await reconfigurePerf(OFF); // shutdown path flushes
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE name = 'claude_fleet.test.slow2'`).get()).toEqual({ n: 1 });
  });

  it('shutdown is idempotent', async () => {
    initPerf(store, ON);
    await shutdownPerf();
    await expect(shutdownPerf()).resolves.toBeUndefined();
  });

  it('shutdownPerf resolves even if its final flush rejects, so a caller can still run closeDb() after', async () => {
    initPerf(store, ON);
    store.enqueue({ ts: Date.now(), kind: 'stall', durMs: 60 });
    const flushSpy = vi.spyOn(store, 'flush').mockRejectedValueOnce(new Error('disk full'));
    await expect(shutdownPerf()).resolves.toBeUndefined();
    flushSpy.mockRestore();
  });

  it('nested perfSpanAsync spans share a trace_id (child parents under the active span)', async () => {
    initPerf(store, ON);
    const spin = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };
    await perfSpanAsync('claude_fleet.test.parent', async () => {
      spin(30);
      await perfSpanAsync('claude_fleet.test.child', async () => { spin(30); });
    });
    await shutdownPerf();
    const rows = db.prepare(
      `SELECT name, trace_id FROM perf_events WHERE kind = 'slow_op' AND name LIKE 'claude_fleet.test.%' ORDER BY name`
    ).all() as Array<{ name: string; trace_id: string }>;
    expect(rows.map((r) => r.name)).toEqual(['claude_fleet.test.child', 'claude_fleet.test.parent']);
    expect(rows[0].trace_id).toBe(rows[1].trace_id);
  });

  it('perfSetSpanContext stamps workspace/session onto the active span', async () => {
    initPerf(store, ON);
    await perfSpanAsync('claude_fleet.test.ctx', async () => {
      perfSetSpanContext({ workspaceId: 'ws-9', sessionId: 'sess-9' });
      const end = Date.now() + 30; while (Date.now() < end) { /* busy */ }
    });
    await shutdownPerf();
    const row = db.prepare(
      `SELECT workspace_id, session_id FROM perf_events WHERE name = 'claude_fleet.test.ctx'`
    ).get() as { workspace_id: string; session_id: string };
    expect(row).toEqual({ workspace_id: 'ws-9', session_id: 'sess-9' });
  });

  it('perfSetSpanContext is a no-op outside a span and while disabled', async () => {
    initPerf(store, OFF);
    expect(() => perfSetSpanContext({ workspaceId: 'ws-9' })).not.toThrow();
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events`).get()).toEqual({ n: 0 });
  });
});

describe('stall sampler + pty counters', () => {
  // dir/db/store/afterEach identical to the tracer describe — reuse via the same outer scope.

  it('records a stall row when the sampled window max exceeds 50ms', async () => {
    let max = 10;
    initPerf(store, ON, { delaySource: () => ({ p50: 2, p99: 8, max }), sampleIntervalMs: 20 });
    await sleep(150); // ≥1 quiet window — below threshold, no row
    max = 120;
    await sleep(150); // ≥1 stalled window
    await shutdownPerf();
    const rows = db.prepare(`SELECT dur_ms, meta FROM perf_events WHERE kind = 'stall'`).all() as Array<{ dur_ms: number; meta: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].dur_ms).toBe(120);
    expect(JSON.parse(rows[0].meta)).toMatchObject({ p50: 2, p99: 8, max: 120 });
  });

  it('aggregates pty chunks into per-session pty_window rows', async () => {
    initPerf(store, ON, { delaySource: () => ({ p50: 0, p99: 0, max: 0 }), sampleIntervalMs: 20 });
    recordPtyChunk('ws-1', 'sess-a', 1000);
    recordPtyChunk('ws-1', 'sess-a', 500);
    recordPtyChunk('ws-2', 'sess-b', 42);
    await sleep(150);
    await shutdownPerf();
    const rows = db.prepare(
      `SELECT session_id, workspace_id, meta FROM perf_events WHERE kind = 'pty_window' AND name = 'claude_fleet.pty.bytes' ORDER BY session_id`
    ).all() as Array<{ session_id: string; workspace_id: string; meta: string }>;
    expect(rows.map((r) => [r.workspace_id, r.session_id, JSON.parse(r.meta).value])).toEqual([
      ['ws-1', 'sess-a', 1500],
      ['ws-2', 'sess-b', 42]
    ]);
    const chunks = db.prepare(
      `SELECT meta FROM perf_events WHERE kind = 'pty_window' AND name = 'claude_fleet.pty.chunks' AND session_id = 'sess-a'`
    ).get() as { meta: string };
    expect(JSON.parse(chunks.meta).value).toBe(2);
  });

  it('recordPtyChunk while disabled is a no-op', async () => {
    initPerf(store, OFF);
    recordPtyChunk('ws-1', 'sess-a', 1000);
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind = 'pty_window'`).get()).toEqual({ n: 0 });
  });

  it('aggregates latency samples into per-session rows with histogram meta', async () => {
    initPerf(store, ON, { delaySource: () => ({ p50: 0, p99: 0, max: 0 }), sampleIntervalMs: 20 });
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', 120);
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', 80);
    recordLatencySample('input_hop', null, 'sess-a', 3);
    await sleep(150);
    await shutdownPerf();
    const rtt = db.prepare(
      `SELECT workspace_id, session_id, dur_ms, meta FROM perf_events WHERE kind = 'echo_rtt'`
    ).get() as { workspace_id: string; session_id: string; dur_ms: number; meta: string };
    expect(rtt.workspace_id).toBe('ws-1');
    expect(rtt.session_id).toBe('sess-a');
    expect(rtt.dur_ms).toBe(120); // max of the window
    const meta = JSON.parse(rtt.meta);
    expect(meta.count).toBe(2);
    expect(meta.sum).toBe(200);
    expect(meta.min).toBe(80);
    expect(meta.max).toBe(120);
    const hop = db.prepare(
      `SELECT workspace_id, session_id FROM perf_events WHERE kind = 'input_hop'`
    ).get() as { workspace_id: string | null; session_id: string };
    expect(hop.workspace_id).toBeNull(); // '' normalizes to NULL
    expect(hop.session_id).toBe('sess-a');
  });

  it('recordLatencySample while disabled, uninitialized, or given junk is a no-op', async () => {
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', 50); // before any initPerf: no runtime
    initPerf(store, OFF);
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', 50); // recording off
    await shutdownPerf();
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', 50); // after shutdown: no runtime
    initPerf(store, ON);
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', NaN); // non-finite
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', -1); // negative
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind = 'echo_rtt'`).get()).toEqual({ n: 0 });
  });
});

describe('getPerfStatus', () => {
  it('reflects effective config + 24h counts (flushing pending rows first)', async () => {
    initPerf(store, ON);
    store.enqueue({ ts: Date.now(), kind: 'stall', durMs: 60 });
    const s = await getPerfStatus();
    expect(s.enabled).toBe(true);
    expect(s.source).toBe('settings');
    expect(s.otlp).toEqual({ enabled: false, endpoint: null, source: 'settings' });
    expect(s.eventCounts.stall).toBe(1);
  });

  it('throws before init', async () => {
    await shutdownPerf();
    await expect(getPerfStatus()).rejects.toThrow(/init/i);
  });
});

describe('setPerfStateListener', () => {
  afterEach(() => setPerfStateListener(null));

  it('fires with the effective recording state on init and reconfigure', async () => {
    const seen: boolean[] = [];
    setPerfStateListener((r) => seen.push(r));
    initPerf(store, ON);
    await reconfigurePerf(OFF);
    await reconfigurePerf(ON);
    expect(seen).toEqual([true, false, true]);
  });
});

describe('perfNotePowerEvent (suspend filtering)', () => {
  it('discards windows between suspend and shortly after resume', async () => {
    initPerf(store, ON, { delaySource: () => ({ p50: 2, p99: 8, max: 30000 }), sampleIntervalMs: 100 });
    perfNotePowerEvent('suspend');
    await sleep(350); // several suspended windows
    await store.flush(); // rows are buffered — flush before counting
    const midCount = (db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind='stall'`).get() as { n: number }).n;
    expect(midCount).toBe(0);
    perfNotePowerEvent('resume');
    await sleep(350); // past the discard horizon: real windows record again
    await shutdownPerf();
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind='stall'`).get() as { n: number }).n;
    expect(after).toBeGreaterThanOrEqual(1);
  });

  it('is a no-op before initPerf', async () => {
    expect(() => perfNotePowerEvent('resume')).not.toThrow();
  });
});

describe('recordGcEntries (GC pause rows)', () => {
  const entry = (duration: number, kind: number, startTime = 1000) =>
    ({ startTime, duration, detail: { kind, flags: 0 } });

  it('records >=25ms GC pauses as gc rows with decoded kind names', async () => {
    initPerf(store, ON);
    recordGcEntries([entry(180, 2), entry(30, 1), entry(40, 4), entry(26, 8), entry(50, 99)]);
    await shutdownPerf();
    const rows = db.prepare(
      `SELECT name, dur_ms, meta FROM perf_events WHERE kind = 'gc' ORDER BY dur_ms DESC`
    ).all() as Array<{ name: string; dur_ms: number; meta: string }>;
    expect(rows.map((r) => r.name)).toEqual([
      'claude_fleet.gc.major',
      'claude_fleet.gc.unknown',
      'claude_fleet.gc.incremental',
      'claude_fleet.gc.minor',
      'claude_fleet.gc.weakcb'
    ]);
    expect(rows[0].dur_ms).toBe(180);
    expect(JSON.parse(rows[0].meta)).toEqual({ gcKind: 'major', flags: 0 });
  });

  it('drops sub-threshold pauses and tolerates missing detail', async () => {
    initPerf(store, ON);
    recordGcEntries([entry(24, 2), { startTime: 1000, duration: 60 }]);
    await shutdownPerf();
    const rows = db.prepare(`SELECT name FROM perf_events WHERE kind = 'gc'`).all() as Array<{ name: string }>;
    expect(rows).toEqual([{ name: 'claude_fleet.gc.unknown' }]);
  });

  it('converts startTime to epoch ms via timeOrigin', async () => {
    initPerf(store, ON);
    recordGcEntries([entry(100, 2, 5000)]);
    await shutdownPerf();
    const row = db.prepare(`SELECT ts FROM perf_events WHERE kind = 'gc'`).get() as { ts: number };
    expect(row.ts).toBe(Math.round(performance.timeOrigin + 5000));
  });

  it('is a no-op while disabled or uninitialized', async () => {
    recordGcEntries([entry(500, 2)]); // before init
    initPerf(store, OFF);
    recordGcEntries([entry(500, 2)]);
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind='gc'`).get()).toEqual({ n: 0 });
  });
});

describe('recordBootProfile', () => {
  const result = {
    startedAt: 1_700_000_000_000, windowMs: 30_000, sampleCount: 30_000, file: '/u/perf/boot-x.cpuprofile',
    seconds: [{ t: 3, js: 990, gc: 0, top: [['f a.js:1', 990]] as Array<[string, number]> }],
    blocks: [{ startMs: 3000, durMs: 9000, gcMs: 0, self: [], attr: [], stack: [] }]
  };

  it('writes one app-global boot_profile row with the summary as meta', async () => {
    initPerf(store, ON);
    recordBootProfile(result);
    await shutdownPerf();
    const row = db.prepare(`SELECT ts, name, dur_ms, workspace_id, meta FROM perf_events WHERE kind = 'boot_profile'`).get() as
      { ts: number; name: string; dur_ms: number; workspace_id: string | null; meta: string };
    expect(row).toMatchObject({ ts: result.startedAt, name: 'claude_fleet.boot.cpu_profile', dur_ms: 30_000, workspace_id: null });
    expect(JSON.parse(row.meta)).toEqual({ sampleCount: 30_000, file: result.file, seconds: result.seconds, blocks: result.blocks });
  });

  it('is a no-op while disabled', async () => {
    initPerf(store, OFF);
    recordBootProfile(result);
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind='boot_profile'`).get()).toEqual({ n: 0 });
  });
});

describe('stall rows: cpu + sentinel enrichment', () => {
  afterEach(() => disarmSentinel());

  it('every stall row carries meta.cpu.utilization in [0,1]', async () => {
    initPerf(store, ON, { delaySource: () => ({ p50: 2, p99: 8, max: 120 }), sampleIntervalMs: 20 });
    await sleep(100);
    await shutdownPerf();
    const rows = db.prepare(`SELECT meta FROM perf_events WHERE kind='stall'`).all() as Array<{ meta: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      const u = JSON.parse(r.meta).cpu?.utilization;
      expect(typeof u).toBe('number');
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
  });

  it('armed sentinel annotates stall rows; disarmed leaves meta.sentinel absent', async () => {
    let cb: (w: { p50: number; p99: number; max: number }) => void = () => {};
    armSentinel(undefined, {
      workerFactory: () => ({ on: (_e, c) => { cb = c; }, unref: () => {}, terminate: () => {} }),
      sampleIntervalMs: 20
    });
    cb({ p50: 1, p99: 2, max: 200 }); // worker co-stalled
    initPerf(store, ON, { delaySource: () => ({ p50: 2, p99: 8, max: 120 }), sampleIntervalMs: 20 });
    await sleep(60);
    disarmSentinel();
    await sleep(60);
    await shutdownPerf();
    const rows = db.prepare(`SELECT meta FROM perf_events WHERE kind='stall' ORDER BY id`).all() as Array<{ meta: string }>;
    const metas = rows.map((r) => JSON.parse(r.meta));
    expect(metas.some((m) => m.sentinel?.aligned === true)).toBe(true); // while armed
    expect(metas.some((m) => m.sentinel === undefined)).toBe(true);     // after disarm
  });

  it('shutdownPerf disarms the sentinel (covers recording-off via reconfigure)', async () => {
    armSentinel(undefined, {
      workerFactory: () => ({ on: () => {}, unref: () => {}, terminate: () => {} })
    });
    initPerf(store, ON);
    await shutdownPerf();
    expect(sentinelStatus().enabled).toBe(false);
  });

  it('getPerfStatus includes the sentinel block', async () => {
    initPerf(store, ON);
    const s = await getPerfStatus();
    expect(s.sentinel).toEqual({ enabled: false, startedAt: null, expiresAt: null, lastWorkerWindow: null, workerDead: false });
  });
});

describe('memory sampling (mem rows)', () => {
  afterEach(() => setPerfMemorySource(null));

  const memRows = () =>
    db.prepare(`SELECT name, workspace_id, dur_ms, meta FROM perf_events WHERE kind = 'mem'`)
      .all() as Array<{ name: string; workspace_id: string | null; dur_ms: number; meta: string }>;

  it('writes a mem row with the main-process V8 heap even without an injected source', async () => {
    initPerf(store, ON);
    sampleMemory();
    await shutdownPerf();
    const rows = memRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('claude_fleet.mem');
    expect(rows[0].workspace_id).toBeNull();
    const meta = JSON.parse(rows[0].meta);
    expect(meta.main.heapUsedMb).toBeGreaterThan(0);
    expect(meta.main.rssMb).toBeGreaterThan(0);
    expect(meta.procs).toEqual([]);
  });

  it('includes per-process working sets, per-type totals, and context from the source', async () => {
    setPerfMemorySource(() => ({
      procs: [
        { pid: 1, type: 'Browser', workingSetMb: 200 },
        { pid: 2, type: 'Tab', workingSetMb: 350, privateMb: 300 },
        { pid: 3, type: 'Tab', workingSetMb: 50 },
        { pid: 4, type: 'GPU', workingSetMb: 120 }
      ],
      context: { ptySessions: 6 }
    }));
    initPerf(store, ON);
    sampleMemory();
    await shutdownPerf();
    const [row] = memRows();
    const meta = JSON.parse(row.meta);
    expect(meta.byType).toEqual({ Browser: 200, Tab: 400, GPU: 120 });
    expect(meta.totalWorkingSetMb).toBe(720);
    expect(meta.procs).toHaveLength(4);
    expect(meta.context).toEqual({ ptySessions: 6 });
    // dur_ms carries the app-wide total so SQL can chart it without json_extract.
    expect(row.dur_ms).toBe(720);
  });

  it('a throwing source still records the main heap and never throws', async () => {
    setPerfMemorySource(() => { throw new Error('metrics unavailable'); });
    initPerf(store, ON);
    expect(() => sampleMemory()).not.toThrow();
    await shutdownPerf();
    const meta = JSON.parse(memRows()[0].meta);
    expect(meta.main.heapUsedMb).toBeGreaterThan(0);
    expect(meta.procs).toEqual([]);
  });

  it('samples on the configured interval and stops on shutdown', async () => {
    initPerf(store, ON, { memSampleIntervalMs: 20 });
    await sleep(75);
    await shutdownPerf();
    const n = memRows().length;
    expect(n).toBeGreaterThanOrEqual(2);
    await sleep(50);
    expect(memRows()).toHaveLength(n);
  });

  it('records nothing while recording is off', async () => {
    initPerf(store, OFF);
    sampleMemory();
    await shutdownPerf();
    expect(memRows()).toEqual([]);
  });
});
