// Automations repository (#407 Phase 3) over the inbox.db connection:
// definitions + version history, tags, per-automation state, runs, step runs.
import type Database from 'better-sqlite3';
import type {
  AutomationDef, ParamValue, RunRow, RunStatus, StepRunRow, TodoSource
} from '../../preload/inboxTypes.js';
import { newId } from '../inbox/inboxDb.js';
import { normalizeTags } from '../inbox/inboxCore.js';

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
}

interface ARow {
  id: string; name: string; enabled: number; version: number; definition: string; created_by_kind: TodoSource['kind'];
  created_by_id: string | null; origin: string | null; created_at: number; updated_at: number; last_scheduled_at: number | null;
}

function toRecord(r: ARow): AutomationRecord {
  return {
    id: r.id, name: r.name, enabled: r.enabled === 1, version: r.version, definition: JSON.parse(r.definition) as AutomationDef,
    createdBy: { kind: r.created_by_kind, id: r.created_by_id }, origin: r.origin ? (JSON.parse(r.origin) as Record<string, unknown>) : null,
    createdAt: r.created_at, updatedAt: r.updated_at, lastScheduledAt: r.last_scheduled_at
  };
}

interface RRow {
  id: string; automation_id: string; version: number; trigger: string; args: string; status: RunStatus;
  started_at: number; ended_at: number | null; error: string | null;
}
interface SRow {
  id: number; run_id: string; step_id: string; kind: 'prompt' | 'script'; status: RunStatus; workspace_id: string | null;
  broker_session_id: string | null; started_at: number; ended_at: number | null; error: string | null; detail: string | null;
}

export class AutomationStore {
  constructor(private readonly db: Database.Database) {}

  // --- definitions ---------------------------------------------------------

  list(): AutomationRecord[] {
    return (this.db.prepare('SELECT * FROM automations ORDER BY name').all() as ARow[]).map(toRecord);
  }

  get(id: string): AutomationRecord | null {
    const r = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as ARow | undefined;
    return r ? toRecord(r) : null;
  }

  byName(name: string): AutomationRecord | null {
    const r = this.db.prepare('SELECT * FROM automations WHERE name = ?').get(name) as ARow | undefined;
    return r ? toRecord(r) : null;
  }

