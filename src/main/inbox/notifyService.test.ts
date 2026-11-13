import { describe, it, expect, afterEach } from 'vitest';
import { InboxStore } from './inboxDb.js';
import { NotifyStore } from './notifyStore.js';
import { createNotifyService, INPUT_WAIT_DELAY_MS, todoNoticeInput } from './notifyService.js';
import { remoteNoticeInput } from '../federation/remoteNotices.js';
import type { NotificationRow } from '../../preload/inboxTypes.js';
import { openTestInbox, countQueries, settle } from '../store/testStore.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());

async function setup(opts: { focused?: boolean; viewing?: string | null; inboxOpen?: boolean } = {}) {
  inbox = await openTestInbox();
  const thisInbox = inbox;
  const store = new NotifyStore(thisInbox.kysely);
  let t = new Date(2026, 9, 19, 10, 0).getTime(); // Monday 10:00 local
  const delivered: NotificationRow[] = [];
  const timers: Array<{ fn: () => void; at: number; dead: boolean }> = [];
  const view = { focused: opts.focused ?? false, workspaceId: opts.viewing ?? null, inboxOpen: opts.inboxOpen ?? false };
  const svc = createNotifyService({
    store,
    now: () => t,
    deliver: (n) => { delivered.push(n); return view.focused ? 'in-app' : 'os'; },
    name: (id) => ({ W1: 'ops-oncall', W2: 'webex-triage' })[id] ?? id,
    viewing: () => view,
    changed: () => {},
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, dead: false }; timers.push(h); return h; },
    clearTimer: (h) => { (h as { dead: boolean }).dead = true; }
  });
  const advance = async (ms: number) => {
    t += ms;
    for (const h of timers) if (!h.dead && h.at <= t) { h.dead = true; h.fn(); }
    await settle(thisInbox);
  };
  return { store, svc, delivered, advance, view, at: () => t };
}

const todo = (over: Record<string, unknown> = {}) => ({
  id: 'T1', title: 'prod-api 5xx', body: null, status: 'open' as const, priority: 'normal' as const,
  source: { kind: 'workspace' as const, id: 'W1' }, sourceRunId: null, viaWorkspace: null, dedupeKey: 'k',
  seenCount: 1, recurred: false, workspaceId: 'W1', sessionId: null, tags: ['ops'], createdAt: 0, updatedAt: 0,
  firstSeenAt: 0, lastSeenAt: 0, closedAt: null, ...over
});

describe('request + delivery', () => {
  it('delivers and records the channel; holds by rule with the reason', async () => {
    const { store, svc, delivered } = await setup();
    const a = await svc.request({ kind: 'post', title: 'hi', priority: 'normal', source: { kind: 'workspace', id: 'W1' } });
    expect(a).toMatchObject({ delivered: true, channel: 'os' });
    expect((await store.get(a.id))?.channel).toBe('os');
    const r = await store.setRule({ scopeKind: 'source', scopeValue: 'workspace:W1', level: 'off', snoozeUntil: null });
    const b = await svc.request({ kind: 'post', title: 'muted', priority: 'urgent', source: { kind: 'workspace', id: 'W1' } });
    expect(b).toMatchObject({ delivered: false, heldReason: `rule:${r.id}`, channel: null });
    expect(delivered.map((n) => n.title)).toEqual(['hi']);
  });
});

describe('forceHold', () => {
  it('forceHold records the notification held with that reason, whatever the rules say', async () => {
    const { svc, delivered } = await setup();
    const row = await svc.request({ kind: 'post', title: 'x', priority: 'urgent', source: { kind: 'workspace', id: 'W' }, forceHold: 'remote-rate' });
    expect(row).toMatchObject({ delivered: false, heldReason: 'remote-rate' });
    expect(delivered).toEqual([]);
  });
});

