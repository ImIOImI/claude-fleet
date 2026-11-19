// Graceful-drain bookkeeping on the holder's fenced host handle (D150, D151).
import { sql, type Kysely } from 'kysely';
import type { HostDb } from './hostSchema.js';

export const DRAINED_TTL_MS = 24 * 3_600_000;
export const MAX_DRAINED_ROWS = 200;
export const RETRY_MAX_AGE_MS = 24 * 3_600_000;
const NOTE_MAX = 200;

export interface PendingRetry { runId: string; automationId: string; createdAt: number }
export interface DrainedRow { instance: string; brokerSessionId: string; sessionId: string; reason: string | null }
export interface DrainedSession { brokerSessionId: string; sessionId: string; drainedAt: number }
export interface DrainStore {
  /** Queue one re-run; false when the run already has a row or is itself a re-run. */
  markRetry(runId: string, automationId: string, now: number): Promise<boolean>;
  /** Pending rows, moved to `started` (claim before start: at most once). */
  claimPending(now: number): Promise<PendingRetry[]>;
  settle(runId: string, o: { retryRunId: string } | { skipped: string }, now: number): Promise<void>;
  recordDrained(rows: DrainedRow[], now: number): Promise<void>;
  /** Newest row per broker session at or after `since`, newest first. */
  drained(since: number, limit: number): Promise<DrainedSession[]>;
  prune(before: number): Promise<void>;
}

const newestFirst = (a: { drainedAt: number }, b: { drainedAt: number }): number => b.drainedAt - a.drainedAt;

export function pgDrainStore(k: Kysely<HostDb>): DrainStore {
  return {
    async markRetry(runId, automationId, now) {
      const r = await sql<{ run_id: string }>`
        INSERT INTO host_run_retries (run_id, automation_id, state, created_at)
        SELECT ${runId}, ${automationId}, 'pending', ${now}
        WHERE NOT EXISTS (SELECT 1 FROM host_run_retries WHERE retry_run_id = ${runId})
        ON CONFLICT (run_id) DO NOTHING
        RETURNING run_id`.execute(k);
      return r.rows.length === 1;
    },
    async claimPending(now) {
      const r = await sql<{ run_id: string; automation_id: string; created_at: string | number }>`
        UPDATE host_run_retries SET state = 'started', settled_at = ${now}
        WHERE state = 'pending' RETURNING run_id, automation_id, created_at`.execute(k);
      return r.rows.map((x) => ({ runId: x.run_id, automationId: x.automation_id, createdAt: Number(x.created_at) }));
    },
    async settle(runId, o, now) {
      const set = 'retryRunId' in o
        ? { retry_run_id: o.retryRunId, settled_at: now }
        : { state: 'skipped' as const, note: o.skipped.slice(0, NOTE_MAX), settled_at: now };
      await k.updateTable('host_run_retries').set(set).where('run_id', '=', runId).execute();
    },
    async recordDrained(rows, now) {
      if (!rows.length) return;
      await k.insertInto('host_drained_sessions')
        .values(rows.map((r) => ({ instance: r.instance, broker_session_id: r.brokerSessionId, session_id: r.sessionId, reason: r.reason, drained_at: now })))
        .onConflict((oc) => oc.columns(['instance', 'broker_session_id']).doUpdateSet((eb) => ({
          session_id: eb.ref('excluded.session_id'), reason: eb.ref('excluded.reason'), drained_at: eb.ref('excluded.drained_at')
        })))
        .execute();
    },
    async drained(since, limit) {
      // Only sessions owned in the hosted workspace (host_meta), like history:*.
      const r = await sql<{ broker_session_id: string; session_id: string; drained_at: string | number }>`
        SELECT * FROM (
          SELECT DISTINCT ON (d.broker_session_id) d.broker_session_id, d.session_id, d.drained_at
          FROM host_drained_sessions d
          WHERE d.drained_at >= ${since} AND EXISTS (
            SELECT 1 FROM session_owners o
            WHERE o.broker_session_id = d.broker_session_id AND o.session_id = d.session_id
              AND o.workspace_id = (SELECT workspace_id FROM host_meta))
          ORDER BY d.broker_session_id, d.drained_at DESC
        ) x ORDER BY drained_at DESC, broker_session_id LIMIT ${limit}`.execute(k);
      return r.rows.map((x) => ({ brokerSessionId: x.broker_session_id, sessionId: x.session_id, drainedAt: Number(x.drained_at) }));
    },
    async prune(before) {
      await k.deleteFrom('host_drained_sessions').where('drained_at', '<', before).execute();
    }
  };
}

/** Without `db:`: one process, nothing survives a restart. */
export function memoryDrainStore(): DrainStore {
  const retries = new Map<string, { automationId: string; state: 'pending' | 'started' | 'skipped'; retryRunId: string | null; createdAt: number }>();
  const drainedRows = new Map<string, DrainedRow & { drainedAt: number }>();
  return {
    async markRetry(runId, automationId, now) {
      if (retries.has(runId) || [...retries.values()].some((r) => r.retryRunId === runId)) return false;
      retries.set(runId, { automationId, state: 'pending', retryRunId: null, createdAt: now });
      return true;
    },
    async claimPending() {
      const out: PendingRetry[] = [];
      for (const [runId, r] of retries) {
        if (r.state !== 'pending') continue;
        r.state = 'started';
        out.push({ runId, automationId: r.automationId, createdAt: r.createdAt });
      }
      return out;
    },
    async settle(runId, o) {
      const r = retries.get(runId);
      if (!r) return;
      if ('retryRunId' in o) r.retryRunId = o.retryRunId;
      else r.state = 'skipped';
    },
    async recordDrained(rows, now) {
      for (const r of rows) drainedRows.set(`${r.instance}\0${r.brokerSessionId}`, { ...r, drainedAt: now });
    },
    async drained(since, limit) {
      const best = new Map<string, DrainedSession>();
      for (const r of drainedRows.values()) {
        if (r.drainedAt < since) continue;
        const cur = best.get(r.brokerSessionId);
        if (!cur || r.drainedAt > cur.drainedAt) best.set(r.brokerSessionId, { brokerSessionId: r.brokerSessionId, sessionId: r.sessionId, drainedAt: r.drainedAt });
      }
      return [...best.values()].sort(newestFirst).slice(0, limit);
    },
    async prune(before) {
      for (const [key, r] of drainedRows) if (r.drainedAt < before) drainedRows.delete(key);
    }
  };
}
