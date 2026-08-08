import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from './db.js';
import { PerfStore } from './perfStore.js';
import {
  initPerf, shutdownPerf, reconfigurePerf, perfSpan, perfSpanAsync, perfSetSpanContext, getEffectivePerf,
  recordPtyChunk, getPerfStatus, recordLatencySample, setPerfStateListener
} from './perf.js';
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'perf-'));
  db = openDb(dir);
  store = new PerfStore(db);
});
afterEach(async () => {
  await shutdownPerf();
  closeDb();
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
    expect(JSON.parse(rows[0].meta)).toEqual({ p50: 2, p99: 8, max: 120 });
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
  it('reflects effective config + 24h counts (flushing pending rows first)', () => {
    initPerf(store, ON);
    store.enqueue({ ts: Date.now(), kind: 'stall', durMs: 60 });
    const s = getPerfStatus();
    expect(s.enabled).toBe(true);
    expect(s.source).toBe('settings');
    expect(s.otlp).toEqual({ enabled: false, endpoint: null, source: 'settings' });
    expect(s.eventCounts.stall).toBe(1);
  });

  it('throws before init', async () => {
    await shutdownPerf();
    expect(() => getPerfStatus()).toThrow(/init/i);
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
