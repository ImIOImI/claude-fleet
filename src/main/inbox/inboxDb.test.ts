import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { InboxStore, INBOX_SCHEMA_VERSION, MIGRATIONS } from './inboxDb.js';

const WS = { kind: 'workspace', id: 'W1' } as const;
const USER = { kind: 'user', id: null } as const;
let store: InboxStore;
afterEach(async () => await store?.close());

/** Counts `better-sqlite3` statements prepared on a store's raw connection — one per Kysely query
 *  (see store/kysely.ts) — to assert a call makes a constant number of round trips, not N+1. */
function countQueries(s: InboxStore): { count(): number } {
  const raw = (s as unknown as { raw: Database.Database }).raw;
  let n = 0;
  const orig = raw.prepare.bind(raw);
  raw.prepare = ((sql: string) => { n++; return orig(sql); }) as typeof raw.prepare;
  return { count: () => n };
}

describe('InboxStore.post', () => {
  it('creates a todo with defaults and a created event', async () => {
    store = InboxStore.memory();
    const { todo, action } = await store.post(WS, { title: 'Disk full', tags: ['ops'] }, 1000);
    expect(action).toBe('created');
    expect(todo).toMatchObject({
      title: 'Disk full', status: 'open', priority: 'normal', source: WS, seenCount: 1,
      recurred: false, tags: ['ops'], createdAt: 1000, firstSeenAt: 1000, lastSeenAt: 1000, closedAt: null
    });
    expect(todo.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await store.events(todo.id)).map((e) => e.kind)).toEqual(['created']);
  });

  it('dedupes by key per source: bumps seen, keeps max priority, unions tags, replaces body', async () => {
    store = InboxStore.memory();
    const a = await store.post(WS, { title: '5xx', key: 'k', priority: 'urgent', tags: ['ops'], body: 'one' }, 1000);
    const b = await store.post(WS, { title: '5xx again', key: 'k', priority: 'low', tags: ['prod'], body: 'two' }, 2000);
    expect(b.action).toBe('updated');
    expect(b.todo.id).toBe(a.todo.id);
    expect(b.todo).toMatchObject({ seenCount: 2, priority: 'urgent', lastSeenAt: 2000, body: 'two', title: '5xx' });
    expect(b.todo.tags.sort()).toEqual(['ops', 'prod']);
    expect((await store.events(a.todo.id)).map((e) => e.kind)).toEqual(['created', 'seen']);
  });

  it('the same key from a different source is a different todo', async () => {
    store = InboxStore.memory();
    const a = await store.post(WS, { title: 'x', key: 'k' });
    const b = await store.post({ kind: 'workspace', id: 'W2' }, { title: 'x', key: 'k' });
    expect(b.action).toBe('created');
    expect(b.todo.id).not.toBe(a.todo.id);
  });

  it('reopens a done or dismissed todo when its key recurs', async () => {
    store = InboxStore.memory();
    const { todo } = await store.post(WS, { title: 'x', key: 'k' }, 1000);
    await store.update(USER, todo.id, { status: 'done' }, 1500);
    const r = await store.post(WS, { title: 'x', key: 'k' }, 2000);
    expect(r.action).toBe('reopened');
    expect(r.todo).toMatchObject({ status: 'open', recurred: true, closedAt: null, seenCount: 2 });
    await store.update(USER, todo.id, { status: 'dismissed' }, 2500);
    expect((await store.post(WS, { title: 'x', key: 'k' }, 3000)).action).toBe('reopened');
    expect((await store.events(todo.id)).map((e) => e.kind)).toEqual(['created', 'status', 'reopened', 'status', 'reopened']);
  });

  it('posts without a key never dedupe', async () => {
    store = InboxStore.memory();
    await store.post(WS, { title: 'x' });
    await store.post(WS, { title: 'x' });
    expect(await store.list()).toHaveLength(2);
  });
});

describe('InboxStore.post concurrency', () => {
  it('two concurrent posts with the same key make one todo (created + updated)', async () => {
    store = InboxStore.memory();
    const [a, b] = await Promise.all([
      store.post(WS, { title: 'x', key: 'k' }, 1000),
      store.post(WS, { title: 'x', key: 'k' }, 1001)
    ]);
    expect([a.action, b.action].sort()).toEqual(['created', 'updated']);
    expect(a.todo.id).toBe(b.todo.id);
    expect(await store.list({ status: 'all' })).toHaveLength(1);
  });
});

