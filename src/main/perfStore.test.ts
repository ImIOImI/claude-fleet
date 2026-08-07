import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from './db.js';
import { PerfStore } from './perfStore.js';
import type Database from 'better-sqlite3';

describe('PerfStore', () => {
  let dir: string;
  let db: Database.Database;
  let store: PerfStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perfstore-'));
    db = openDb(dir);
    store = new PerfStore(db);
  });
  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migration creates perf_events with the expected columns', () => {
    const cols = db.prepare(`PRAGMA table_info(perf_events)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual([
      'id', 'ts', 'kind', 'workspace_id', 'session_id', 'name', 'dur_ms', 'trace_id', 'span_id', 'meta'
    ]);
  });

  it('enqueue is buffered; flush writes one transaction and empties the buffer', () => {
    store.enqueue({ ts: 1000, kind: 'slow_op', name: 'claude_fleet.ingest', durMs: 40 });
    store.enqueue({ ts: 1001, kind: 'stall', durMs: 80, meta: { p50: 1, p99: 60, max: 80 } });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events`).get()).toEqual({ n: 0 });
    expect(store.flush()).toBe(2);
    expect(store.pending()).toBe(0);
    const rows = db.prepare(`SELECT kind, name, dur_ms, meta FROM perf_events ORDER BY id`).all();
    expect(rows).toEqual([
      { kind: 'slow_op', name: 'claude_fleet.ingest', dur_ms: 40, meta: null },
      { kind: 'stall', name: null, dur_ms: 80, meta: JSON.stringify({ p50: 1, p99: 60, max: 80 }) }
    ]);
    expect(store.flush()).toBe(0); // idempotent when empty
  });

  it('prune deletes rows older than the retention window', () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    store.enqueue({ ts: now - 8 * 24 * 60 * 60 * 1000, kind: 'stall', durMs: 60 });
    store.enqueue({ ts: now - 1000, kind: 'stall', durMs: 60 });
    store.flush();
    expect(store.prune(7 * 24 * 60 * 60 * 1000, now)).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events`).get()).toEqual({ n: 1 });
  });

  it('counts24h groups by kind within the window', () => {
    const now = 2 * 24 * 60 * 60 * 1000;
    store.enqueue({ ts: now - 1000, kind: 'stall', durMs: 60 });
    store.enqueue({ ts: now - 2000, kind: 'slow_op', name: 'x', durMs: 30 });
    store.enqueue({ ts: now - 3000, kind: 'slow_op', name: 'y', durMs: 30 });
    store.enqueue({ ts: now - 30 * 60 * 60 * 1000, kind: 'slow_op', name: 'old', durMs: 30 });
    store.flush();
    expect(store.counts24h(now)).toEqual({ stall: 1, slow_op: 2 });
  });

  it('buffer is capped so a runaway producer cannot exhaust memory', () => {
    for (let i = 0; i < 11_000; i++) store.enqueue({ ts: i, kind: 'stall', durMs: 60 });
    expect(store.pending()).toBe(10_000);
  });

  it('flush restores the buffer when the transaction throws', () => {
    store.enqueue({ ts: 1, kind: 'stall', durMs: 60 });
    db.exec(`DROP TABLE perf_events`); // force the transaction to throw
    let threwError = false;
    try {
      store.flush();
    } catch (e) {
      threwError = true;
    }
    expect(threwError).toBe(true);
    expect(store.pending()).toBe(1);
  });
});
