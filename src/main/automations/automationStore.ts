// Automations repository (#407 Phase 3) over the inbox.db connection:
// definitions + version history, tags, per-automation state, runs, step runs.
// Async on Kysely; multi-statement writes are transactions (use trx inside).
import { sql, type Kysely, type Transaction, type UpdateQueryBuilder, type UpdateResult } from 'kysely';
import type {
  AutomationDef, ParamValue, RunRow, RunStatus, StepRunRow, TodoSource
} from '../../preload/inboxTypes.js';
import { newId } from '../inbox/inboxDb.js';
import { normalizeTags } from '../inbox/inboxCore.js';
import { chunked, num } from '../store/kysely.js';
import type { AutomationRow, InboxDb, RunRowSql, StepRunRowSql } from '../store/inboxSchema.js';

type Q = Kysely<InboxDb> | Transaction<InboxDb>;

export interface AutomationRecord {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  definition: AutomationDef;
  createdBy: TodoSource;
  origin: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  lastScheduledAt: number | null;
  /** A next fire chosen by a run (#437); replaces the cron until it fires. */
  nextRunAt: number | null;
  /** The run that chose it. */
  nextRunBy: string | null;
}

function toRecord(r: AutomationRow): AutomationRecord {
  return {
    id: r.id, name: r.name, enabled: r.enabled === 1, version: r.version, definition: JSON.parse(r.definition) as AutomationDef,
    createdBy: { kind: r.created_by_kind, id: r.created_by_id }, origin: r.origin ? (JSON.parse(r.origin) as Record<string, unknown>) : null,
    createdAt: r.created_at, updatedAt: r.updated_at, lastScheduledAt: r.last_scheduled_at,
    nextRunAt: r.next_run_at, nextRunBy: r.next_run_by
  };
}

/** A conditional write: the row must still be this version, enabled, and (when given) hold this next_run_at. */
export interface WriteGuard {
  version: number;
  enabled: true;
  nextRunAt?: number | null;
}

function guarded<Q extends UpdateQueryBuilder<InboxDb, 'automations', 'automations', UpdateResult>>(q: Q, g: WriteGuard | undefined): Q {
  if (!g) return q;
  let w = q.where('version', '=', g.version).where('enabled', '=', 1);
  if (g.nextRunAt !== undefined) w = g.nextRunAt === null ? w.where('next_run_at', 'is', null) : w.where('next_run_at', '=', g.nextRunAt);
  return w as Q;
}

export class AutomationStore {
  constructor(private readonly db: Kysely<InboxDb>) {}

  // --- definitions ---------------------------------------------------------

  async list(): Promise<AutomationRecord[]> {
    return (await this.db.selectFrom('automations').selectAll().orderBy('name').execute()).map(toRecord);
  }

  private async getWith(q: Q, id: string): Promise<AutomationRecord | null> {
    const r = await q.selectFrom('automations').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toRecord(r) : null;
  }
  get(id: string): Promise<AutomationRecord | null> {
    return this.getWith(this.db, id);
  }

  private async byNameWith(q: Q, name: string): Promise<AutomationRecord | null> {
    const r = await q.selectFrom('automations').selectAll().where('name', '=', name).executeTakeFirst();
    return r ? toRecord(r) : null;
  }
  byName(name: string): Promise<AutomationRecord | null> {
    return this.byNameWith(this.db, name);
  }

  create(def: AutomationDef, by: TodoSource, now = Date.now(), enabled = true, origin: Record<string, unknown> | null = null): Promise<AutomationRecord> {
    const id = newId(now);
    return this.db.transaction().execute(async (trx) => {
      if (await this.byNameWith(trx, def.name)) throw new Error(`an automation named "${def.name}" already exists`);
      await trx.insertInto('automations').values({
        id, name: def.name, enabled: enabled ? 1 : 0, version: 1, definition: JSON.stringify(def), created_by_kind: by.kind,
        created_by_id: by.id, origin: origin ? JSON.stringify(origin) : null, created_at: now, updated_at: now, last_scheduled_at: now
      }).execute();
      await trx.insertInto('automation_versions').values({
        automation_id: id, version: 1, definition: JSON.stringify(def), created_at: now, created_by_kind: by.kind, created_by_id: by.id
      }).execute();
      await this.setTags(trx, id, def.tags ?? []);
      return (await this.getWith(trx, id))!;
    });
  }

