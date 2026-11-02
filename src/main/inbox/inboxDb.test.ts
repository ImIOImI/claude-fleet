import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { InboxStore, INBOX_SCHEMA_VERSION } from './inboxDb.js';

const WS = { kind: 'workspace', id: 'W1' } as const;
const USER = { kind: 'user', id: null } as const;
let store: InboxStore;
afterEach(async () => await store?.close());

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
    expect(INBOX_SCHEMA_VERSION).toBe(5);
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    raw.close();
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
