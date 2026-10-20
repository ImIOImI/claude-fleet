import { describe, it, expect, afterEach } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { AutomationStore } from './automationStore.js';
import { createAutomationService } from './automationService.js';
import type { WorkspaceState } from './runner.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());
const USER = { kind: 'user' as const, id: null };
const WSS: Record<string, string> = { 'ops-oncall': 'W1', 'webex-triage': 'W2' };

function setup(opts: { state?: WorkspaceState; postGate?: Promise<void> } = {}) {
  inbox = InboxStore.memory();
  const store = new AutomationStore(inbox.db);
  let t = new Date(2026, 9, 19, 10, 0).getTime();
  const posts: Array<[string, string]> = [];
  const notes: Array<Record<string, unknown>> = [];
  const timers: Array<{ fn: () => void; at: number; dead: boolean }> = [];
  const svc = createAutomationService({
    store, now: () => t, sleep: async (ms) => { t += ms; },
    workspaceState: async () => opts.state ?? 'running',
    workspaceName: (id) => Object.entries(WSS).find(([, v]) => v === id)?.[0] ?? id,
    ensureRunning: async () => {}, busy: () => false,
    spawnFresh: async () => {}, freshState: async () => 'ended', closeFresh: async () => {},
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, dead: false }; timers.push(h); return h; },
    clearTimer: (h) => { (h as { dead: boolean }).dead = true; },
    post: async (id, text) => { await opts.postGate; posts.push([id, text]); return { via: 'attached' }; },
    resolveWorkspace: (v) => WSS[v] ?? (Object.values(WSS).includes(v) ? v : null),
    notify: (n) => { notes.push(n as never); return null; },
    changed: () => {}
  });
  const fire = (ms: number) => { t += ms; for (const h of timers) if (!h.dead && h.at <= t) { h.dead = true; h.fn(); } };
  return { store, svc, posts, notes, fire, advance: (ms: number) => { t += ms; }, at: () => t };
}

const YAML = (extra = '') => `name: log-watch
tags: [ops]
triggers:
  - schedule: { cron: "*/15 * * * *" }
  - manual: { allowFrom: [webex-triage] }
params:
  - { name: since, type: string, default: "1h" }
steps:
  - id: check
    prompt: { workspace: ops-oncall, mode: live, message: "check {{args.since}}" }
${extra}`;

describe('CRUD + validation', () => {
  it('validates, creates with a resolved workspace, updates to v2, exposes YAML', () => {
    const { svc } = setup();
    expect(svc.validate('name: Bad')).toMatchObject({ ok: false });
    const a = svc.create(YAML(), USER);
    expect(a).toMatchObject({ name: 'log-watch', version: 1, tags: ['ops'], enabled: true });
    expect(a.definition.steps[0].prompt.workspace).toBe('W1');
    expect(a.nextFireAt).toBe(new Date(2026, 9, 19, 10, 15).getTime());
    const u = svc.update(a.id, YAML().replace('*/15', '*/30'), USER);
    expect(u.version).toBe(2);
    expect(svc.get(a.id)?.yaml).toContain('*/30 * * * *');
    expect(() => svc.create('name: x', USER)).toThrow(/triggers/);
  });
});

