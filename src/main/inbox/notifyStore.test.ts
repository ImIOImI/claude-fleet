import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { InboxStore } from './inboxDb.js';
import { NotifyStore, type NewNotification } from './notifyStore.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());

const req = (over: Partial<NewNotification> = {}): NewNotification => ({
  ts: 1000, kind: 'post', title: 'Disk full', body: null, priority: 'normal',
  source: { kind: 'workspace', id: 'W1' }, todoId: null, workspaceId: 'W1', dedupeKey: null, tags: [],
  delivered: true, heldReason: null, channel: 'in-app', ...over
});

describe('NotifyStore notifications', () => {
  it('inserts and lists newest first, filtered by delivered / held', () => {
    inbox = InboxStore.memory();
    const s = new NotifyStore(inbox.db);
    s.insert(req({ ts: 1, title: 'a' }));
    s.insert(req({ ts: 2, title: 'b', delivered: false, heldReason: 'pause', channel: null, tags: ['ops'] }));
    expect(s.list().map((n) => n.title)).toEqual(['b', 'a']);
    expect(s.list({ filter: 'held' })).toEqual([expect.objectContaining({ title: 'b', heldReason: 'pause', tags: ['ops'] })]);
    expect(s.list({ filter: 'delivered' }).map((n) => n.title)).toEqual(['a']);
  });
  it('clears by dedupe key, tracks held-since and digested, prunes old rows', () => {
    inbox = InboxStore.memory();
    const s = new NotifyStore(inbox.db);
    const a = s.insert(req({ ts: 10, dedupeKey: 'input-wait:W1', kind: 'input-wait' }));
    s.insert(req({ ts: 20, delivered: false, heldReason: 'pause', channel: null }));
    s.insert(req({ ts: 30, delivered: false, heldReason: 'downtime:D1', channel: null }));
    s.insert(req({ ts: 40, delivered: false, heldReason: 'rule:R1', channel: null }));
    expect(s.clearByKey('input-wait:W1', 50)).toEqual([a.id]);
    expect(s.get(a.id)?.clearedAt).toBe(50);
    const held = s.heldQuietSince(15);
    expect(held.map((n) => n.ts)).toEqual([20, 30]);
    s.markDigested(held.map((n) => n.id));
    expect(s.heldQuietSince(15)).toEqual([]);
    expect(s.prune(25)).toBe(2);
    expect(s.list().map((n) => n.ts)).toEqual([40, 30]);
  });
});

describe('NotifyStore rules, downtimes, state', () => {
  it('upserts a rule by scope and removes it', () => {
    inbox = InboxStore.memory();
    const s = new NotifyStore(inbox.db);
    const r1 = s.setRule({ scopeKind: 'source', scopeValue: 'workspace:W1', level: 'urgent', snoozeUntil: null }, 1);
    const r2 = s.setRule({ scopeKind: 'source', scopeValue: 'workspace:W1', level: 'off', snoozeUntil: 99 }, 2);
    expect(r2.id).toBe(r1.id);
    expect(s.rules()).toEqual([{ id: r1.id, scopeKind: 'source', scopeValue: 'workspace:W1', level: 'off', snoozeUntil: 99 }]);
    s.removeRule(r1.id);
    expect(s.rules()).toEqual([]);
  });
  it('saves, updates and removes downtimes with a day mask round-trip', () => {
    inbox = InboxStore.memory();
    const s = new NotifyStore(inbox.db);
    const d = s.saveDowntime({ name: 'Nights', enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startMin: 1320, endMin: 420, bypass: 'none' }, 1);
    expect(s.downtimes()).toEqual([{ ...d }]);
    s.saveDowntime({ ...d, days: [5, 6], enabled: false }, 2);
    expect(s.downtimes()[0]).toMatchObject({ id: d.id, days: [5, 6], enabled: false });
    s.removeDowntime(d.id);
    expect(s.downtimes()).toEqual([]);
  });
  it('stores pause and default level', () => {
    inbox = InboxStore.memory();
    const s = new NotifyStore(inbox.db);
    expect(s.getPause()).toBeNull();
    expect(s.getDefaultLevel()).toBe('all');
    s.setPause({ until: null, letUrgent: true, setAt: 5 });
    expect(s.getPause()).toEqual({ until: null, letUrgent: true, setAt: 5 });
    s.clearPause();
    expect(s.getPause()).toBeNull();
    s.setDefaultLevel('high');
    expect(s.getDefaultLevel()).toBe('high');
  });
});

describe('schema v1 → v2 migration', () => {
  it('backs up a v1 file and keeps its todos', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inbox-mig-'));
    const v1 = new Database(path.join(dir, 'inbox.db'));
    v1.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL, priority TEXT NOT NULL,
      source_kind TEXT NOT NULL, source_id TEXT, source_run_id TEXT, via_workspace TEXT, dedupe_key TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1, recurred INTEGER NOT NULL DEFAULT 0, workspace_id TEXT, session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, closed_at INTEGER);
      CREATE TABLE tags (entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (entity_kind, entity_id, tag));
      CREATE TABLE todo_events (id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
        actor_kind TEXT NOT NULL, actor_id TEXT, run_id TEXT, detail TEXT);
      INSERT INTO todos VALUES ('T1','kept',NULL,'open','normal','user',NULL,NULL,NULL,NULL,1,0,NULL,NULL,1,1,1,1,NULL);
      PRAGMA user_version = 1;`);
    v1.close();
    inbox = InboxStore.open(dir);
    expect(inbox.list().map((t) => t.title)).toEqual(['kept']);
    expect(readdirSync(dir).some((f) => /^inbox\.db\.bak-v1-\d+$/.test(f))).toBe(true);
    expect(new NotifyStore(inbox.db).rules()).toEqual([]);
  });
});