describe('todoNoticeInput', () => {
  it('is null unless asked or an urgent arrival; titles and bodies like the desktop', () => {
    expect(todoNoticeInput(todo() as never, 'created', false, 'ops')).toBeNull();
    expect(todoNoticeInput(todo({ priority: 'urgent' }) as never, 'updated', false, 'ops')).toBeNull();
    expect(todoNoticeInput(todo({ seenCount: 3 }) as never, 'reopened', true, 'ops')).toMatchObject({ kind: 'todo', title: 'prod-api 5xx', body: 'ops · seen 3× · reopened', todoId: 'T1', dedupeKey: 'k' });
    expect(todoNoticeInput(todo({ priority: 'urgent' }) as never, 'created', false, 'ops')).toMatchObject({ title: 'Urgent · prod-api 5xx', priority: 'urgent' });
  });
});

describe('onTodoPosted', () => {
  it('notifies on request, or when a todo arrives urgent; not on a plain dedupe update', async () => {
    const { svc } = await setup();
    expect(await svc.onTodoPosted(todo(), 'created', false)).toBeNull();
    expect(await svc.onTodoPosted(todo(), 'created', true)).toMatchObject({ kind: 'todo', title: 'prod-api 5xx', body: 'ops-oncall' });
    expect(await svc.onTodoPosted(todo({ priority: 'urgent', seenCount: 3 }), 'reopened', false))
      .toMatchObject({ title: 'Urgent · prod-api 5xx', body: 'ops-oncall · seen 3× · reopened', priority: 'urgent' });
    expect(await svc.onTodoPosted(todo({ priority: 'urgent' }), 'updated', false)).toBeNull();
  });
});

describe('onPostRejected', () => {
  it('tells the user once per workspace per hour', async () => {
    const { svc, advance } = await setup();
    expect((await svc.onPostRejected('W1', 'post limit 2/hour'))?.title).toBe('ops-oncall hit its post limit');
    expect(await svc.onPostRejected('W1', 'post limit 2/hour')).toBeNull();
    expect((await svc.onPostRejected('W2', 'posting disabled'))?.title).toBe('webex-triage tried to post, but posting is off');
    await advance(3_600_001);
    expect(await svc.onPostRejected('W1', 'post limit 2/hour')).not.toBeNull();
  });
});

describe('onInputWait', () => {
  it('notifies after the delay when the user is not looking, once per episode, and clears when answered', async () => {
    const { store, svc, delivered, advance } = await setup();
    await svc.onInputWait('W2', ['s1']);
    await svc.onInputWait('W2', ['s1', 's2']);
    await advance(INPUT_WAIT_DELAY_MS - 1);
    expect(delivered).toHaveLength(0);
    await advance(1);
    expect(delivered.map((n) => n.title)).toEqual(['webex-triage needs your input']);
    expect(svc.waitingWorkspaces()).toEqual(['W2']);
    await svc.onInputWait('W2', []);
    expect((await store.list())[0].clearedAt).not.toBeNull();
    expect(svc.waitingWorkspaces()).toEqual([]);
  });
  it('skips the notification when answered quickly or when the user is viewing that workspace', async () => {
    const a = await setup();
    await a.svc.onInputWait('W2', ['s1']);
    await a.advance(5_000);
    await a.svc.onInputWait('W2', []);
    await a.advance(INPUT_WAIT_DELAY_MS);
    expect(a.delivered).toHaveLength(0);
    const b = await setup({ focused: true, viewing: 'W2' });
    await b.svc.onInputWait('W2', ['s1']);
    await b.advance(INPUT_WAIT_DELAY_MS);
    expect(b.delivered).toHaveLength(0);
    const c = await setup({ focused: true, viewing: 'W2', inboxOpen: true });
    await c.svc.onInputWait('W2', ['s1']);
    await c.advance(INPUT_WAIT_DELAY_MS);
    expect(c.delivered).toHaveLength(1);
  });
});

