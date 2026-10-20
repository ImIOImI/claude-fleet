import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { InboxStore, INBOX_SCHEMA_VERSION } from './inboxDb.js';

const WS = { kind: 'workspace', id: 'W1' } as const;
const USER = { kind: 'user', id: null } as const;
let store: InboxStore;
afterEach(() => store?.close());

describe('InboxStore.post', () => {
  it('creates a todo with defaults and a created event', () => {
    store = InboxStore.memory();
    const { todo, action } = store.post(WS, { title: 'Disk full', tags: ['ops'] }, 1000);
    expect(action).toBe('created');
    expect(todo).toMatchObject({
      title: 'Disk full', status: 'open', priority: 'normal', source: WS, seenCount: 1,
      recurred: false, tags: ['ops'], createdAt: 1000, firstSeenAt: 1000, lastSeenAt: 1000, closedAt: null
    });
    expect(todo.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(store.events(todo.id).map((e) => e.kind)).toEqual(['created']);
  });

  it('dedupes by key per source: bumps seen, keeps max priority, unions tags, replaces body', () => {
    store = InboxStore.memory();
    const a = store.post(WS, { title: '5xx', key: 'k', priority: 'urgent', tags: ['ops'], body: 'one' }, 1000);
    const b = store.post(WS, { title: '5xx again', key: 'k', priority: 'low', tags: ['prod'], body: 'two' }, 2000);
    expect(b.action).toBe('updated');
    expect(b.todo.id).toBe(a.todo.id);
    expect(b.todo).toMatchObject({ seenCount: 2, priority: 'urgent', lastSeenAt: 2000, body: 'two', title: '5xx' });
    expect(b.todo.tags.sort()).toEqual(['ops', 'prod']);
    expect(store.events(a.todo.id).map((e) => e.kind)).toEqual(['created', 'seen']);
  });

  it('the same key from a different source is a different todo', () => {
    store = InboxStore.memory();
    const a = store.post(WS, { title: 'x', key: 'k' });
    const b = store.post({ kind: 'workspace', id: 'W2' }, { title: 'x', key: 'k' });
    expect(b.action).toBe('created');
    expect(b.todo.id).not.toBe(a.todo.id);
  });

  it('reopens a done or dismissed todo when its key recurs', () => {
    store = InboxStore.memory();
    const { todo } = store.post(WS, { title: 'x', key: 'k' }, 1000);
    store.update(USER, todo.id, { status: 'done' }, 1500);
    const r = store.post(WS, { title: 'x', key: 'k' }, 2000);
    expect(r.action).toBe('reopened');
    expect(r.todo).toMatchObject({ status: 'open', recurred: true, closedAt: null, seenCount: 2 });
    store.update(USER, todo.id, { status: 'dismissed' }, 2500);
    expect(store.post(WS, { title: 'x', key: 'k' }, 3000).action).toBe('reopened');
    expect(store.events(todo.id).map((e) => e.kind)).toEqual(['created', 'status', 'reopened', 'status', 'reopened']);
  });

  it('posts without a key never dedupe', () => {
    store = InboxStore.memory();
    store.post(WS, { title: 'x' });
    store.post(WS, { title: 'x' });
    expect(store.list()).toHaveLength(2);
  });
});

describe('InboxStore.update', () => {
  it('applies status, priority, title, tags and body append with events', () => {
    store = InboxStore.memory();
    const { todo } = store.post(WS, { title: 'x', tags: ['a'], body: 'hello' }, 1000);
    const u = store.update(USER, todo.id, {
      status: 'done', priority: 'high', title: 'y', tagsAdd: ['B'], tagsRemove: ['a'], bodyAppend: 'more'
    }, 2000);
    expect(u).toMatchObject({ status: 'done', priority: 'high', title: 'y', tags: ['b'], closedAt: 2000, body: 'hello\n\nmore' });
    expect(store.events(todo.id).map((e) => e.kind)).toEqual(
      ['created', 'status', 'priority', 'title', 'tag_add', 'tag_remove', 'body_append']
    );
    expect(store.update(USER, todo.id, { status: 'open' }, 3000).closedAt).toBeNull();
  });
  it('throws for an unknown id', () => {
    store = InboxStore.memory();
    expect(() => store.update(USER, 'nope', { status: 'done' })).toThrow(/not found/);
  });
});

describe('InboxStore.list / counts', () => {
  it('filters by status, tags and visibility; orders by priority then recency', () => {
    store = InboxStore.memory();
    store.post(WS, { title: 'low', priority: 'low', tags: ['ops'] }, 1);
    store.post(WS, { title: 'urgent', priority: 'urgent' }, 2);
    store.post({ kind: 'workspace', id: 'W2' }, { title: 'other', workspaceLink: 'W1' }, 3);
    store.post({ kind: 'workspace', id: 'W2' }, { title: 'hidden' }, 4);
    const done = store.post(USER, { title: 'done' }, 5).todo;
    store.update(USER, done.id, { status: 'done' });
    expect(store.list().map((t) => t.title)).toEqual(['urgent', 'hidden', 'other', 'low']);
    expect(store.list({ status: 'done' }).map((t) => t.title)).toEqual(['done']);
    expect(store.list({ status: 'all' })).toHaveLength(5);
    expect(store.list({ tags: ['ops'] }).map((t) => t.title)).toEqual(['low']);
    expect(store.list({ visibleTo: 'W1' }).map((t) => t.title).sort()).toEqual(['low', 'other', 'urgent']);
    expect(store.list({ limit: 1 })).toHaveLength(1);
    expect(store.counts()).toEqual({ open: 4, urgent: 1, high: 0 });
  });
});

describe('InboxStore.open', () => {
  it('creates inbox.db with WAL and the schema version', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inbox-'));
    store = InboxStore.open(dir);
    store.post(USER, { title: 'persist me' });
    store.close();
    store = InboxStore.open(dir);
    expect(store.list().map((t) => t.title)).toEqual(['persist me']);
    const raw = new Database(path.join(dir, 'inbox.db'), { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(INBOX_SCHEMA_VERSION);
    expect(INBOX_SCHEMA_VERSION).toBe(3);
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