describe('InboxStore.update', () => {
  it('applies status, priority, title, tags and body append with events', async () => {
    store = InboxStore.memory();
    const { todo } = await store.post(WS, { title: 'x', tags: ['a'], body: 'hello' }, 1000);
    const u = await store.update(USER, todo.id, {
      status: 'done', priority: 'high', title: 'y', tagsAdd: ['B'], tagsRemove: ['a'], bodyAppend: 'more'
    }, 2000);
    expect(u).toMatchObject({ status: 'done', priority: 'high', title: 'y', tags: ['b'], closedAt: 2000, body: 'hello\n\nmore' });
    expect((await store.events(todo.id)).map((e) => e.kind)).toEqual(
      ['created', 'status', 'priority', 'title', 'tag_add', 'tag_remove', 'body_append']
    );
    expect((await store.update(USER, todo.id, { status: 'open' }, 3000)).closedAt).toBeNull();
  });
  it('throws for an unknown id', async () => {
    store = InboxStore.memory();
    await expect(store.update(USER, 'nope', { status: 'done' })).rejects.toThrow(/not found/);
  });
});

describe('InboxStore.list / counts', () => {
  it('filters by status, tags and visibility; orders by priority then recency', async () => {
    store = InboxStore.memory();
    await store.post(WS, { title: 'low', priority: 'low', tags: ['ops'] }, 1);
    await store.post(WS, { title: 'urgent', priority: 'urgent' }, 2);
    await store.post({ kind: 'workspace', id: 'W2' }, { title: 'other', workspaceLink: 'W1' }, 3);
    await store.post({ kind: 'workspace', id: 'W2' }, { title: 'hidden' }, 4);
    const done = (await store.post(USER, { title: 'done' }, 5)).todo;
    await store.update(USER, done.id, { status: 'done' });
    expect((await store.list()).map((t) => t.title)).toEqual(['urgent', 'hidden', 'other', 'low']);
    expect((await store.list({ status: 'done' })).map((t) => t.title)).toEqual(['done']);
    expect(await store.list({ status: 'all' })).toHaveLength(5);
    expect((await store.list({ tags: ['ops'] })).map((t) => t.title)).toEqual(['low']);
    expect((await store.list({ visibleTo: 'W1' })).map((t) => t.title).sort()).toEqual(['low', 'other', 'urgent']);
    expect(await store.list({ limit: 1 })).toHaveLength(1);
    expect(await store.counts()).toEqual({ open: 4, urgent: 1, high: 0, approvals: 0 });
  });
});

describe('InboxStore.list batches tags (#456)', () => {
  it('returns identical tags/ordering to per-todo fetches, in a constant number of queries', async () => {
    store = InboxStore.memory();
    // Seed enough todos, with varied tag counts (including none), that an N+1 loop would show up
    // as a growing query count against a flat batched one.
    const titles = Array.from({ length: 40 }, (_, i) => `todo-${i}`);
    for (const [i, title] of titles.entries()) {
      const tags = i % 5 === 0 ? [] : [`tag-${i % 5}`, `tag-${i % 3}`, 'shared'];
      await store.post(WS, { title, tags, priority: i % 7 === 0 ? 'urgent' : 'normal' }, 1000 + i);
    }
    const counter = countQueries(store);
    const rows = await store.list({ status: 'all', limit: 500 });
    const queriesFor40 = counter.count();
    expect(rows).toHaveLength(40);
    // Cross-check every row's tags against the single-todo path (`get`), which still queries per id.
    for (const row of rows) {
      const solo = await store.get(row.id);
      expect(row.tags).toEqual(solo!.tags);
    }
    // A handful more todos should not grow the query count for list() itself.
    for (let i = 0; i < 10; i++) await store.post(WS, { title: `extra-${i}`, tags: ['x', 'y'] }, 5000 + i);
    const counter2 = countQueries(store);
    await store.list({ status: 'all', limit: 500 });
    expect(counter2.count()).toBe(queriesFor40);
    expect(queriesFor40).toBeLessThanOrEqual(3);
  });
});

