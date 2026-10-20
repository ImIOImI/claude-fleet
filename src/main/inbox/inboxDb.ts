// Authoritative inbox store at <userData>/inbox.db (#407). Unlike state.db this
// is NOT a rebuildable cache — so migrations are versioned and every migration
// of an existing file is preceded by a timestamped backup copy.
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type {
  InboxCounts, PostTodoInput, Todo, TodoEvent, TodoEventKind, TodoFilter, TodoSource, UpdateTodoPatch
} from '../../preload/inboxTypes.js';
import { isPriority, maxPriority, normalizeTag, normalizeTags, MAX_TAGS } from './inboxCore.js';

export const INBOX_SCHEMA_VERSION = 4;

const MIGRATIONS: Record<number, string> = {
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

interface TodoRow {
  id: string; title: string; body: string | null; status: Todo['status']; priority: Todo['priority'];
  source_kind: TodoSource['kind']; source_id: string | null; source_run_id: string | null;
  via_workspace: string | null; dedupe_key: string | null; seen_count: number; recurred: number;
  workspace_id: string | null; session_id: string | null; created_at: number; updated_at: number;
  first_seen_at: number; last_seen_at: number; closed_at: number | null;
}

const PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

export class InboxStore {
  private constructor(readonly db: Database.Database) {}

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
    return new InboxStore(db);
  }

  close(): void {
    this.db.close();
  }

  // --- reads --------------------------------------------------------------

  private tagsFor(id: string): string[] {
    return (this.db
      .prepare(`SELECT tag FROM tags WHERE entity_kind = 'todo' AND entity_id = ? ORDER BY tag`)
      .all(id) as Array<{ tag: string }>).map((r) => r.tag);
  }

  private toTodo(r: TodoRow): Todo {
    return {
      id: r.id, title: r.title, body: r.body, status: r.status, priority: r.priority,
      source: { kind: r.source_kind, id: r.source_id }, sourceRunId: r.source_run_id,
      viaWorkspace: r.via_workspace, dedupeKey: r.dedupe_key, seenCount: r.seen_count,
      recurred: r.recurred === 1, workspaceId: r.workspace_id, sessionId: r.session_id,
      tags: this.tagsFor(r.id), createdAt: r.created_at, updatedAt: r.updated_at,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, closedAt: r.closed_at
    };
  }

  get(id: string): Todo | null {
    const r = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as TodoRow | undefined;
    return r ? this.toTodo(r) : null;
  }

  events(id: string): TodoEvent[] {
    const rows = this.db.prepare('SELECT * FROM todo_events WHERE todo_id = ? ORDER BY id').all(id) as Array<{
      id: number; todo_id: string; ts: number; kind: TodoEventKind; actor_kind: TodoSource['kind'];
      actor_id: string | null; run_id: string | null; detail: string | null;
    }>;
    return rows.map((e) => ({
      id: e.id, todoId: e.todo_id, ts: e.ts, kind: e.kind, actor: { kind: e.actor_kind, id: e.actor_id },
      runId: e.run_id, detail: e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : null
    }));
  }

  list(filter: TodoFilter = {}): Todo[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const status = filter.status ?? 'open';
    if (status !== 'all') {
      where.push('status = ?');
      params.push(status);
    }
    if (filter.visibleTo) {
      where.push(`((source_kind = 'workspace' AND source_id = ?) OR workspace_id = ? OR via_workspace = ?)`);
      params.push(filter.visibleTo, filter.visibleTo, filter.visibleTo);
    }
    for (const raw of filter.tags ?? []) {
      const t = normalizeTag(raw);
      if (!t) continue;
      where.push(`EXISTS (SELECT 1 FROM tags g WHERE g.entity_kind = 'todo' AND g.entity_id = todos.id AND g.tag = ?)`);
      params.push(t);
    }
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 200)), 500);
    const sql =
      `SELECT * FROM todos ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ` +
      `ORDER BY ${PRIORITY_ORDER}, last_seen_at DESC, id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as TodoRow[]).map((r) => this.toTodo(r));
  }

  counts(): InboxCounts {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS open,
              SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) AS urgent,
              SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) AS high
         FROM todos WHERE status = 'open'`
    ).get() as { open: number; urgent: number | null; high: number | null };
    const approvals = (this.db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'`).get() as { n: number }).n;
    return { open: r.open, urgent: r.urgent ?? 0, high: r.high ?? 0, approvals };
  }

  // --- writes -------------------------------------------------------------

  private event(todoId: string, ts: number, kind: TodoEventKind, actor: TodoSource, detail?: Record<string, unknown>): void {
    this.db.prepare(
      'INSERT INTO todo_events (todo_id, ts, kind, actor_kind, actor_id, run_id, detail) VALUES (?, ?, ?, ?, ?, NULL, ?)'
    ).run(todoId, ts, kind, actor.kind, actor.id, detail ? JSON.stringify(detail) : null);
  }

  private addTags(id: string, tags: string[]): string[] {
    const existing = this.tagsFor(id);
    const added: string[] = [];
    for (const t of tags) {
      if (existing.length + added.length >= MAX_TAGS) break;
      if (existing.includes(t) || added.includes(t)) continue;
      this.db.prepare(`INSERT OR IGNORE INTO tags (entity_kind, entity_id, tag) VALUES ('todo', ?, ?)`).run(id, t);
      added.push(t);
    }
    return added;
  }

  post(source: TodoSource, input: PostTodoInput, now = Date.now()): { todo: Todo; action: 'created' | 'updated' | 'reopened' } {
    return this.db.transaction(() => {
      const priority = input.priority ?? 'normal';
      const tags = normalizeTags(input.tags ?? []);
      const existing = input.key
        ? (this.db.prepare(
            `SELECT * FROM todos WHERE source_kind = ? AND IFNULL(source_id, '') = ? AND dedupe_key = ?`
          ).get(source.kind, source.id ?? '', input.key) as TodoRow | undefined)
        : undefined;
      if (!existing) {
        const id = newId(now);
        this.db.prepare(
          `INSERT INTO todos (id, title, body, status, priority, source_kind, source_id, dedupe_key,
             workspace_id, session_id, via_workspace, source_run_id, created_at, updated_at, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, input.title, input.body ?? null, priority, source.kind, source.id, input.key ?? null,
          input.workspaceLink ?? null, input.sessionLink ?? null, input.viaWorkspace ?? null, input.sourceRunId ?? null, now, now, now, now);
        this.addTags(id, tags);
        this.event(id, now, 'created', source, { title: input.title, priority });
        return { todo: this.get(id)!, action: 'created' as const };
      }
      const reopen = existing.status !== 'open';
      this.db.prepare(
        `UPDATE todos SET seen_count = seen_count + 1, last_seen_at = ?, updated_at = ?, priority = ?,
           body = COALESCE(?, body), status = 'open',
           recurred = CASE WHEN ? THEN 1 ELSE recurred END,
           closed_at = CASE WHEN ? THEN NULL ELSE closed_at END
         WHERE id = ?`
      ).run(now, now, maxPriority(existing.priority, priority), input.body ?? null, reopen ? 1 : 0, reopen ? 1 : 0, existing.id);
      this.addTags(existing.id, tags);
      this.event(existing.id, now, reopen ? 'reopened' : 'seen', source,
        { priority, ...(input.body !== undefined ? { body: input.body } : {}), ...(reopen ? { from: existing.status } : {}) });
      return { todo: this.get(existing.id)!, action: reopen ? ('reopened' as const) : ('updated' as const) };
    })();
  }

  update(actor: TodoSource, id: string, patch: UpdateTodoPatch, now = Date.now()): Todo {
    return this.db.transaction(() => {
      const cur = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as TodoRow | undefined;
      if (!cur) throw new Error(`todo ${id} not found`);
      if (patch.status && patch.status !== cur.status) {
        this.db.prepare('UPDATE todos SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?')
          .run(patch.status, patch.status === 'open' ? null : now, now, id);
        this.event(id, now, 'status', actor, { from: cur.status, to: patch.status });
      }
      if (patch.priority && isPriority(patch.priority) && patch.priority !== cur.priority) {
        this.db.prepare('UPDATE todos SET priority = ?, updated_at = ? WHERE id = ?').run(patch.priority, now, id);
        this.event(id, now, 'priority', actor, { from: cur.priority, to: patch.priority });
      }
      const title = patch.title?.trim();
      if (title && title !== cur.title) {
        this.db.prepare('UPDATE todos SET title = ?, updated_at = ? WHERE id = ?').run(title.slice(0, 200), now, id);
        this.event(id, now, 'title', actor, { from: cur.title, to: title });
      }
      const added = this.addTags(id, normalizeTags(patch.tagsAdd ?? []));
      if (added.length) this.event(id, now, 'tag_add', actor, { tags: added });
      const removed: string[] = [];
      for (const t of normalizeTags(patch.tagsRemove ?? [])) {
        const r = this.db.prepare(`DELETE FROM tags WHERE entity_kind = 'todo' AND entity_id = ? AND tag = ?`).run(id, t);
        if (r.changes) removed.push(t);
      }
      if (removed.length) this.event(id, now, 'tag_remove', actor, { tags: removed });
      if (patch.bodyAppend && patch.bodyAppend.trim()) {
        const text = patch.bodyAppend.slice(0, 20_000);
        this.db.prepare(
          `UPDATE todos SET body = CASE WHEN body IS NULL OR body = '' THEN ? ELSE body || char(10) || char(10) || ? END,
             updated_at = ? WHERE id = ?`
        ).run(text, text, now, id);
        this.event(id, now, 'body_append', actor, { text });
      }
      if (added.length || removed.length) this.db.prepare('UPDATE todos SET updated_at = ? WHERE id = ?').run(now, id);
      return this.get(id)!;
    })();
  }
}
