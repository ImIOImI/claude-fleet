import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { InboxStore } from './inboxDb.js';
import { NotifyStore, REMOTE_CURSOR_IDS, type NewNotification } from './notifyStore.js';
import { CURSOR_IDS } from '../federation/remoteNotices.js';
import { openTestInbox, isPg } from '../store/testStore.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());

const req = (over: Partial<NewNotification> = {}): NewNotification => ({
  ts: 1000, kind: 'post', title: 'Disk full', body: null, priority: 'normal',
  source: { kind: 'workspace', id: 'W1' }, todoId: null, workspaceId: 'W1', dedupeKey: null, tags: [],
  delivered: true, heldReason: null, channel: 'in-app', ...over
});

describe('NotifyStore notifications', () => {
  it('inserts and lists newest first, filtered by delivered / held', async () => {
    inbox = (await openTestInbox());
    const s = new NotifyStore(inbox.kysely);
    await s.insert(req({ ts: 1, title: 'a' }));
    await s.insert(req({ ts: 2, title: 'b', delivered: false, heldReason: 'pause', channel: null, tags: ['ops'] }));
    expect((await s.list()).map((n) => n.title)).toEqual(['b', 'a']);
    expect(await s.list({ filter: 'held' })).toEqual([expect.objectContaining({ title: 'b', heldReason: 'pause', tags: ['ops'] })]);
    expect((await s.list({ filter: 'delivered' })).map((n) => n.title)).toEqual(['a']);
  });
  it('since: oldest first from ts inclusive, capped, optionally one workspace', async () => {
    inbox = (await openTestInbox());
    const s = new NotifyStore(inbox.kysely);
    for (const [ts, ws] of [[1, 'W1'], [2, 'W2'], [3, 'W1'], [3, 'W1'], [4, 'W1']] as const) await s.insert(req({ ts, workspaceId: ws, title: `${ts}${ws}` }));
    expect((await s.since(2, 100)).map((n) => n.title)).toEqual(['2W2', '3W1', '3W1', '4W1']);
    expect((await s.since(2, 2, 'W1')).map((n) => n.ts)).toEqual([3, 3]);
    expect((await s.since(0, 100, 'W1')).every((n) => n.workspaceId === 'W1')).toBe(true);
    expect((await s.list({ workspaceId: 'W2' })).map((n) => n.title)).toEqual(['2W2']);
  });
  it('clears by dedupe key, tracks held-since and digested, prunes old rows', async () => {
    inbox = (await openTestInbox());
    const s = new NotifyStore(inbox.kysely);
    const a = await s.insert(req({ ts: 10, dedupeKey: 'input-wait:W1', kind: 'input-wait' }));
    await s.insert(req({ ts: 20, delivered: false, heldReason: 'pause', channel: null }));
    await s.insert(req({ ts: 30, delivered: false, heldReason: 'downtime:D1', channel: null }));
    await s.insert(req({ ts: 40, delivered: false, heldReason: 'rule:R1', channel: null }));
    expect(await s.clearByKey('input-wait:W1', 50)).toEqual([a.id]);
    expect((await s.get(a.id))?.clearedAt).toBe(50);
    const held = await s.heldQuietSince(15);
    expect(held.map((n) => n.ts)).toEqual([20, 30]);
    await s.markDigested(held.map((n) => n.id));
    expect(await s.heldQuietSince(15)).toEqual([]);
    expect(await s.prune(25)).toBe(2);
    expect((await s.list()).map((n) => n.ts)).toEqual([40, 30]);
  });
});