  /** A new version of the definition. Renames are allowed when the new name is free.
   *  expectedVersion: reject if the stored version moved (proposal apply / revert). */
  update(id: string, def: AutomationDef, by: TodoSource, now = Date.now(), expectedVersion?: number): Promise<AutomationRecord> {
    return this.db.transaction().execute(async (trx) => {
      const cur = await this.getWith(trx, id);
      if (!cur) throw new Error(`automation ${id} not found`);
      if (expectedVersion !== undefined && cur.version !== expectedVersion) throw new Error(`automation ${id} changed (now v${cur.version})`);
      const clash = await this.byNameWith(trx, def.name);
      if (clash && clash.id !== id) throw new Error(`an automation named "${def.name}" already exists`);
      const version = cur.version + 1;
      // A new version drops any next fire a run of the old one chose (#437).
      await trx.updateTable('automations')
        .set({ name: def.name, version, definition: JSON.stringify(def), updated_at: now, next_run_at: null, next_run_by: null })
        .where('id', '=', id).execute();
      await trx.insertInto('automation_versions').values({
        automation_id: id, version, definition: JSON.stringify(def), created_at: now, created_by_kind: by.kind, created_by_id: by.id
      }).execute();
      await this.setTags(trx, id, def.tags ?? []);
      return (await this.getWith(trx, id))!;
    });
  }

  async setEnabled(id: string, enabled: boolean, now = Date.now()): Promise<void> {
    // Re-enabling restarts the schedule clock so a long-disabled automation doesn't fire a stale catch-up.
    // Either way a run-chosen next fire (#437) is dropped.
    await this.db.updateTable('automations')
      .set((eb) => ({
        enabled: enabled ? 1 : 0, updated_at: now, next_run_at: null, next_run_by: null,
        last_scheduled_at: enabled ? now : eb.ref('last_scheduled_at')
      }))
      .where('id', '=', id).execute();
  }

  /** Loadout provenance (#407 Phase 8). */
  async setOrigin(id: string, origin: Record<string, unknown> | null): Promise<void> {
    await this.db.updateTable('automations').set({ origin: origin ? JSON.stringify(origin) : null }).where('id', '=', id).execute();
  }

  /** With a guard, writes only if the row still matches it (check-then-act in one statement); true if a row changed. */
  async setLastScheduled(id: string, ts: number, guard?: WriteGuard): Promise<boolean> {
    const r = await guarded(this.db.updateTable('automations').set({ last_scheduled_at: ts }).where('id', '=', id), guard).executeTakeFirst();
    return num(r.numUpdatedRows) > 0;
  }

  /** A run-chosen next fire (#437); null clears it. Guarded like setLastScheduled. */
  async setNextRun(id: string, at: number | null, byRun: string | null = null, guard?: WriteGuard): Promise<boolean> {
    const r = await guarded(this.db.updateTable('automations').set({ next_run_at: at, next_run_by: at === null ? null : byRun }).where('id', '=', id), guard).executeTakeFirst();
    return num(r.numUpdatedRows) > 0;
  }

  /** Script state (#407 Phase 7): the last `{"state": …}` a script printed. */
  async getState(id: string): Promise<unknown> {
    const row = await this.db.selectFrom('automation_state').select('state').where('automation_id', '=', id).executeTakeFirst();
    if (!row) return null;
    try { return JSON.parse(row.state); } catch { return null; }
  }

  async setState(id: string, state: unknown): Promise<void> {
    await this.db.insertInto('automation_state').values({ automation_id: id, state: JSON.stringify(state ?? null) })
      .onConflict((oc) => oc.column('automation_id').doUpdateSet({ state: (eb) => eb.ref('excluded.state') })).execute();
  }

