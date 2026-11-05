// Buffered writer for the perf_events table. Producers (span/metric
// exporters, the stall sampler) enqueue rows in memory; a single flush()
// writes them in one transaction so telemetry never adds per-event
// SQLite work to the hot path. perf.ts owns the flush timer.

import type { Kysely } from 'kysely';
import { chunked, num } from './store/kysely.js';
import type { StateDb } from './store/stateSchema.js';

export type PerfKind = 'stall' | 'slow_op' | 'pty_window' | 'input_hop' | 'output_hop' | 'echo_rtt' | 'gc' | 'mem';

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
/** perf_events has 9 bound columns: 500 rows = 4,500 parameters per INSERT —
 *  under SQLite's 32,766 bound-parameter limit (3.32+, which better-sqlite3
 *  bundles) and Postgres's 65,535. */
const FLUSH_ROWS_PER_INSERT = 500;

export class PerfStore {
  private buf: PerfRow[] = [];
  /** flush() calls run one at a time, in call order. */
  private flushChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Kysely<StateDb>) {}

  enqueue(row: PerfRow): void {
    this.buf.push(row);
    if (this.buf.length > BUFFER_CAP) this.buf.splice(0, this.buf.length - BUFFER_CAP);
  }

  pending(): number {
    return this.buf.length;
  }

  /** Write all buffered rows in one transaction. Resolves to rows written.
   *  Takes the buffer synchronously, before any awaiting: two flush() calls
   *  issued back to back (no await between them) must each own a disjoint
   *  slice of what was enqueued by then, not race over the same buffer once
   *  their deferred writes eventually run. Rows enqueued after this point
   *  land in the fresh buffer for the next flush. */
  flush(): Promise<number> {
    const rows = this.buf;
    this.buf = [];
    const run = this.flushChain.catch(() => undefined).then(() => this.flushNow(rows));
    this.flushChain = run;
    return run;
  }

  private async flushNow(rows: PerfRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    try {
      await this.db.transaction().execute(async (trx) => {
        for (const part of chunked(rows, FLUSH_ROWS_PER_INSERT)) {
          await trx
            .insertInto('perf_events')
            .values(
              part.map((r) => ({
                ts: r.ts,
                kind: r.kind,
                workspace_id: r.workspaceId ?? null,
                session_id: r.sessionId ?? null,
                name: r.name ?? null,
                dur_ms: r.durMs ?? null,
                trace_id: r.traceId ?? null,
                span_id: r.spanId ?? null,
                meta: r.meta ? JSON.stringify(r.meta) : null,
              }))
            )
            .execute();
        }
      });
      return rows.length;
    } catch (err) {
      // Telemetry rows must not vanish silently on a transient DB error —
      // put them back (ahead of anything enqueued mid-flush) and rethrow.
      this.buf = rows.concat(this.buf);
      throw err;
    }
  }

  /** Delete rows older than the retention window. Resolves to rows deleted. */
  async prune(olderThanMs: number = RETENTION_MS, now: number = Date.now()): Promise<number> {
    const r = await this.db.deleteFrom('perf_events').where('ts', '<', now - olderThanMs).executeTakeFirst();
    return num(r.numDeletedRows);
  }

  /** Row counts per kind over the trailing 24 h (perf_status / Settings UI). */
  async counts24h(now: number = Date.now()): Promise<Record<string, number>> {
    const rows = await this.db
      .selectFrom('perf_events')
      .select((eb) => ['kind', eb.fn.countAll().as('n')])
      .where('ts', '>=', now - DAY_MS)
      .groupBy('kind')
      .execute();
    return Object.fromEntries(rows.map((r) => [r.kind, num(r.n)]));
  }
}