describe('InboxStore.open', () => {
  it('creates inbox.db with WAL and the schema version', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    store = InboxStore.open(dir);
    await store.post(USER, { title: 'persist me' });
    await store.close();
    store = InboxStore.open(dir);
    expect((await store.list()).map((t) => t.title)).toEqual(['persist me']);
    const raw = new Database(path.join(dir, 'inbox.db'), { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(INBOX_SCHEMA_VERSION);
    expect(INBOX_SCHEMA_VERSION).toBe(8);
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    raw.close();
  });
  it('v6 creates the claims tables and an FTS5 index', () => {
    store = InboxStore.memory();
    const raw = (store as unknown as { raw: import('better-sqlite3').Database }).raw;
    const names = (raw.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['claims', 'claim_sources', 'claim_vectors', 'claims_fts', 'capture_runs']));
    raw.prepare(`INSERT INTO claims_fts (claim_id, text, topics) VALUES ('c1', 'query snapshot froze the app', 'mcp-query')`).run();
    const hit = raw.prepare(`SELECT claim_id FROM claims_fts WHERE claims_fts MATCH '"snapshot"'`).get() as { claim_id: string };
    expect(hit.claim_id).toBe('c1');
    store.close();
  });
  it('v7 adds capture_settings_log, proposals.payload and capture_runs.user_turns', () => {
    store = InboxStore.memory();
    const raw = (store as unknown as { raw: import('better-sqlite3').Database }).raw;
    const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('capture_settings_log')).toEqual(['id', 'workspace_id', 'ts', 'actor', 'before', 'after', 'reason', 'applied', 'proposal_id']);
    expect(cols('proposals')).toContain('payload');
    expect(cols('capture_runs')).toContain('user_turns');
    // The rebuilt proposals table admits the new kind and still rejects junk.
    const ins = (kind: string) => raw.prepare(`INSERT INTO proposals (id, kind, proposer_kind, status, items, created_at) VALUES (?, ?, 'workspace', 'pending', '[]', 1)`).run(`p-${kind}`, kind);
    expect(() => ins('capture-settings')).not.toThrow();
    expect(() => ins('bogus')).toThrow(/CHECK constraint/);
    expect(raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'proposals_status'`).get()).toBeTruthy();
    store.close();
  });
  it('v6 → v7 rebuilds proposals without losing a row, and adds the new v7 objects', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inbox-v6v7-'));
    const file = path.join(dir, 'inbox.db');
    const raw = new Database(file);
    for (let v = 1; v <= 6; v++) {
      raw.transaction(() => {
        raw.exec(MIGRATIONS[v]);
        raw.pragma(`user_version = ${v}`);
      })();
    }
    const insProposal = raw.prepare(
      `INSERT INTO proposals (id, kind, proposer_kind, proposer_id, rationale, status, items, note, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // All optional columns NULL.
    insProposal.run('P-new', 'new', 'workspace', null, null, 'pending', '[]', null, 1000, null);
    // All optional columns non-NULL, including a unicode rationale.
    insProposal.run('P-change', 'change', 'user', 'U1', 'café ☕ 更新 — widen the kind CHECK', 'approved', '[{"a":1}]', 'noted', 2000, 2500);
    insProposal.run('P-batch', 'batch', 'workspace', 'W9', null, 'rejected', '[{"b":2},{"c":3}]', 'no thanks', 3000, 3100);
    raw.prepare(
      `INSERT INTO capture_runs (id, workspace_id, session_id, fork_session_id, trigger, status, claims_recorded, usage, error, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('R1', 'W1', 'S1', 'F1', 'ctx-85', 'done', 2, JSON.stringify({ in: 1, out: 2 }), null, 500, 600);
    const before = raw.prepare(
      `SELECT id, kind, proposer_kind, proposer_id, rationale, status, items, note, created_at, decided_at FROM proposals ORDER BY id`
    ).all() as Array<Record<string, unknown>>;
    raw.close();

    store = InboxStore.open(dir);
    const rawHandle = (store as unknown as { raw: import('better-sqlite3').Database }).raw;

    expect(rawHandle.pragma('user_version', { simple: true })).toBe(INBOX_SCHEMA_VERSION);
    expect(rawHandle.pragma('integrity_check', { simple: true })).toBe('ok');

    const after = rawHandle.prepare(
      `SELECT id, kind, proposer_kind, proposer_id, rationale, status, items, note, created_at, decided_at, payload FROM proposals ORDER BY id`
    ).all() as Array<Record<string, unknown>>;
    expect(after.map(({ payload: _payload, ...rest }) => rest)).toEqual(before);
    expect(after.every((r) => r.payload === null)).toBe(true);

    expect(rawHandle.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'proposals_status'`).get()).toBeTruthy();
    const insKind = (kind: string) => rawHandle.prepare(
      `INSERT INTO proposals (id, kind, proposer_kind, status, items, created_at) VALUES (?, ?, 'workspace', 'pending', '[]', 1)`
    ).run(`chk-${kind}`, kind);
    expect(() => insKind('capture-settings')).not.toThrow();
    expect(() => insKind('bogus')).toThrow(/CHECK constraint/);

    const run = rawHandle.prepare(`SELECT * FROM capture_runs WHERE id = 'R1'`).get() as Record<string, unknown>;
    expect(run).toMatchObject({
      id: 'R1', workspace_id: 'W1', session_id: 'S1', fork_session_id: 'F1', trigger: 'ctx-85',
      status: 'done', started_at: 500, ended_at: 600, user_turns: null, visibility: null, compactions: null
    });

    expect(rawHandle.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capture_settings_log'`).get()).toBeTruthy();
    expect(readdirSync(dir).some((f) => /^inbox\.db\.bak-v6-\d+$/.test(f))).toBe(true);
  });

  it('backs up an existing older database before migrating', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    const old = new Database(path.join(dir, 'inbox.db'));
    old.exec('CREATE TABLE legacy (x)');
    old.close();
    store = InboxStore.open(dir);
    expect(readdirSync(dir).some((f) => /^inbox\.db\.bak-v0-\d+$/.test(f))).toBe(true);
  });
  it('does not back up a brand-new database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    store = InboxStore.open(dir);
    expect(readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(false);
    writeFileSync(path.join(dir, 'unused'), '');
  });
});