  async remove(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('automations').where('id', '=', id).execute();
      await trx.deleteFrom('tags').where('entity_kind', '=', 'automation').where('entity_id', '=', id).execute();
      await trx.deleteFrom('automation_state').where('automation_id', '=', id).execute();
      // versions + runs are kept: run history outlives the automation (spec §7, uninstall keeps history).
    });
  }

  async versions(id: string): Promise<Array<{ version: number; definition: AutomationDef; createdAt: number; createdBy: TodoSource }>> {
    const rows = await this.db.selectFrom('automation_versions').selectAll().where('automation_id', '=', id).orderBy('version', 'desc').execute();
    return rows.map((v) => ({ version: v.version, definition: JSON.parse(v.definition) as AutomationDef, createdAt: v.created_at, createdBy: { kind: v.created_by_kind, id: v.created_by_id } }));
  }

  async tags(id: string): Promise<string[]> {
    const rows = await this.db.selectFrom('tags').select('tag').where('entity_kind', '=', 'automation').where('entity_id', '=', id).orderBy('tag').execute();
    return rows.map((r) => r.tag);
  }

  private async setTags(q: Q, id: string, raw: string[]): Promise<void> {
    await q.deleteFrom('tags').where('entity_kind', '=', 'automation').where('entity_id', '=', id).execute();
    for (const t of normalizeTags(raw)) {
      await q.insertInto('tags').values({ entity_kind: 'automation', entity_id: id, tag: t }).onConflict((oc) => oc.doNothing()).execute();
    }
  }

  // --- runs ----------------------------------------------------------------

  private toStepRunRow(s: StepRunRowSql): StepRunRow {
    return {
      id: s.id, runId: s.run_id, stepId: s.step_id, kind: s.kind, status: s.status, workspaceId: s.workspace_id,
      brokerSessionId: s.broker_session_id, startedAt: s.started_at, endedAt: s.ended_at, error: s.error,
      detail: s.detail ? (JSON.parse(s.detail) as Record<string, unknown>) : null
    };
  }

  private rowToRun(r: RunRowSql, steps: StepRunRow[]): RunRow {
    return {
      id: r.id, automationId: r.automation_id, version: r.version,
      trigger: JSON.parse(r.trigger) as RunRow['trigger'], args: JSON.parse(r.args) as Record<string, ParamValue>,
      status: r.status, startedAt: r.started_at, endedAt: r.ended_at, error: r.error, steps,
      ...(r.reschedule ? { reschedule: JSON.parse(r.reschedule) as NonNullable<RunRow['reschedule']> } : {})
    };
  }

  private async toRun(q: Q, r: RunRowSql): Promise<RunRow> {
    return this.rowToRun(r, await this.stepsWith(q, r.id));
  }

  /** Batched stepsWith for N runs: one `run_id IN (...)` query per ≤500-id chunk instead of one per run. */
  private async stepsForRunIds(q: Q, runIds: string[]): Promise<Map<string, StepRunRow[]>> {
    const out = new Map<string, StepRunRow[]>();
    if (runIds.length === 0) return out;
    for (const chunk of chunked(runIds)) {
      const rows = await q.selectFrom('step_runs').selectAll().where('run_id', 'in', chunk).orderBy('run_id').orderBy('id').execute();
      for (const s of rows) {
        const step = this.toStepRunRow(s);
        const list = out.get(s.run_id);
        if (list) list.push(step); else out.set(s.run_id, [step]);
      }
    }
    return out;
  }

  /** Attaches steps to several run rows with one batched query instead of one per run. */
  private async toRuns(q: Q, rows: RunRowSql[]): Promise<RunRow[]> {
    if (rows.length === 0) return [];
    const stepsByRun = await this.stepsForRunIds(q, rows.map((r) => r.id));
    return rows.map((r) => this.rowToRun(r, stepsByRun.get(r.id) ?? []));
  }

  private async stepsWith(q: Q, runId: string): Promise<StepRunRow[]> {
    const rows = await q.selectFrom('step_runs').selectAll().where('run_id', '=', runId).orderBy('id').execute();
    return rows.map((s) => this.toStepRunRow(s));
  }
  steps(runId: string): Promise<StepRunRow[]> {
    return this.stepsWith(this.db, runId);
  }

  async startRun(a: AutomationRecord, trigger: RunRow['trigger'], args: Record<string, ParamValue>, status: RunStatus, now = Date.now(), error: string | null = null): Promise<RunRow> {
    const id = newId(now);
    await this.db.insertInto('runs').values({
      id, automation_id: a.id, version: a.version, trigger: JSON.stringify(trigger), args: JSON.stringify(args), status,
      started_at: now, ended_at: status === 'running' || status === 'queued' ? null : now, error
    }).execute();
    return (await this.getRun(id))!;
  }

  async setRunStatus(id: string, status: RunStatus, now = Date.now(), error: string | null = null): Promise<void> {
    const ended = status === 'running' || status === 'queued' ? null : now;
    await this.db.updateTable('runs').set({ status, ended_at: ended, error }).where('id', '=', id).execute();
  }

  /** What a run asked for as its next fire and what it was given (#437). */
  async setRunReschedule(id: string, r: NonNullable<RunRow['reschedule']>): Promise<void> {
    await this.db.updateTable('runs').set({ reschedule: JSON.stringify(r) }).where('id', '=', id).execute();
  }

  async getRun(id: string): Promise<RunRow | null> {
    const r = await this.db.selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? this.toRun(this.db, r) : null;
  }

  async runs(automationId: string, limit = 50): Promise<RunRow[]> {
    const rows = await this.db.selectFrom('runs').selectAll().where('automation_id', '=', automationId)
      .orderBy('started_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return this.toRuns(this.db, rows);
  }

  private async runsWith(q: Q, status: RunStatus): Promise<RunRow[]> {
    const rows = await q.selectFrom('runs').selectAll().where('status', '=', status).orderBy('started_at').orderBy('id').execute();
    return this.toRuns(q, rows);
  }
  runsWithStatus(status: RunStatus): Promise<RunRow[]> {
    return this.runsWith(this.db, status);
  }

  async weekStats(automationId: string, now = Date.now()): Promise<{ runs: number; nothingToDo: number; failed: number }> {
    const r = await this.db.selectFrom('runs')
      .select([
        (eb) => eb.fn.countAll().as('runs'),
        sql<number | null>`SUM(CASE WHEN status = 'nothing-to-do' THEN 1 ELSE 0 END)`.as('ntd'),
        sql<number | null>`SUM(CASE WHEN status IN ('failed','timed-out','interrupted') THEN 1 ELSE 0 END)`.as('failed')
      ])
      .where('automation_id', '=', automationId).where('started_at', '>=', now - 7 * 86_400_000)
      .where('status', 'not in', ['skipped', 'queued'])
      .executeTakeFirstOrThrow();
    return { runs: num(r.runs), nothingToDo: num(r.ntd), failed: num(r.failed) };
  }

  async startStep(runId: string, stepId: string, kind: 'prompt' | 'script', workspaceId: string | null, now = Date.now()): Promise<number> {
    const r = await this.db.insertInto('step_runs')
      .values({ run_id: runId, step_id: stepId, kind, status: 'running', workspace_id: workspaceId, started_at: now })
      .returning('id').executeTakeFirstOrThrow();
    return r.id;
  }

  async finishStep(id: number, status: RunStatus, patch: { error?: string | null; brokerSessionId?: string | null; detail?: Record<string, unknown> } = {}, now = Date.now()): Promise<void> {
    const detail = patch.detail ? JSON.stringify(patch.detail) : null;
    await this.db.updateTable('step_runs').set({
      status, ended_at: now, error: patch.error ?? null,
      broker_session_id: sql<string | null>`coalesce(${patch.brokerSessionId ?? null}, broker_session_id)`,
      detail: sql<string | null>`coalesce(${detail}, detail)`
    }).where('id', '=', id).execute();
  }

  /** Startup: anything still `running` was cut off by a quit/crash. */
  markInterrupted(now = Date.now()): Promise<RunRow[]> {
    return this.db.transaction().execute(async (trx) => {
      const cut = await this.runsWith(trx, 'running');
      await trx.updateTable('runs').set({ status: 'interrupted', ended_at: now, error: 'the app quit mid-run' }).where('status', '=', 'running').execute();
      await trx.updateTable('step_runs').set({ status: 'interrupted', ended_at: now }).where('status', '=', 'running').execute();
      await trx.updateTable('runs').set({ status: 'cancelled', ended_at: now, error: 'the app quit before it started' }).where('status', '=', 'queued').execute();
      return cut;
    });
  }

  pruneRuns(olderThan: number): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('step_runs')
        .where('run_id', 'in', trx.selectFrom('runs').select('id').where('started_at', '<', olderThan)).execute();
      const r = await trx.deleteFrom('runs').where('started_at', '<', olderThan).executeTakeFirst();
      return Number(r.numDeletedRows);
    });
  }
}
