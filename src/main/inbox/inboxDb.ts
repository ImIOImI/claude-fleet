// Authoritative inbox store at <userData>/inbox.db (#407). Unlike state.db this
// is NOT a rebuildable cache — so migrations are versioned and every migration
// of an existing file is preceded by a timestamped backup copy.
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  InboxCounts, PostTodoInput, Todo, TodoEvent, TodoFilter, TodoSource, UpdateTodoPatch
} from '../../preload/inboxTypes.js';
import { isPriority, maxPriority, normalizeTag, normalizeTags, MAX_TAGS } from './inboxCore.js';
import { chunked, num, sqliteKysely } from '../store/kysely.js';
import type { InboxDb, TodoRow } from '../store/inboxSchema.js';

export const INBOX_SCHEMA_VERSION = 8;

/** @internal for tests — lets a migration test build a real file DB at an
 *  older schema version (running a prefix of these) without duplicating the
 *  SQL here. Not part of the module's public contract. */
export const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL CHECK (status IN ('open','done','dismissed')),
      priority TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('user','workspace','automation')),
      source_id TEXT,
      source_run_id TEXT,
      via_workspace TEXT,
      dedupe_key TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      recurred INTEGER NOT NULL DEFAULT 0,
      workspace_id TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE UNIQUE INDEX todos_dedupe ON todos (source_kind, IFNULL(source_id, ''), dedupe_key)
      WHERE dedupe_key IS NOT NULL;
    CREATE INDEX todos_open ON todos (status, priority, last_seen_at);
    CREATE TABLE tags (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (entity_kind, entity_id, tag)
    );
    CREATE TABLE todo_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT,
      run_id TEXT,
      detail TEXT
    );
    CREATE INDEX todo_events_todo ON todo_events (todo_id, id);
  `,
  // Phase 2 (notifications): the log, the user's rules, downtime schedules and
  // small key/value state (pause, default level).
  2: `
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      priority TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      todo_id TEXT,
      workspace_id TEXT,
      dedupe_key TEXT,
      tags TEXT,
      delivered INTEGER NOT NULL,
      held_reason TEXT,
      channel TEXT,
      cleared_at INTEGER,
      digested INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX notifications_ts ON notifications (ts);
    CREATE TABLE notification_rules (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('key','source','tag','global')),
      scope_value TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('all','high','urgent','off')),
      snooze_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (scope_kind, scope_value)
    );
    CREATE TABLE downtimes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      days_mask INTEGER NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      bypass TEXT NOT NULL CHECK (bypass IN ('none','urgent','urgent+input')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE notify_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `,
  // Phase 3 (automations): definitions + their approved versions, small
  // per-automation state, runs and step runs.
  3: `
    CREATE TABLE automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      created_by_kind TEXT NOT NULL,
      created_by_id TEXT,
      origin TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_scheduled_at INTEGER
    );
    CREATE TABLE automation_versions (
      automation_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by_kind TEXT NOT NULL,
      created_by_id TEXT,
      PRIMARY KEY (automation_id, version)
    );
    CREATE TABLE automation_state (automation_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      args TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      error TEXT
    );
    CREATE INDEX runs_automation ON runs (automation_id, started_at);
    CREATE INDEX runs_status ON runs (status);
    CREATE TABLE step_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_id TEXT,
      broker_session_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      error TEXT,
      detail TEXT
    );
    CREATE INDEX step_runs_run ON step_runs (run_id, id);
  `,
  // Phase 5 (proposals): workspace-proposed automations and changes, with the
  // user's decision on each item. Kept permanently as the audit trail.
  4: `
    CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('new','change','batch')),
      proposer_kind TEXT NOT NULL,
      proposer_id TEXT,
      rationale TEXT,
      status TEXT NOT NULL,
      items TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX proposals_status ON proposals (status, created_at);
  `,
  // #437: a next fire chosen by a run (replaces the cron until it fires), and
  // what each run requested / was given.
  5: `
    ALTER TABLE automations ADD COLUMN next_run_at INTEGER;
    ALTER TABLE automations ADD COLUMN next_run_by TEXT;
    ALTER TABLE runs ADD COLUMN reschedule TEXT;
  `,
  // #483: knowledge claims (phase 1) + background capture runs.
  6: `
    CREATE TABLE claims (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, topics TEXT NOT NULL,
      refs TEXT, visibility TEXT NOT NULL DEFAULT 'fleet', status TEXT NOT NULL DEFAULT 'current',
      superseded_by TEXT, retract_reason TEXT, workspace_id TEXT NOT NULL,
      confirmations INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_claims_status_vis ON claims (status, visibility, workspace_id);
    CREATE TABLE claim_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      session_id TEXT, via TEXT NOT NULL, capture_run TEXT, ts INTEGER NOT NULL
    );
    CREATE INDEX idx_claim_sources_claim ON claim_sources (claim_id);
    CREATE TABLE claim_vectors (claim_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, vec BLOB NOT NULL);
    CREATE VIRTUAL TABLE claims_fts USING fts5(claim_id UNINDEXED, text, topics);
    CREATE TABLE capture_runs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, fork_session_id TEXT,
      trigger TEXT NOT NULL, status TEXT NOT NULL, claims_recorded INTEGER NOT NULL DEFAULT 0,
      usage TEXT, error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE INDEX idx_capture_runs_session ON capture_runs (session_id, started_at);
    CREATE INDEX idx_capture_runs_status ON capture_runs (status);
  `,
  // #483 §5a: capture-settings change log, capture-settings proposals (payload),
  // and the user-turn baseline that recaptureAfterTurns is measured from.
  7: `
    CREATE TABLE capture_settings_log (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, actor TEXT NOT NULL,
      "before" TEXT NOT NULL, "after" TEXT NOT NULL, reason TEXT, applied INTEGER NOT NULL, proposal_id TEXT
    );
    CREATE INDEX idx_capture_settings_log_ws ON capture_settings_log (workspace_id, ts);
    -- proposals.kind has a CHECK (v4) that SQLite can't alter: rebuild the
    -- table to admit 'capture-settings' and add the payload column.
    CREATE TABLE proposals_v7 (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('new','change','batch','capture-settings')),
      proposer_kind TEXT NOT NULL,
      proposer_id TEXT,
      rationale TEXT,
      status TEXT NOT NULL,
      items TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      payload TEXT
    );
    INSERT INTO proposals_v7 (id, kind, proposer_kind, proposer_id, rationale, status, items, note, created_at, decided_at)
      SELECT id, kind, proposer_kind, proposer_id, rationale, status, items, note, created_at, decided_at FROM proposals;
    DROP TABLE proposals;
    ALTER TABLE proposals_v7 RENAME TO proposals;
    CREATE INDEX proposals_status ON proposals (status, created_at);
    ALTER TABLE capture_runs ADD COLUMN user_turns INTEGER;
    CREATE INDEX idx_capture_runs_started ON capture_runs (started_at);
  `,
  // #483 final review: the workspace's effective captureVisibility at admit
  // (record_claim forces private claims for a private run), and the session's
  // compaction count at admit (ctx bands don't re-fire after an app restart).
  8: `
    ALTER TABLE capture_runs ADD COLUMN visibility TEXT;
    ALTER TABLE capture_runs ADD COLUMN compactions INTEGER;
  `
};

// Crockford base32 ULID: 10 chars time + 16 chars randomness.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newId(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[Math.floor(Math.random() * 32)];
  return time + rand;
}

type Q = Kysely<InboxDb> | Transaction<InboxDb>;

const PRIORITY_ORDER = sql<number>`CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