  create(def: AutomationDef, by: TodoSource, now = Date.now(), enabled = true, origin: Record<string, unknown> | null = null): AutomationRecord {
    if (this.byName(def.name)) throw new Error(`an automation named "${def.name}" already exists`);
    const id = newId(now);
    return this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO automations (id, name, enabled, version, definition, created_by_kind, created_by_id, origin, created_at, updated_at, last_scheduled_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, def.name, enabled ? 1 : 0, JSON.stringify(def), by.kind, by.id, origin ? JSON.stringify(origin) : null, now, now, now);
      this.db.prepare('INSERT INTO automation_versions VALUES (?, 1, ?, ?, ?, ?)').run(id, JSON.stringify(def), now, by.kind, by.id);
      this.setTags(id, def.tags ?? []);
      return this.get(id)!;
    })();
  }

  /** A new version of the definition. Renames are allowed when the new name is free. */
  update(id: string, def: AutomationDef, by: TodoSource, now = Date.now()): AutomationRecord {
    const cur = this.get(id);
    if (!cur) throw new Error(`automation ${id} not found`);
    const clash = this.byName(def.name);
    if (clash && clash.id !== id) throw new Error(`an automation named "${def.name}" already exists`);
    const version = cur.version + 1;
    return this.db.transaction(() => {
      this.db.prepare('UPDATE automations SET name = ?, version = ?, definition = ?, updated_at = ? WHERE id = ?')
        .run(def.name, version, JSON.stringify(def), now, id);
      this.db.prepare('INSERT INTO automation_versions VALUES (?, ?, ?, ?, ?, ?)').run(id, version, JSON.stringify(def), now, by.kind, by.id);
      this.setTags(id, def.tags ?? []);
      return this.get(id)!;
    })();
  }

  setEnabled(id: string, enabled: boolean, now = Date.now()): void {
    // Re-enabling restarts the schedule clock so a long-disabled automation doesn't fire a stale catch-up.
    this.db.prepare('UPDATE automations SET enabled = ?, updated_at = ?, last_scheduled_at = CASE WHEN ? THEN ? ELSE last_scheduled_at END WHERE id = ?')
      .run(enabled ? 1 : 0, now, enabled ? 1 : 0, now, id);
  }

  /** Loadout provenance (#407 Phase 8). */
  setOrigin(id: string, origin: Record<string, unknown> | null): void {
    this.db.prepare('UPDATE automations SET origin = ? WHERE id = ?').run(origin ? JSON.stringify(origin) : null, id);
  }

  setLastScheduled(id: string, ts: number): void {
    this.db.prepare('UPDATE automations SET last_scheduled_at = ? WHERE id = ?').run(ts, id);
  }

  /** Script state (#407 Phase 7): the last `{"state": …}` a script printed. */
  getState(id: string): unknown {
    const row = this.db.prepare('SELECT state FROM automation_state WHERE automation_id = ?').get(id) as { state: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.state); } catch { return null; }
  }

  setState(id: string, state: unknown): void {
    this.db.prepare('INSERT INTO automation_state (automation_id, state) VALUES (?, ?) ON CONFLICT(automation_id) DO UPDATE SET state = excluded.state')
      .run(id, JSON.stringify(state ?? null));
  }

  remove(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM automations WHERE id = ?').run(id);
      this.db.prepare(`DELETE FROM tags WHERE entity_kind = 'automation' AND entity_id = ?`).run(id);
      this.db.prepare('DELETE FROM automation_state WHERE automation_id = ?').run(id);
      // versions + runs are kept: run history outlives the automation (spec §7, uninstall keeps history).
    })();
  }

  versions(id: string): Array<{ version: number; definition: AutomationDef; createdAt: number; createdBy: TodoSource }> {
    return (this.db.prepare('SELECT * FROM automation_versions WHERE automation_id = ? ORDER BY version DESC').all(id) as Array<{
      version: number; definition: string; created_at: number; created_by_kind: TodoSource['kind']; created_by_id: string | null;
    }>).map((v) => ({ version: v.version, definition: JSON.parse(v.definition) as AutomationDef, createdAt: v.created_at, createdBy: { kind: v.created_by_kind, id: v.created_by_id } }));
  }

  tags(id: string): string[] {
    return (this.db.prepare(`SELECT tag FROM tags WHERE entity_kind = 'automation' AND entity_id = ? ORDER BY tag`).all(id) as Array<{ tag: string }>).map((r) => r.tag);
  }

  private setTags(id: string, raw: string[]): void {
    this.db.prepare(`DELETE FROM tags WHERE entity_kind = 'automation' AND entity_id = ?`).run(id);
    const ins = this.db.prepare(`INSERT OR IGNORE INTO tags (entity_kind, entity_id, tag) VALUES ('automation', ?, ?)`);
    for (const t of normalizeTags(raw)) ins.run(id, t);
  }

  // --- runs ----------------------------------------------------------------

  private toRun(r: RRow): RunRow {
    return {
      id: r.id, automationId: r.automation_id, version: r.version,
      trigger: JSON.parse(r.trigger) as RunRow['trigger'], args: JSON.parse(r.args) as Record<string, ParamValue>,
      status: r.status, startedAt: r.started_at, endedAt: r.ended_at, error: r.error, steps: this.steps(r.id)
    };
  }

  steps(runId: string): StepRunRow[] {
    return (this.db.prepare('SELECT * FROM step_runs WHERE run_id = ? ORDER BY id').all(runId) as SRow[]).map((s) => ({
      id: s.id, runId: s.run_id, stepId: s.step_id, kind: s.kind, status: s.status, workspaceId: s.workspace_id,
      brokerSessionId: s.broker_session_id, startedAt: s.started_at, endedAt: s.ended_at, error: s.error,
      detail: s.detail ? (JSON.parse(s.detail) as Record<string, unknown>) : null
    }));
  }

  startRun(a: AutomationRecord, trigger: RunRow['trigger'], args: Record<string, ParamValue>, status: RunStatus, now = Date.now(), error: string | null = null): RunRow {
    const id = newId(now);
    this.db.prepare('INSERT INTO runs (id, automation_id, version, trigger, args, status, started_at, ended_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, a.id, a.version, JSON.stringify(trigger), JSON.stringify(args), status, now, status === 'running' || status === 'queued' ? null : now, error);
    return this.getRun(id)!;
  }

  setRunStatus(id: string, status: RunStatus, now = Date.now(), error: string | null = null): void {
    const ended = status === 'running' || status === 'queued' ? null : now;
    this.db.prepare('UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?').run(status, ended, error, id);
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RRow | undefined;
    return r ? this.toRun(r) : null;
  }

  runs(automationId: string, limit = 50): RunRow[] {
    return (this.db.prepare('SELECT * FROM runs WHERE automation_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(automationId, limit) as RRow[]).map((r) => this.toRun(r));
  }

  runsWithStatus(status: RunStatus): RunRow[] {
    return (this.db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY started_at, id').all(status) as RRow[]).map((r) => this.toRun(r));
  }

  weekStats(automationId: string, now = Date.now()): { runs: number; nothingToDo: number; failed: number } {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS runs,
              SUM(CASE WHEN status = 'nothing-to-do' THEN 1 ELSE 0 END) AS ntd,
              SUM(CASE WHEN status IN ('failed','timed-out','interrupted') THEN 1 ELSE 0 END) AS failed
         FROM runs WHERE automation_id = ? AND started_at >= ? AND status NOT IN ('skipped','queued')`
    ).get(automationId, now - 7 * 86_400_000) as { runs: number; ntd: number | null; failed: number | null };
    return { runs: r.runs, nothingToDo: r.ntd ?? 0, failed: r.failed ?? 0 };
  }

  startStep(runId: string, stepId: string, kind: 'prompt' | 'script', workspaceId: string | null, now = Date.now()): number {
    return Number(this.db.prepare(`INSERT INTO step_runs (run_id, step_id, kind, status, workspace_id, started_at) VALUES (?, ?, ?, 'running', ?, ?)`)
      .run(runId, stepId, kind, workspaceId, now).lastInsertRowid);
  }

  finishStep(id: number, status: RunStatus, patch: { error?: string | null; brokerSessionId?: string | null; detail?: Record<string, unknown> } = {}, now = Date.now()): void {
    this.db.prepare('UPDATE step_runs SET status = ?, ended_at = ?, error = ?, broker_session_id = COALESCE(?, broker_session_id), detail = COALESCE(?, detail) WHERE id = ?')
      .run(status, now, patch.error ?? null, patch.brokerSessionId ?? null, patch.detail ? JSON.stringify(patch.detail) : null, id);
  }

  /** Startup: anything still `running` was cut off by a quit/crash. */
  markInterrupted(now = Date.now()): RunRow[] {
    const cut = this.runsWithStatus('running');
    this.db.transaction(() => {
      this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = 'the app quit mid-run' WHERE status = 'running'`).run(now);
      this.db.prepare(`UPDATE step_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'`).run(now);
      this.db.prepare(`UPDATE runs SET status = 'cancelled', ended_at = ?, error = 'the app quit before it started' WHERE status = 'queued'`).run(now);
    })();
    return cut;
  }

  pruneRuns(olderThan: number): number {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM step_runs WHERE run_id IN (SELECT id FROM runs WHERE started_at < ?)').run(olderThan);
      return this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(olderThan).changes;
    })();
  }
}