describe('cancelPending (#457 quit)', () => {
  it('cancels a pending input-wait timer so it never fires, touching no store', async () => {
    const { svc, delivered, advance } = await setup();
    await svc.onInputWait('W2', ['s1']);
    svc.cancelPending();
    await advance(INPUT_WAIT_DELAY_MS);
    expect(delivered).toHaveLength(0);
    expect(svc.waitingWorkspaces()).toEqual([]);
  });
  it('is safe to call twice, and safe with nothing pending', async () => {
    const { svc, delivered, advance } = await setup();
    expect(() => svc.cancelPending()).not.toThrow();
    await svc.onInputWait('W2', ['s1']);
    svc.cancelPending();
    expect(() => svc.cancelPending()).not.toThrow();
    await advance(INPUT_WAIT_DELAY_MS);
    expect(delivered).toHaveLength(0);
  });
});

describe('quiet periods and the digest', () => {
  it('holds during a pause, then sends one digest when it ends', async () => {
    const { store, svc, delivered, advance, at } = await setup();
    await store.setPause({ until: at() + 3_600_000, letUrgent: true, setAt: at() });
    await svc.tick();
    await svc.onTodoPosted(todo(), 'created', true);
    await svc.request({ kind: 'post', title: 'p', priority: 'normal', source: { kind: 'workspace', id: 'W1' } });
    await svc.onTodoPosted(todo({ priority: 'urgent', id: 'T2' }), 'created', false); // urgent gets through
    expect(await svc.quietState()).toMatchObject({ heldSinceQuiet: 2 });
    expect(delivered.map((n) => n.title)).toEqual(['Urgent · prod-api 5xx']);
    await advance(3_600_001);
    const digest = await svc.tick();
    expect(digest).toMatchObject({ kind: 'digest', title: 'Notifications resumed: 2 held', body: '1 todo (none urgent) · 1 other', delivered: true });
    expect(await store.getPause()).toBeNull();
    expect(await svc.tick()).toBeNull();
  });
  it('a downtime with nothing held ends without a digest; quietState reports the next downtime', async () => {
    const { store, svc, advance } = await setup();
    const d = await store.saveDowntime({ name: 'Lunch', enabled: true, days: [0], startMin: 10 * 60, endMin: 11 * 60, bypass: 'none' });
    await svc.tick();
    expect((await svc.quietState()).activeDowntime?.id).toBe(d.id);
    await advance(3_600_000);
    expect(await svc.tick()).toBeNull();
    expect(await svc.quietState()).toMatchObject({ activeDowntime: null, nextDowntime: { downtime: { id: d.id } } });
  });
});

describe('scopes, effective rule, test, prune', () => {
  it('offers key / source / first tag scopes with labels', async () => {
    const { svc, store } = await setup();
    expect(svc.scopesFor({ source: { kind: 'workspace', id: 'W1' }, dedupeKey: 'k', tags: ['ops', 'prod'] })).toEqual([
      { scopeKind: 'key', scopeValue: 'workspace:W1:k', label: 'This item' },
      { scopeKind: 'source', scopeValue: 'workspace:W1', label: 'ops-oncall' },
      { scopeKind: 'tag', scopeValue: 'ops', label: '#ops' }
    ]);
    await store.setRule({ scopeKind: 'tag', scopeValue: 'ops', level: 'urgent', snoozeUntil: null });
    expect((await svc.effectiveFor({ priority: 'normal', source: { kind: 'user', id: null }, dedupeKey: null, tags: ['ops'] })).level).toBe('urgent');
  });
  it('test bypasses quiet; prune drops rows older than 30 days', async () => {
    const { store, svc, advance, at } = await setup();
    await store.setPause({ until: null, letUrgent: false, setAt: at() });
    expect((await svc.test()).delivered).toBe(true);
    await advance(31 * 86_400_000);
    expect(await svc.prune()).toBe(1);
  });
});

