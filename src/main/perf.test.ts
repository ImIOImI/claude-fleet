import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from './db.js';
import { PerfStore } from './perfStore.js';
import {
  initPerf, shutdownPerf, reconfigurePerf, perfSpan, perfSpanAsync, getEffectivePerf
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

describe('perf tracer pipeline', () => {
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
});
