import { describe, it, expect, afterEach } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { AutomationStore } from './automationStore.js';
import { executeRun, type RunnerDeps, type WorkspaceState } from './runner.js';
import { dueSchedule, nextFireAt } from './scheduler.js';
import type { AutomationDef } from '../../preload/inboxTypes.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());
const USER = { kind: 'user' as const, id: null };
const step = (over: Record<string, unknown> = {}) => ({ id: 'check', prompt: { workspace: 'W1', mode: 'live' as const, message: 'check {{args.since}}', ...over } });
const def = (over: Partial<AutomationDef> = {}): AutomationDef => ({
  name: 'log-watch', triggers: [{ manual: {} }], concurrency: 'skip', params: [{ name: 'since', type: 'string', default: '1h' }],
  steps: [step()], ...over
});

function setup(state: WorkspaceState | null = 'running', busyPlan: boolean[] = [], freshMs = 5000) {
  const fresh: Array<[string, string, string[]]> = [];
  const closed: string[] = [];
  const freshEnds = new Map<string, number>();
  inbox = InboxStore.memory();
  const store = new AutomationStore(inbox.db);
  let t = 1_000_000;
  const posts: Array<[string, string]> = [];
  const started: string[] = [];
  let busyIdx = 0;
  const deps: RunnerDeps = {
    store, now: () => t, sleep: async (ms) => { t += ms; },
    workspaceState: async () => state, workspaceName: (id) => (id === 'W1' ? 'ops-oncall' : id),
    ensureRunning: async (id) => { started.push(id); state = 'running'; },
    post: async (id, text) => { posts.push([id, text]); return { via: 'attached', brokerSessionId: 'B1' }; },
    busy: () => (busyIdx < busyPlan.length ? busyPlan[busyIdx++] : false),
    spawnFresh: async (id, sid, args) => { fresh.push([id, sid, args]); freshEnds.set(sid, t + freshMs); },
    freshState: async (_id, sid) => (freshEnds.has(sid) ? (t < freshEnds.get(sid)! ? 'alive' : 'ended') : 'missing'),
    closeFresh: async (_id, sid) => { closed.push(sid); }
  };
  return { store, deps, posts, started, fresh, closed, advance: (ms: number) => { t += ms; } };
}