describe('runs', () => {
  it('runs now with validated args; records success', async () => {
    const { svc, posts } = setup();
    const a = svc.create(YAML(), USER);
    expect(() => svc.run(a.id, { kind: 'manual', by: USER, args: { nope: 1 } })).toThrow(/invalid arguments: nope: no such param/);
    const r = svc.run(a.id, { kind: 'manual', by: USER, args: { since: '6h' } });
    await svc.settle();
    expect(posts[0][1]).toMatch(/^check 6h/);
    expect(svc.get(a.id)?.runs[0]).toMatchObject({ id: r.id, status: 'succeeded' });
    expect(svc.list()[0].weekStats).toEqual({ runs: 1, nothingToDo: 0, failed: 0 });
  });
  it('skips while a run is in progress', async () => {
    let release!: () => void;
    const { svc } = setup({ postGate: new Promise<void>((r) => { release = r; }) });
    const a = svc.create(YAML(), USER);
    svc.run(a.id, { kind: 'manual', by: USER });
    expect(svc.run(a.id, { kind: 'manual', by: USER })).toMatchObject({ status: 'skipped', error: 'a run was already in progress' });
    release();
    await svc.settle();
  });
  it('queues one run behind an in-progress run when concurrency is queue', async () => {
    let release!: () => void;
    const { svc } = setup({ postGate: new Promise<void>((r) => { release = r; }) });
    const q = svc.create(YAML() + 'concurrency: queue\n', USER);
    svc.run(q.id, { kind: 'manual', by: USER });
    expect(svc.run(q.id, { kind: 'manual', by: USER }).status).toBe('queued');
    expect(svc.run(q.id, { kind: 'manual', by: USER }).status).toBe('skipped');
    release();
    await svc.settle();
    expect(svc.get(q.id)?.runs.map((r) => r.status).sort()).toEqual(['skipped', 'succeeded', 'succeeded']);
  });
  it('schedule tick fires once (catch-up after a gap), then rate-limits a second schedule within a minute', async () => {
    const { svc, advance, store } = setup();
    const a = svc.create(YAML(), USER);
    advance(3 * 3_600_000);
    const fired = svc.tick();
    expect(fired.map((r) => [r.trigger.kind, r.status])).toEqual([['catch-up', 'running']]);
    await svc.settle();
    expect(svc.tick()).toEqual([]);
    store.setLastScheduled(a.id, 0);
    expect(svc.tick()[0].status).toBe('skipped');
  });
  it('a failing run notifies; restart marks running runs interrupted with one notification', async () => {
    const { svc, notes, store } = setup({ state: 'paused' });
    const a = svc.create(YAML(), USER);
    svc.run(a.id, { kind: 'manual', by: USER });
    await svc.settle();
    expect(notes[0]).toMatchObject({ kind: 'run-failed', title: 'log-watch failed', priority: 'high', source: { kind: 'automation', id: a.id } });
    expect(String(notes[0].body)).toMatch(/target-not-running: ops-oncall is paused/);
    store.startRun(store.get(a.id)!, { kind: 'manual' }, {}, 'running');
    expect(svc.recover()).toHaveLength(1);
    expect(notes[1]).toMatchObject({ title: 'log-watch was interrupted' });
  });
});

describe('attribution + MCP', () => {
  it('attributes a run_id only while the run is live and the caller is a target', async () => {
    let release!: () => void;
    const { svc } = setup({ postGate: new Promise<void>((r) => { release = r; }) });
    const a = svc.create(YAML(), USER);
    const r = svc.run(a.id, { kind: 'manual', by: USER });
    expect(svc.attribution(r.id, 'W1')).toEqual({ automationId: a.id });
    expect(svc.attribution(r.id, 'W2')).toBeNull();
    expect(svc.attribution('nope', 'W1')).toBeNull();
    release();
    await svc.settle();
    expect(svc.attribution(r.id, 'W1')).toBeNull();
  });
  it('lists what a workspace may see and lets only allowFrom workspaces run it, quoting their args', async () => {
    const { svc, posts } = setup();
    const a = svc.create(YAML(), USER);
    expect(svc.mcp.list('W1')).toEqual([expect.objectContaining({ name: 'log-watch', canRun: false })]);
    expect(svc.mcp.list('W2')).toEqual([expect.objectContaining({ name: 'log-watch', canRun: true })]);
    expect(svc.mcp.list('W9')).toEqual([]);
    expect(() => svc.mcp.run('W1', { id: a.id })).toThrow(/not permitted/);
    const r = svc.mcp.run('W2', { id: 'log-watch', args: { since: 'yesterday' } });
    expect(r.status).toBe('running');
    await svc.settle();
    expect(posts[0][1]).toContain('caller-supplied input');
    svc.setEnabled(a.id, false);
    expect(() => svc.mcp.run('W2', { id: a.id })).toThrow(/disabled/);
  });
});