export class InboxStore {
  private constructor(private readonly raw: Database.Database, readonly kysely: Kysely<InboxDb>) {}

  static open(dir: string): InboxStore {
    const file = path.join(dir, 'inbox.db');
    const existed = existsSync(file);
    if (existed) {
      const probe = new Database(file);
      const v = probe.pragma('user_version', { simple: true }) as number;
      probe.close();
      if (v < INBOX_SCHEMA_VERSION) copyFileSync(file, `${file}.bak-v${v}-${Date.now()}`);
    }
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    return InboxStore.init(db);
  }

  static memory(): InboxStore {
    return InboxStore.init(new Database(':memory:'));
  }

  private static init(db: Database.Database): InboxStore {
    db.pragma('foreign_keys = ON');
    const current = db.pragma('user_version', { simple: true }) as number;
    for (let v = current + 1; v <= INBOX_SCHEMA_VERSION; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]);
        db.pragma(`user_version = ${v}`);
      })();
    }
    return new InboxStore(db, sqliteKysely<InboxDb>(db));
  }

  async close(): Promise<void> {
    // destroy() only closes the connection if Kysely ever ran a query, so close the raw handle too.
    await this.kysely.destroy();
    if (this.raw.open) this.raw.close();
  }

  // --- reads --------------------------------------------------------------

  private async tagsFor(q: Q, id: string): Promise<string[]> {
    const rows = await q.selectFrom('tags').select('tag').where('entity_kind', '=', 'todo').where('entity_id', '=', id).orderBy('tag').execute();
    return rows.map((r) => r.tag);
  }

  /** Batched tagsFor for N todos: one `entity_id IN (...)` query per ≤500-id chunk instead of one per todo. */
  private async tagsForIds(q: Q, ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    for (const chunk of chunked(ids)) {
      const rows = await q.selectFrom('tags').select(['entity_id', 'tag']).where('entity_kind', '=', 'todo')
        .where('entity_id', 'in', chunk).orderBy('entity_id').orderBy('tag').execute();
      for (const r of rows) {
        const list = out.get(r.entity_id);
        if (list) list.push(r.tag); else out.set(r.entity_id, [r.tag]);
      }
    }
    return out;
  }

  private rowToTodo(r: TodoRow, tags: string[]): Todo {
    return {
      id: r.id, title: r.title, body: r.body, status: r.status, priority: r.priority,
      source: { kind: r.source_kind, id: r.source_id }, sourceRunId: r.source_run_id,
      viaWorkspace: r.via_workspace, dedupeKey: r.dedupe_key, seenCount: r.seen_count,
      recurred: r.recurred === 1, workspaceId: r.workspace_id, sessionId: r.session_id,
      tags, createdAt: r.created_at, updatedAt: r.updated_at,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, closedAt: r.closed_at
    };
  }

  private async toTodo(q: Q, r: TodoRow): Promise<Todo> {
    return this.rowToTodo(r, await this.tagsFor(q, r.id));
  }

  private async getWith(q: Q, id: string): Promise<Todo | null> {
    const r = await q.selectFrom('todos').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? this.toTodo(q, r) : null;
  }

  get(id: string): Promise<Todo | null> {
    return this.getWith(this.kysely, id);
  }

  async events(id: string): Promise<TodoEvent[]> {
    const rows = await this.kysely.selectFrom('todo_events').selectAll().where('todo_id', '=', id).orderBy('id').execute();
    return rows.map((e) => ({
      id: e.id, todoId: e.todo_id, ts: e.ts, kind: e.kind, actor: { kind: e.actor_kind, id: e.actor_id },
      runId: e.run_id, detail: e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : null
    }));
  }

  async list(filter: TodoFilter = {}): Promise<Todo[]> {
    const status = filter.status ?? 'open';
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 200)), 500);
    let q = this.kysely.selectFrom('todos').selectAll();
    if (status !== 'all') q = q.where('status', '=', status);
    const v = filter.visibleTo;
    if (v) {
      q = q.where((eb) => eb.or([
        eb.and([eb('source_kind', '=', 'workspace'), eb('source_id', '=', v)]),
        eb('workspace_id', '=', v),
        eb('via_workspace', '=', v)
      ]));
    }
    for (const raw of filter.tags ?? []) {
      const t = normalizeTag(raw);
      if (!t) continue;
      q = q.where((eb) => eb.exists(
        eb.selectFrom('tags as g').select('g.tag')
          .where('g.entity_kind', '=', 'todo').whereRef('g.entity_id', '=', 'todos.id').where('g.tag', '=', t)
      ));
    }
    const rows = await q.orderBy(PRIORITY_ORDER).orderBy('last_seen_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    const tagsById = await this.tagsForIds(this.kysely, rows.map((r) => r.id));
    return rows.map((r) => this.rowToTodo(r, tagsById.get(r.id) ?? []));
  }

  async counts(): Promise<InboxCounts> {
    const r = await this.kysely.selectFrom('todos')
      .select([
        (eb) => eb.fn.countAll().as('open'),
        sql<number | null>`SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END)`.as('urgent'),
        sql<number | null>`SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END)`.as('high')
      ])
      .where('status', '=', 'open').executeTakeFirstOrThrow();
    const a = await this.kysely.selectFrom('proposals').select((eb) => eb.fn.countAll().as('n')).where('status', '=', 'pending').executeTakeFirstOrThrow();
    return { open: num(r.open), urgent: num(r.urgent), high: num(r.high), approvals: num(a.n) };
  }

  // --- writes -------------------------------------------------------------

  private async event(q: Q, todoId: string, ts: number, kind: TodoEvent['kind'], actor: TodoSource, detail?: Record<string, unknown>): Promise<void> {
    await q.insertInto('todo_events').values({
      todo_id: todoId, ts, kind, actor_kind: actor.kind, actor_id: actor.id, run_id: null, detail: detail ? JSON.stringify(detail) : null
    }).execute();
  }

  private async addTags(q: Q, id: string, tags: string[]): Promise<string[]> {
    const existing = await this.tagsFor(q, id);
    const added: string[] = [];
    for (const t of tags) {
      if (existing.length + added.length >= MAX_TAGS) break;
      if (existing.includes(t) || added.includes(t)) continue;
      await q.insertInto('tags').values({ entity_kind: 'todo', entity_id: id, tag: t }).onConflict((oc) => oc.doNothing()).execute();
      added.push(t);
    }
    return added;
  }

  post(source: TodoSource, input: PostTodoInput, now = Date.now()): Promise<{ todo: Todo; action: 'created' | 'updated' | 'reopened' }> {
    return this.kysely.transaction().execute(async (trx) => {
      const priority = input.priority ?? 'normal';
      const tags = normalizeTags(input.tags ?? []);
      const existing = input.key
        ? await trx.selectFrom('todos').selectAll()
            .where('source_kind', '=', source.kind)
            .where(sql<string>`coalesce(source_id, '')`, '=', source.id ?? '')
            .where('dedupe_key', '=', input.key)
            .executeTakeFirst()
        : undefined;
      if (!existing) {
        const id = newId(now);
        await trx.insertInto('todos').values({
          id, title: input.title, body: input.body ?? null, status: 'open', priority, source_kind: source.kind, source_id: source.id,
          dedupe_key: input.key ?? null, workspace_id: input.workspaceLink ?? null, session_id: input.sessionLink ?? null,
          via_workspace: input.viaWorkspace ?? null, source_run_id: input.sourceRunId ?? null,
          created_at: now, updated_at: now, first_seen_at: now, last_seen_at: now
        }).execute();
        await this.addTags(trx, id, tags);
        await this.event(trx, id, now, 'created', source, { title: input.title, priority });
        return { todo: (await this.getWith(trx, id))!, action: 'created' as const };
      }
      const reopen = existing.status !== 'open';
      // Same effect as the old single UPDATE: computed from the row read in this transaction.
      await trx.updateTable('todos').set((eb) => ({
        seen_count: eb('seen_count', '+', 1), last_seen_at: now, updated_at: now,
        priority: maxPriority(existing.priority, priority),
        body: input.body ?? existing.body, status: 'open',
        recurred: reopen ? 1 : existing.recurred,
        closed_at: reopen ? null : existing.closed_at
      })).where('id', '=', existing.id).execute();
      await this.addTags(trx, existing.id, tags);
      await this.event(trx, existing.id, now, reopen ? 'reopened' : 'seen', source,
        { priority, ...(input.body !== undefined ? { body: input.body } : {}), ...(reopen ? { from: existing.status } : {}) });
      return { todo: (await this.getWith(trx, existing.id))!, action: reopen ? ('reopened' as const) : ('updated' as const) };
    });
  }

  update(actor: TodoSource, id: string, patch: UpdateTodoPatch, now = Date.now()): Promise<Todo> {
    return this.kysely.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('todos').selectAll().where('id', '=', id).executeTakeFirst();
      if (!cur) throw new Error(`todo ${id} not found`);
      if (patch.status && patch.status !== cur.status) {
        await trx.updateTable('todos').set({ status: patch.status, closed_at: patch.status === 'open' ? null : now, updated_at: now }).where('id', '=', id).execute();
        await this.event(trx, id, now, 'status', actor, { from: cur.status, to: patch.status });
      }
      if (patch.priority && isPriority(patch.priority) && patch.priority !== cur.priority) {
        await trx.updateTable('todos').set({ priority: patch.priority, updated_at: now }).where('id', '=', id).execute();
        await this.event(trx, id, now, 'priority', actor, { from: cur.priority, to: patch.priority });
      }
      const title = patch.title?.trim();
      if (title && title !== cur.title) {
        await trx.updateTable('todos').set({ title: title.slice(0, 200), updated_at: now }).where('id', '=', id).execute();
        await this.event(trx, id, now, 'title', actor, { from: cur.title, to: title });
      }
      const added = await this.addTags(trx, id, normalizeTags(patch.tagsAdd ?? []));
      if (added.length) await this.event(trx, id, now, 'tag_add', actor, { tags: added });
      const removed: string[] = [];
      for (const t of normalizeTags(patch.tagsRemove ?? [])) {
        const r = await trx.deleteFrom('tags').where('entity_kind', '=', 'todo').where('entity_id', '=', id).where('tag', '=', t).executeTakeFirst();
        if (Number(r.numDeletedRows)) removed.push(t);
      }
      if (removed.length) await this.event(trx, id, now, 'tag_remove', actor, { tags: removed });
      if (patch.bodyAppend && patch.bodyAppend.trim()) {
        const text = patch.bodyAppend.slice(0, 20_000);
        // body was not touched earlier in this transaction, so cur.body is current.
        const body = cur.body === null || cur.body === '' ? text : `${cur.body}\n\n${text}`;
        await trx.updateTable('todos').set({ body, updated_at: now }).where('id', '=', id).execute();
        await this.event(trx, id, now, 'body_append', actor, { text });
      }
      if (added.length || removed.length) await trx.updateTable('todos').set({ updated_at: now }).where('id', '=', id).execute();
      return (await this.getWith(trx, id))!;
    });
  }
}