describe('effectiveForMany batches rules()/getDefaultLevel() (#456)', () => {
  it('matches per-item effectiveFor output, reading rules/level once regardless of item count', async () => {
    const { svc, store } = await setup();
    await store.setRule({ scopeKind: 'tag', scopeValue: 'ops', level: 'urgent', snoozeUntil: null });
    await store.setRule({ scopeKind: 'source', scopeValue: 'workspace:W1', level: 'off', snoozeUntil: null });
    await store.setDefaultLevel('high');
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: `item-${i}`,
      priority: i % 3 === 0 ? ('urgent' as const) : ('normal' as const),
      source: i % 2 === 0 ? { kind: 'workspace' as const, id: 'W1' } : { kind: 'user' as const, id: null },
      dedupeKey: null,
      tags: i % 4 === 0 ? ['ops'] : []
    }));
    const counter = countQueries(inbox);
    const batched = await svc.effectiveForMany(items);
    const queriesForMany = counter.count();
    expect(Object.keys(batched)).toHaveLength(20);
    for (const item of items) {
      const solo = await svc.effectiveFor(item);
      expect(batched[item.id]).toEqual(solo);
    }
    await expect(svc.effectiveForMany([])).resolves.toEqual({});
    // A larger batch must not cost more queries than a smaller one.
    const moreItems = [...items, ...items.map((i) => ({ ...i, id: `${i.id}-dup` }))];
    const counter2 = countQueries(inbox);
    await svc.effectiveForMany(moreItems);
    expect(counter2.count()).toBe(queriesForMany);
    expect(queriesForMany).toBeLessThanOrEqual(3);
  });
});

describe('tick serialization', () => {
  it('two overlapping ticks when a pause ends send exactly one digest', async () => {
    const { store, svc, delivered } = await setup();
    await store.setPause({ until: null, letUrgent: false, setAt: 0 });
    await svc.tick(); // the quiet period begins
    const held = await svc.request({ kind: 'post', title: 'x', priority: 'normal', source: { kind: 'workspace', id: 'W1' } });
    expect(held.heldReason).toBe('pause');
    await store.clearPause();
    const [a, b] = await Promise.all([svc.tick(), svc.tick()]);
    expect([a, b].filter((n) => n?.kind === 'digest')).toHaveLength(1);
    expect(delivered.filter((n) => n.kind === 'digest')).toHaveLength(1);
  });
});

describe('remote notices meet the local policy (D132)', () => {
  const R = '01JC0000000000000000000000';
  const notice = (over: Record<string, unknown> = {}) => remoteNoticeInput(
    { id: '01JC0000000000000000000001', ts: 0, kind: 'post', title: 'deploy failed', body: null, priority: 'urgent', dedupeKey: 'deploy', ...over } as never,
    R, 'review-bot', null
  );

  it('a muted remote workspace holds its notices, whatever key the host sends', async () => {
    const { store, svc, delivered } = await setup();
    await store.setRule({ scopeKind: 'source', scopeValue: `workspace:${R}`, level: 'off', snoozeUntil: null });
    const row = await svc.request(notice());
    expect(row).toMatchObject({ delivered: false, workspaceId: R, source: { kind: 'workspace', id: R }, tags: [] });
    expect(row.heldReason).toMatch(/^rule:/);
    expect(await svc.request(notice({ dedupeKey: 'something-else' }))).toMatchObject({ delivered: false });
    expect(delivered).toEqual([]);
  });

  it('a pause holds them too, and an unmuted one is delivered under its name', async () => {
    const { store, svc, delivered, at } = await setup();
    await store.setPause({ until: at() + 60_000, letUrgent: false, setAt: at() } as never);
    expect(await svc.request(notice({ priority: 'normal' }))).toMatchObject({ delivered: false, heldReason: 'pause' });
    await store.clearPause();
    expect(await svc.request(notice({ priority: 'normal' }))).toMatchObject({ delivered: true, title: 'review-bot · deploy failed' });
    expect(delivered).toHaveLength(1);
  });
});