describe('event triggers (Phase 4)', () => {
  const EV = (trigger: string) => `name: on-event
triggers:
  - ${trigger}
steps:
  - id: look
    prompt: { workspace: ops-oncall, mode: live, message: "look" }
`;
  it('debounces a burst of matching events into one run', async () => {
    const { svc, fire } = setup();
    const a = svc.create(EV('event: { on: todo.created, tag: ops, debounce: 30s }'), USER);
    const todo = (id: string, tags = ['ops']) => ({ id, title: `t${id}`, tags, source: { kind: 'workspace' as const, id: 'W2' } });
    expect(svc.onEvent({ on: 'todo.created', todo: todo('1', ['other']) })).toEqual([]);
    expect(svc.onEvent({ on: 'todo.created', todo: todo('1') })).toEqual([a.id]);
    svc.onEvent({ on: 'todo.created', todo: todo('2') });
    svc.onEvent({ on: 'todo.created', todo: todo('3') });
    expect(svc.get(a.id)?.runs).toHaveLength(0);
    fire(30_000);
    await svc.settle();
    const runs = svc.get(a.id)!.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', trigger: { kind: 'event', event: { on: 'todo.created', todoId: '1', count: 3 } } });
  });
  it('filters by workspace, ignores its own todos, and ignores the workspace it just prompted', async () => {
    const { svc, fire } = setup();
    const a = svc.create(EV('event: { on: session.idle, debounce: 1s }'), USER);
    expect(svc.onEvent({ on: 'session.idle', workspaceId: 'W2' })).toEqual([a.id]);
    fire(1000);
    await svc.settle();
    // The run prompted W1 (ops-oncall); W1 going idle right after must not retrigger it.
    expect(svc.onEvent({ on: 'session.idle', workspaceId: 'W1' })).toEqual([]);
    const own = { id: 'T', title: 'x', tags: [], source: { kind: 'automation' as const, id: a.id } };
    const b = svc.create(EV('event: { on: todo.created, debounce: 1s }').replace('on-event', 'on-todo'), USER);
    // b never reacts to a todo it posted itself…
    expect(svc.onEvent({ on: 'todo.created', todo: { ...own, source: { kind: 'automation', id: b.id } } })).toEqual([]);
    // …but does react to someone else's.
    expect(svc.onEvent({ on: 'todo.created', todo: { ...own, source: { kind: 'user', id: null } } })).toEqual([b.id]);
    const c = svc.create(EV('event: { on: workspace.started, workspace: webex-triage, debounce: 1s }').replace('on-event', 'on-start'), USER);
    expect(svc.onEvent({ on: 'workspace.started', workspaceId: 'W9' })).toEqual([]);
    expect(svc.onEvent({ on: 'workspace.started', workspaceId: 'W2' })).toEqual([c.id]);
    svc.cancelPending();
  });
});

describe('automations workspace reach (Phase 5b)', () => {
  it('the privileged caller sees and can run every automation; get + listRuns respect visibility', async () => {
    const { svc } = setup();
    const a = svc.create(YAML().replace('  - manual: { allowFrom: [webex-triage] }\n', ''), USER);
    expect(svc.mcp.list('WA')).toEqual([]);
    expect(svc.mcp.list('WA', true)).toEqual([expect.objectContaining({ name: 'log-watch', canRun: true })]);
    expect(() => svc.mcp.run('WA', { id: a.id })).toThrow(/not permitted/);
    expect(svc.mcp.run('WA', { id: a.id }, true).status).toBe('running');
    await svc.settle();
    expect(() => svc.mcp.get('WA', { id: 'log-watch' })).toThrow(/not found/);
    expect(svc.mcp.get('WA', { id: 'log-watch' }, true)).toMatchObject({ name: 'log-watch', yaml: expect.stringContaining('log-watch'), runs: [expect.objectContaining({ status: 'succeeded' })] });
    expect(svc.mcp.get('W1', { id: a.id })).toMatchObject({ name: 'log-watch' }); // W1 is a step target → visible
    expect(svc.mcp.listRuns('WA', {}, true)).toEqual([expect.objectContaining({ automation: 'log-watch', status: 'succeeded' })]);
    expect(svc.mcp.listRuns('WA', { status: 'failed' }, true)).toEqual([]);
    expect(svc.mcp.listRuns('W9', {})).toEqual([]);
  });
});
