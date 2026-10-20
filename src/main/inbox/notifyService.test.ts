import { describe, it, expect, afterEach } from 'vitest';
import { InboxStore } from './inboxDb.js';
import { NotifyStore } from './notifyStore.js';
import { createNotifyService, INPUT_WAIT_DELAY_MS } from './notifyService.js';
import type { NotificationRow } from '../../preload/inboxTypes.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());

function setup(opts: { focused?: boolean; viewing?: string | null; inboxOpen?: boolean } = {}) {
  inbox = InboxStore.memory();
  const store = new NotifyStore(inbox.db);
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
  const advance = (ms: number) => {
    t += ms;
    for (const h of timers) if (!h.dead && h.at <= t) { h.dead = true; h.fn(); }
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
  it('delivers and records the channel; holds by rule with the reason', () => {
    const { store, svc, delivered } = setup();
    const a = svc.request({ kind: 'post', title: 'hi', priority: 'normal', source: { kind: 'workspace', id: 'W1' } });
    expect(a).toMatchObject({ delivered: true, channel: 'os' });
    expect(store.get(a.id)?.channel).toBe('os');
    const r = store.setRule({ scopeKind: 'source', scopeValue: 'workspace:W1', level: 'off', snoozeUntil: null });
    const b = svc.request({ kind: 'post', title: 'muted', priority: 'urgent', source: { kind: 'workspace', id: 'W1' } });
    expect(b).toMatchObject({ delivered: false, heldReason: `rule:${r.id}`, channel: null });
    expect(delivered.map((n) => n.title)).toEqual(['hi']);
  });
});

describe('onTodoPosted', () => {
  it('notifies on request, or when a todo arrives urgent; not on a plain dedupe update', () => {
    const { svc } = setup();
    expect(svc.onTodoPosted(todo(), 'created', false)).toBeNull();
    expect(svc.onTodoPosted(todo(), 'created', true)).toMatchObject({ kind: 'todo', title: 'prod-api 5xx', body: 'ops-oncall' });
    expect(svc.onTodoPosted(todo({ priority: 'urgent', seenCount: 3 }), 'reopened', false))
      .toMatchObject({ title: 'Urgent · prod-api 5xx', body: 'ops-oncall · seen 3× · reopened', priority: 'urgent' });
    expect(svc.onTodoPosted(todo({ priority: 'urgent' }), 'updated', false)).toBeNull();
  });
});

describe('onPostRejected', () => {
  it('tells the user once per workspace per hour', () => {
    const { svc, advance } = setup();
    expect(svc.onPostRejected('W1', 'post limit 2/hour')?.title).toBe('ops-oncall hit its post limit');
    expect(svc.onPostRejected('W1', 'post limit 2/hour')).toBeNull();
    expect(svc.onPostRejected('W2', 'posting disabled')?.title).toBe('webex-triage tried to post, but posting is off');
    advance(3_600_001);
    expect(svc.onPostRejected('W1', 'post limit 2/hour')).not.toBeNull();
  });
});

describe('onInputWait', () => {
  it('notifies after the delay when the user is not looking, once per episode, and clears when answered', () => {
    const { store, svc, delivered, advance } = setup();
    svc.onInputWait('W2', ['s1']);
    svc.onInputWait('W2', ['s1', 's2']);
    advance(INPUT_WAIT_DELAY_MS - 1);
    expect(delivered).toHaveLength(0);
    advance(1);
    expect(delivered.map((n) => n.title)).toEqual(['webex-triage needs your input']);
    expect(svc.waitingWorkspaces()).toEqual(['W2']);
    svc.onInputWait('W2', []);
    expect(store.list()[0].clearedAt).not.toBeNull();
    expect(svc.waitingWorkspaces()).toEqual([]);
  });
  it('skips the notification when answered quickly or when the user is viewing that workspace', () => {
    const a = setup();
    a.svc.onInputWait('W2', ['s1']);
    a.advance(5_000);
    a.svc.onInputWait('W2', []);
    a.advance(INPUT_WAIT_DELAY_MS);
    expect(a.delivered).toHaveLength(0);
    const b = setup({ focused: true, viewing: 'W2' });
    b.svc.onInputWait('W2', ['s1']);
    b.advance(INPUT_WAIT_DELAY_MS);
    expect(b.delivered).toHaveLength(0);
    const c = setup({ focused: true, viewing: 'W2', inboxOpen: true });
    c.svc.onInputWait('W2', ['s1']);
    c.advance(INPUT_WAIT_DELAY_MS);
    expect(c.delivered).toHaveLength(1);
  });
});

describe('quiet periods and the digest', () => {
  it('holds during a pause, then sends one digest when it ends', () => {
    const { store, svc, delivered, advance, at } = setup();
    store.setPause({ until: at() + 3_600_000, letUrgent: true, setAt: at() });
    svc.tick();
    svc.onTodoPosted(todo(), 'created', true);
    svc.request({ kind: 'post', title: 'p', priority: 'normal', source: { kind: 'workspace', id: 'W1' } });
    svc.onTodoPosted(todo({ priority: 'urgent', id: 'T2' }), 'created', false); // urgent gets through
    expect(svc.quietState()).toMatchObject({ heldSinceQuiet: 2 });
    expect(delivered.map((n) => n.title)).toEqual(['Urgent · prod-api 5xx']);
    advance(3_600_001);
    const digest = svc.tick();
    expect(digest).toMatchObject({ kind: 'digest', title: 'Notifications resumed: 2 held', body: '1 todo (none urgent) · 1 other', delivered: true });
    expect(store.getPause()).toBeNull();
    expect(svc.tick()).toBeNull();
  });
  it('a downtime with nothing held ends without a digest; quietState reports the next downtime', () => {
    const { store, svc, advance } = setup();
    const d = store.saveDowntime({ name: 'Lunch', enabled: true, days: [0], startMin: 10 * 60, endMin: 11 * 60, bypass: 'none' });
    svc.tick();
    expect(svc.quietState().activeDowntime?.id).toBe(d.id);
    advance(3_600_000);
    expect(svc.tick()).toBeNull();
    expect(svc.quietState()).toMatchObject({ activeDowntime: null, nextDowntime: { downtime: { id: d.id } } });
  });
});

describe('scopes, effective rule, test, prune', () => {
  it('offers key / source / first tag scopes with labels', () => {
    const { svc, store } = setup();
    expect(svc.scopesFor({ source: { kind: 'workspace', id: 'W1' }, dedupeKey: 'k', tags: ['ops', 'prod'] })).toEqual([
      { scopeKind: 'key', scopeValue: 'workspace:W1:k', label: 'This item' },
      { scopeKind: 'source', scopeValue: 'workspace:W1', label: 'ops-oncall' },
      { scopeKind: 'tag', scopeValue: 'ops', label: '#ops' }
    ]);
    store.setRule({ scopeKind: 'tag', scopeValue: 'ops', level: 'urgent', snoozeUntil: null });
    expect(svc.effectiveFor({ priority: 'normal', source: { kind: 'user', id: null }, dedupeKey: null, tags: ['ops'] }).level).toBe('urgent');
  });
  it('test bypasses quiet; prune drops rows older than 30 days', () => {
    const { store, svc, advance, at } = setup();
    store.setPause({ until: null, letUrgent: false, setAt: at() });
    expect(svc.test().delivered).toBe(true);
    advance(31 * 86_400_000);
    expect(svc.prune()).toBe(1);
  });
});
