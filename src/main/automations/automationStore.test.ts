import { describe, it, expect, afterEach } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { AutomationStore } from './automationStore.js';
import type { AutomationDef } from '../../preload/inboxTypes.js';

let inbox: InboxStore;
afterEach(() => inbox?.close());
const USER = { kind: 'user' as const, id: null };
const def = (over: Partial<AutomationDef> = {}): AutomationDef => ({
  name: 'log-watch', tags: ['ops', 'Prod'], triggers: [{ manual: {} }], concurrency: 'skip',
  steps: [{ id: 'check', prompt: { workspace: 'W1', mode: 'live', message: 'check logs' } }], ...over
});

describe('AutomationStore definitions', () => {
  it('creates v1 with tags and history, versions on update, enforces unique names', () => {
    inbox = InboxStore.memory();
    const s = new AutomationStore(inbox.db);
    const a = s.create(def(), USER, 1000);
    expect(a).toMatchObject({ name: 'log-watch', enabled: true, version: 1, createdBy: USER, lastScheduledAt: 1000 });
    expect(s.tags(a.id)).toEqual(['ops', 'prod']);
    expect(() => s.create(def(), USER)).toThrow(/already exists/);
    const b = s.update(a.id, def({ description: 'v2', tags: ['ops'] }), USER, 2000);
    expect(b.version).toBe(2);
    expect(s.tags(a.id)).toEqual(['ops']);
    expect(s.versions(a.id).map((v) => v.version)).toEqual([2, 1]);
    s.create(def({ name: 'other' }), USER);
    expect(() => s.update(a.id, def({ name: 'other' }), USER)).toThrow(/already exists/);
  });
  it('re-enabling resets the schedule clock; remove keeps run history', () => {
    inbox = InboxStore.memory();
    const s = new AutomationStore(inbox.db);
    const a = s.create(def(), USER, 1000);
    s.setEnabled(a.id, false, 2000);
    expect(s.get(a.id)).toMatchObject({ enabled: false, lastScheduledAt: 1000 });
    s.setEnabled(a.id, true, 5000);
    expect(s.get(a.id)).toMatchObject({ enabled: true, lastScheduledAt: 5000 });
    const run = s.startRun(s.get(a.id)!, { kind: 'manual', by: USER }, {}, 'succeeded', 6000);
    s.remove(a.id);
    expect(s.get(a.id)).toBeNull();
    expect(s.getRun(run.id)).not.toBeNull();
  });
});

describe('AutomationStore runs', () => {
  it('records runs and steps, stats the week, marks interrupted, prunes', () => {
    inbox = InboxStore.memory();
    const s = new AutomationStore(inbox.db);
    const a = s.create(def(), USER, 1000);
    const now = 10 * 86_400_000;
    const r1 = s.startRun(a, { kind: 'schedule', cron: '*/5 * * * *' }, { since: '1h' }, 'running', now);
    const st = s.startStep(r1.id, 'check', 'prompt', 'W1', now);
    s.finishStep(st, 'succeeded', { brokerSessionId: 'B1', detail: { via: 'attached' } }, now + 5);
    s.setRunStatus(r1.id, 'succeeded', now + 5);
    s.startRun(a, { kind: 'manual' }, {}, 'nothing-to-do', now + 10);
    s.startRun(a, { kind: 'manual' }, {}, 'failed', now + 20, 'boom');
    s.startRun(a, { kind: 'manual' }, {}, 'skipped', now + 30);
    const r5 = s.startRun(a, { kind: 'manual' }, {}, 'running', now + 40);
    s.startStep(r5.id, 'check', 'prompt', 'W1', now + 40);
    const got = s.getRun(r1.id)!;
    expect(got).toMatchObject({ status: 'succeeded', endedAt: now + 5, args: { since: '1h' }, trigger: { kind: 'schedule' } });
    expect(got.steps[0]).toMatchObject({ stepId: 'check', status: 'succeeded', brokerSessionId: 'B1', detail: { via: 'attached' } });
    expect(s.weekStats(a.id, now + 50)).toEqual({ runs: 4, nothingToDo: 1, failed: 1 });
    expect(s.runs(a.id).map((r) => r.status)).toEqual(['running', 'skipped', 'failed', 'nothing-to-do', 'succeeded']);
    expect(s.markInterrupted(now + 60).map((r) => r.id)).toEqual([r5.id]);
    expect(s.getRun(r5.id)).toMatchObject({ status: 'interrupted', error: 'the app quit mid-run' });
    expect(s.getRun(r5.id)!.steps[0].status).toBe('interrupted');
    expect(s.pruneRuns(now + 25)).toBe(3);
    expect(s.runs(a.id)).toHaveLength(2);
  });
});