describe('executeRun', () => {
  it('posts the rendered prompt with the run footer and records the step', async () => {
    const { store, deps, posts } = setup();
    const a = store.create(def(), USER);
    const run = store.startRun(a, { kind: 'manual', by: USER }, { since: '2h' }, 'running');
    expect(await executeRun(deps, a, run, { callerSupplied: false })).toEqual({ status: 'succeeded', error: null });
    expect(posts[0][0]).toBe('W1');
    expect(posts[0][1]).toMatch(/^check 2h\n\n\(claude-fleet automation "log-watch", run /);
    expect(store.getRun(run.id)!.steps[0]).toMatchObject({ status: 'succeeded', brokerSessionId: 'B1', detail: { via: 'attached' } });
  });
  it('fails clearly when the target is not running, unless ensureRunning starts it', async () => {
    const a1 = setup('paused');
    const a = a1.store.create(def(), USER);
    const r = await executeRun(a1.deps, a, a1.store.startRun(a, { kind: 'manual' }, {}, 'running'), { callerSupplied: false });
    expect(r).toEqual({ status: 'failed', error: 'check: target-not-running: ops-oncall is paused (set ensureRunning: true to start it)' });
    const b1 = setup('stopped');
    const b = b1.store.create(def({ steps: [step({ ensureRunning: true })] }), USER);
    expect((await executeRun(b1.deps, b, b1.store.startRun(b, { kind: 'manual' }, {}, 'running'), { callerSupplied: false })).status).toBe('succeeded');
    expect(b1.started).toEqual(['W1']);
    const c1 = setup('unreachable');
    const c = c1.store.create(def(), USER);
    expect((await executeRun(c1.deps, c, c1.store.startRun(c, { kind: 'manual' }, {}, 'running'), { callerSupplied: false })).error).toMatch(/docker-unreachable/);
  });
  it('wait: succeeds once the target goes busy then idle; times out if it stays busy', async () => {
    const ok = setup('running', [false, true, true, false]);
    const a = ok.store.create(def({ steps: [step({ wait: true })] }), USER);
    expect((await executeRun(ok.deps, a, ok.store.startRun(a, { kind: 'manual' }, {}, 'running'), { callerSupplied: false })).status).toBe('succeeded');
    const stuck = setup('running', Array(2000).fill(true));
    const b = stuck.store.create(def({ steps: [step({ wait: true, timeout: '1m' })] }), USER);
    const r = await executeRun(stuck.deps, b, stuck.store.startRun(b, { kind: 'manual' }, {}, 'running'), { callerSupplied: false });
    expect(r).toEqual({ status: 'timed-out', error: 'check: ops-oncall was still working after 1m' });
    expect(stuck.store.getRun(stuck.store.runs(b.id)[0].id)!.steps[0].status).toBe('timed-out');
  });
  it('wait: a target that never starts working within the grace window counts as done', async () => {
    const s = setup('running', []);
    const a = s.store.create(def({ steps: [step({ wait: true })] }), USER);
    expect((await executeRun(s.deps, a, s.store.startRun(a, { kind: 'manual' }, {}, 'running'), { callerSupplied: false })).status).toBe('succeeded');
  });
  it('stops at the first failing step', async () => {
    const s = setup('running');
    const a = s.store.create(def({ steps: [step(), { id: 'second', prompt: { workspace: 'W9', mode: 'live', message: 'x' } }, { id: 'third', prompt: { workspace: 'W1', mode: 'live', message: 'y' } }] }), USER);
    s.deps.workspaceState = async (id) => (id === 'W9' ? null : 'running');
    const r = await executeRun(s.deps, a, s.store.startRun(a, { kind: 'manual' }, {}, 'running'), { callerSupplied: false });
    expect(r.error).toBe('second: target-not-running: W9 no longer exists');
    expect(s.posts).toHaveLength(1);
  });
});

describe('scheduler', () => {
  const at = (h: number, m = 0, day = 19) => new Date(2026, 9, day, h, m).getTime();
  it('fires once when a slot passes, flags a multi-slot catch-up, and reports the next fire', () => {
    inbox = InboxStore.memory();
    const store = new AutomationStore(inbox.db);
    const a = store.create(def({ triggers: [{ schedule: { cron: '*/30 * * * *', args: { since: '3h' } } }] }), USER, at(10, 5));
    expect(dueSchedule(store.get(a.id)!, at(10, 20))).toBeNull();
    expect(dueSchedule(store.get(a.id)!, at(10, 30))).toMatchObject({ slot: at(10, 30), catchUp: false, args: { since: '3h' } });
    expect(dueSchedule(store.get(a.id)!, at(14, 0))).toMatchObject({ slot: at(10, 30), catchUp: true });
    store.setLastScheduled(a.id, at(14, 0));
    expect(dueSchedule(store.get(a.id)!, at(14, 10))).toBeNull();
    expect(nextFireAt(store.get(a.id)!, at(14, 10))).toBe(at(14, 30));
    store.setEnabled(a.id, false);
    expect(dueSchedule(store.get(a.id)!, at(20, 0))).toBeNull();
    expect(nextFireAt(store.get(a.id)!, at(20, 0))).toBeNull();
  });
});

describe('fresh steps (Phase 4)', () => {
  it('spawns claude -p with the inbox tools + allowedTools, waits for it to end, then closes it', async () => {
    const s = setup('running', [], 6000);
    const a = s.store.create(def({ steps: [step({ mode: 'fresh', allowedTools: ['Read'] })] }), USER);
    const run = s.store.startRun(a, { kind: 'manual' }, { since: '1h' }, 'running');
    expect(await executeRun(s.deps, a, run, { callerSupplied: false })).toEqual({ status: 'succeeded', error: null });
    const [ws, sid, args] = s.fresh[0];
    expect([ws, sid]).toEqual(['W1', `auto-${run.id}-check`]);
    expect(args[0]).toBe('-p');
    expect(args[1]).toMatch(/^check 1h/);
    expect(args[2]).toBe('--allowedTools');
    expect(args[3].split(',')).toEqual(expect.arrayContaining(['mcp__claude-fleet-state__post_todo', 'mcp__claude-fleet-state__notify', 'Read']));
    expect(s.closed).toEqual([sid]);
    expect(s.store.getRun(run.id)!.steps[0]).toMatchObject({ status: 'succeeded', brokerSessionId: sid, detail: { via: 'fresh' } });
  });
  it('times out a fresh session that keeps running, and still closes it', async () => {
    const s = setup('running', [], 10 * 60_000);
    const a = s.store.create(def({ steps: [step({ mode: 'fresh', timeout: '1m' })] }), USER);
    const run = s.store.startRun(a, { kind: 'manual' }, {}, 'running');
    const r = await executeRun(s.deps, a, run, { callerSupplied: false });
    expect(r).toEqual({ status: 'timed-out', error: 'check: the fresh session in ops-oncall was still running after 1m' });
    expect(s.closed).toHaveLength(1);
  });
  it('fills {{trigger.workspace}} and {{trigger.todo}} for event runs', async () => {
    const s = setup();
    const a = s.store.create(def({ steps: [step({ message: '{{trigger.kind}}: {{trigger.workspace}} / {{trigger.todo}}' })] }), USER);
    const run = s.store.startRun(a, { kind: 'event', event: { on: 'todo.created', workspaceId: 'W1', todoTitle: 'Disk full', count: 2 } }, {}, 'running');
    await executeRun(s.deps, a, run, { callerSupplied: false });
    expect(s.posts[0][1]).toMatch(/^event: ops-oncall \/ Disk full/);
  });
});
