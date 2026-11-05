// Knowledge claims (#483): background capture run bookkeeping. A run id is
// also the token the fork passes to record_claim (capture_run).
import type { Kysely } from 'kysely';
import { newId } from '../inbox/inboxDb.js';
import type { CaptureRunRow, InboxDb } from '../store/inboxSchema.js';
import type { CaptureVisibility } from '../../preload/captureSettings.js';

/** `ctx-<pct>` per configured context band (e.g. ctx-85), `turns` (periodic), `search` (search hit). */
export type CaptureTrigger = `ctx-${number}` | 'turns' | 'search';
export type CaptureStatus = 'running' | 'done' | 'failed' | 'timed-out';

/** Local midnight of the day containing `now` (the daily cap resets at local midnight). */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class CaptureRunStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  async start(o: {
    workspaceId: string; sessionId: string; forkSessionId: string; trigger: CaptureTrigger; userTurns?: number;
    /** The workspace's effective captureVisibility when the run was admitted. */
    visibility?: CaptureVisibility;
    /** The session's compaction count when the run was admitted. */
    compactions?: number;
    now: number;
  }): Promise<string> {
    const id = newId(o.now);
    await this.db.insertInto('capture_runs').values({
      id, workspace_id: o.workspaceId, session_id: o.sessionId, fork_session_id: o.forkSessionId,
      trigger: o.trigger, status: 'running', usage: null, error: null, started_at: o.now, ended_at: null,
      user_turns: o.userTurns ?? null, visibility: o.visibility ?? null, compactions: o.compactions ?? null
    }).execute();
    return id;
  }

  async runningFor(token: string, workspaceId: string): Promise<CaptureRunRow | null> {
    return (await this.db.selectFrom('capture_runs').selectAll()
      .where('id', '=', token).where('workspace_id', '=', workspaceId).where('status', '=', 'running')
      .executeTakeFirst()) ?? null;
  }

  async finish(id: string, o: { status: Exclude<CaptureStatus, 'running'>; usage: unknown; error: string | null; now: number }): Promise<void> {
    await this.db.updateTable('capture_runs').set({
      status: o.status, usage: o.usage === undefined || o.usage === null ? null : JSON.stringify(o.usage),
      error: o.error, ended_at: o.now
    }).where('id', '=', id).execute();
  }

  async incrementClaims(id: string): Promise<void> {
    await this.db.updateTable('capture_runs').set((eb) => ({ claims_recorded: eb('claims_recorded', '+', 1) })).where('id', '=', id).execute();
  }

  async lastFor(sessionId: string): Promise<CaptureRunRow | null> {
    return (await this.db.selectFrom('capture_runs').selectAll().where('session_id', '=', sessionId)
      .orderBy('started_at', 'desc').limit(1).executeTakeFirst()) ?? null;
  }

  /** Runs started at or after `ts` (any status) — the daily cap's numerator. */
  async countSince(ts: number): Promise<number> {
    const r = await this.db.selectFrom('capture_runs').select((eb) => eb.fn.countAll<number>().as('n'))
      .where('started_at', '>=', ts).executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  async forkSessionIds(): Promise<string[]> {
    const rows = await this.db.selectFrom('capture_runs').select('fork_session_id').where('fork_session_id', 'is not', null).execute();
    return rows.map((r) => r.fork_session_id as string);
  }

  /** Startup sweep: a run still 'running' was orphaned by an app exit. */
  async failRunning(now: number, error: string): Promise<number> {
    const r = await this.db.updateTable('capture_runs').set({ status: 'failed', error, ended_at: now })
      .where('status', '=', 'running').executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
}