describe('NotifyStore rules, downtimes, state', () => {
  it('upserts a rule by scope and removes it', async () => {
    inbox = (await openTestInbox());
    const s = new NotifyStore(inbox.kysely);
    const r1 = await s.setRule({ scopeKind: 'source', scopeValue: 'workspace:W1', level: 'urgent', snoozeUntil: null }, 1);
    const r2 = await s.setRule({ scopeKind: 'source', scopeValue: 'workspace:W1', level: 'off', snoozeUntil: 99 }, 2);
    expect(r2.id).toBe(r1.id);
    expect(await s.rules()).toEqual([{ id: r1.id, scopeKind: 'source', scopeValue: 'workspace:W1', level: 'off', snoozeUntil: 99 }]);
    await s.removeRule(r1.id);
    expect(await s.rules()).toEqual([]);
  });
  it('saves, updates and removes downtimes with a day mask round-trip', async () => {
    inbox = (await openTestInbox());
    const s = new NotifyStore(inbox.kysely);
    const d = await s.saveDowntime({ name: 'Nights', enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startMin: 1320, endMin: 420, bypass: 'none' }, 1);
    expect(await s.downtimes()).toEqual([{ ...d }]);
    await s.saveDowntime({ ...d, days: [5, 6], enabled: false }, 2);
    expect((await s.downtimes())[0]).toMatchObject({ id: d.id, days: [5, 6], enabled: false });
    await s.removeDowntime(d.id);
    expect(await s.downtimes()).toEqual([]);
  });
  it('stores pause and default level', async () => {
    inbox = (await openTestInbox());
    const s = new NotifyStore(inbox.kysely);
    expect(await s.getPause()).toBeNull();
    expect(await s.getDefaultLevel()).toBe('all');
    await s.setPause({ until: null, letUrgent: true, setAt: 5 });
    expect(await s.getPause()).toEqual({ until: null, letUrgent: true, setAt: 5 });
    await s.clearPause();
    expect(await s.getPause()).toBeNull();
    await s.setDefaultLevel('high');
    expect(await s.getDefaultLevel()).toBe('high');
  });
});

describe.skipIf(isPg)('schema v1 → v2 migration', () => {
  it('backs up a v1 file and keeps its todos', async () => {
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
    expect((await inbox.list()).map((t) => t.title)).toEqual(['kept']);
    expect(readdirSync(dir).some((f) => /^inbox\.db\.bak-v1-\d+$/.test(f))).toBe(true);
    expect(await new NotifyStore(inbox.kysely).rules()).toEqual([]);
  });
});

describe('NotifyStore remote notice cursors (D132, D133)', () => {
  it('keeps one cursor per remote origin and forgets an origin with its rows, leaving the others', async () => {
    inbox = (await openTestInbox());
    const s = new NotifyStore(inbox.kysely);
    await s.setRemoteCursor('W1', { ts: 5, id: 'a', ids: ['a'], floor: { ts: 2, id: 'z' } });
    await s.setRemoteCursor('W2', { ts: 7, id: '', ids: [], floor: null });
    await s.insert(req({ ts: 1, workspaceId: 'W1', source: { kind: 'workspace', id: 'W1' } }));
    await s.insert(req({ ts: 2, title: 'other', workspaceId: 'W2', source: { kind: 'workspace', id: 'W2' } }));
    expect(await s.getRemoteCursor('W1')).toEqual({ ts: 5, id: 'a', ids: ['a'], floor: { ts: 2, id: 'z' } });
    expect((await s.remoteCursorOrigins()).sort()).toEqual(['W1', 'W2']);
    await s.forgetOrigin('W1');
    expect(await s.getRemoteCursor('W1')).toBeNull();
    expect(await s.remoteCursorOrigins()).toEqual(['W2']);
    expect((await s.list()).map((n) => n.title)).toEqual(['other']);
    expect(await s.getRemoteCursor('W2')).toEqual({ ts: 7, id: '', ids: [], floor: null });
  });

  it(`keeps the newest ${REMOTE_CURSOR_IDS} ids (the notifier's CURSOR_IDS) and reads a malformed cursor as none`, async () => {
    expect(REMOTE_CURSOR_IDS).toBe(CURSOR_IDS);
    inbox = (await openTestInbox());
    const s = new NotifyStore(inbox.kysely);
    const ids = Array.from({ length: REMOTE_CURSOR_IDS + 5 }, (_, i) => `i${i}`);
    await s.setRemoteCursor('W1', { ts: 9, id: 'i0', ids, floor: null });
    expect((await s.getRemoteCursor('W1'))!.ids).toEqual(ids.slice(5));
    await inbox.kysely.updateTable('notify_state').set({ v: '{"ts":9,"ids":[]}' }).where('k', '=', 'remote-notices:W1').execute();
    expect(await s.getRemoteCursor('W1')).toBeNull();
  });
});
