// Buffered writer for the perf_events table. Producers (span/metric
// exporters, the stall sampler) enqueue rows in memory; a single flush()
// writes them in one transaction so telemetry never adds per-event
// synchronous SQLite work to the hot path. perf.ts owns the flush timer.

import type Database from 'better-sqlite3';

export type PerfKind = 'stall' | 'slow_op' | 'pty_window' | 'input_hop' | 'output_hop' | 'echo_rtt';

export interface PerfRow {
  ts: number;
  kind: PerfKind;
  workspaceId?: string | null;
  sessionId?: string | null;
  name?: string | null;
  durMs?: number | null;
  traceId?: string | null;
  spanId?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Drop-oldest cap: telemetry must never become the memory problem. */
const BUFFER_CAP = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 7 * DAY_MS;

export class PerfStore {
  private buf: PerfRow[] = [];

  constructor(private readonly db: Database.Database) {}

  enqueue(row: PerfRow): void {
    this.buf.push(row);
    if (this.buf.length > BUFFER_CAP) this.buf.splice(0, this.buf.length - BUFFER_CAP);
  }

  pending(): number {
    return this.buf.length;
  }

  /** Write all buffered rows in one transaction. Returns rows written. */
  flush(): number {
    if (this.buf.length === 0) return 0;
    const rows = this.buf;
    this.buf = [];
    const ins = this.db.prepare(`
      INSERT INTO perf_events (ts, kind, workspace_id, session_id, name, dur_ms, trace_id, span_id, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction((rs: PerfRow[]) => {
      for (const r of rs) {
        ins.run(
          r.ts, r.kind, r.workspaceId ?? null, r.sessionId ?? null, r.name ?? null,
          r.durMs ?? null, r.traceId ?? null, r.spanId ?? null,
          r.meta ? JSON.stringify(r.meta) : null
        );
      }
    })(rows);
    return rows.length;
  }

  /** Delete rows older than the retention window. Returns rows deleted. */
  prune(olderThanMs: number = RETENTION_MS, now: number = Date.now()): number {
    return this.db.prepare(`DELETE FROM perf_events WHERE ts < ?`).run(now - olderThanMs).changes;
  }

  /** Row counts per kind over the trailing 24 h (perf_status / Settings UI). */
  counts24h(now: number = Date.now()): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT kind, COUNT(*) AS n FROM perf_events WHERE ts >= ? GROUP BY kind`)
      .all(now - DAY_MS) as Array<{ kind: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }
}