describe('InboxStore.kysely', () => {
  it('exposes a Kysely handle over the same connection, and close() closes it', async () => {
    store = InboxStore.memory();
    const { todo } = await store.post(WS, { title: 'via raw' }, 1000);
    const rows = await store.kysely.selectFrom('todos').select(['id', 'title']).execute();
    expect(rows).toEqual([{ id: todo.id, title: 'via raw' }]);
    await store.close();
    await expect(store.kysely.selectFrom('todos').selectAll().execute()).rejects.toThrow();
    store = InboxStore.memory(); // afterEach closes a live store
  });
});

describe('InboxStore chunked tag fetching', () => {
  it('correctly merges tags across the 500-item chunk boundary', async () => {
    store = InboxStore.memory();
    // Seed 501 todos, each with a distinct tag
    const todoIds: string[] = [];
    for (let i = 0; i < 501; i++) {
      const { todo } = await store.post(WS, { title: `todo-${i}`, tags: [`tag-${i}`] }, 1000 + i);
      todoIds.push(todo.id);
    }
    // Add one todo with no tags
    const { todo: noTagTodo } = await store.post(WS, { title: 'no-tags' }, 1500);
    todoIds.push(noTagTodo.id);

    // List all todos with their tags (bypasses pagination)
    const todos = await store.list({ status: 'all', limit: 500 });
    expect(todos).toHaveLength(500); // list caps at 500

    // Verify that the first 500 todos returned have exactly their own tag
    for (let i = 0; i < Math.min(500, todos.length); i++) {
      // The todos are returned in reverse order (by last_seen_at desc), so we need to find our todos
      const todo = todos.find((t) => t.title === `todo-${i}`);
      if (todo) {
        expect(todo.tags).toEqual([`tag-${i}`]);
      }
    }

    // Additionally, test tagsForIds directly to verify 501 boundary
    const allTodoIds = [noTagTodo.id, ...todoIds.slice(0, 501)];
    const tagsMap = await (store as any).tagsForIds((store as any).kysely, allTodoIds);
    for (let i = 0; i < 501; i++) {
      const expectedTag = i < 501 ? [`tag-${i}`] : [];
      const actualTag = tagsMap.get(todoIds[i]) ?? [];
      expect(actualTag).toEqual(expectedTag);
    }
    // Verify the no-tags todo
    expect(tagsMap.get(noTagTodo.id) ?? []).toEqual([]);
  });
});
