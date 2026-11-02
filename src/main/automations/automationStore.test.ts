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
  it('creates v1 with tags and history, versions on update, enforces unique names', async () => {
    inbox = InboxStore.memory();
    const s = new AutomationStore(inbox.kysely);
    const a = await s.create(def(), USER, 1000);
    expect(a).toMatchObject({ name: 'log-watch', enabled: true, version: 1, createdBy: USER, lastScheduledAt: 1000 });
    expect(await s.tags(a.id)).toEqual(['ops', 'prod']);
    await expect(s.create(def(), USER)).rejects.toThrow(/already exists/);
    const b = await s.update(a.id, def({ description: 'v2', tags: ['ops'] }), USER, 2000);
    expect(b.version).toBe(2);
    expect(await s.tags(a.id)).toEqual(['ops']);
    expect((await s.versions(a.id)).map((v) => v.version)).toEqual([2, 1]);
    await s.create(def({ name: 'other' }), USER);
    await expect(s.update(a.id, def({ name: 'other' }), USER)).rejects.toThrow(/already exists/);
  });
  it('re-enabling resets the schedule clock; remove keeps run history', async () => {
    inbox = InboxStore.memory();
    const s = new AutomationStore(inbox.kysely);
    const a = await s.create(def(), USER, 1000);
    await s.setEnabled(a.id, false, 2000);
    expect(await s.get(a.id)).toMatchObject({ enabled: false, lastScheduledAt: 1000 });
    await s.setEnabled(a.id, true, 5000);
    expect(await s.get(a.id)).toMatchObject({ enabled: true, lastScheduledAt: 5000 });
    const run = await s.startRun((await s.get(a.id))!, { kind: 'manual', by: USER }, {}, 'succeeded', 6000);
    await s.remove(a.id);
    expect(await s.get(a.id)).toBeNull();
    expect(await s.getRun(run.id)).not.toBeNull();
  });
});

describe('AutomationStore runs', () => {
  it('records runs and steps, stats the week, marks interrupted, prunes', async () => {
    inbox = InboxStore.memory();
    const s = new AutomationStore(inbox.kysely);
    const a = await s.create(def(), USER, 1000);
    const now = 10 * 86_400_000;
    const r1 = await s.startRun(a, { kind: 'schedule', cron: '*/5 * * * *' }, { since: '1h' }, 'running', now);
    const st = await s.startStep(r1.id, 'check', 'prompt', 'W1', now);
    await s.finishStep(st, 'succeeded', { brokerSessionId: 'B1', detail: { via: 'attached' } }, now + 5);
    await s.setRunStatus(r1.id, 'succeeded', now + 5);
    await s.startRun(a, { kind: 'manual' }, {}, 'nothing-to-do', now + 10);
    await s.startRun(a, { kind: 'manual' }, {}, 'failed', now + 20, 'boom');
    await s.startRun(a, { kind: 'manual' }, {}, 'skipped', now + 30);
    const r5 = await s.startRun(a, { kind: 'manual' }, {}, 'running', now + 40);
    await s.startStep(r5.id, 'check', 'prompt', 'W1', now + 40);
    const got = (await s.getRun(r1.id))!;
    expect(got).toMatchObject({ status: 'succeeded', endedAt: now + 5, args: { since: '1h' }, trigger: { kind: 'schedule' } });
    expect(got.steps[0]).toMatchObject({ stepId: 'check', status: 'succeeded', brokerSessionId: 'B1', detail: { via: 'attached' } });
    expect(await s.weekStats(a.id, now + 50)).toEqual({ runs: 4, nothingToDo: 1, failed: 1 });
    expect((await s.runs(a.id)).map((r) => r.status)).toEqual(['running', 'skipped', 'failed', 'nothing-to-do', 'succeeded']);
    expect((await s.markInterrupted(now + 60)).map((r) => r.id)).toEqual([r5.id]);
    expect(await s.getRun(r5.id)).toMatchObject({ status: 'interrupted', error: 'the app quit mid-run' });
    expect((await s.getRun(r5.id))!.steps[0].status).toBe('interrupted');
    expect(await s.pruneRuns(now + 25)).toBe(3);
    expect(await s.runs(a.id)).toHaveLength(2);
  });
});

describe('optimistic version check', () => {
  it('update with a stale expectedVersion rejects and writes nothing', async () => {
    inbox = InboxStore.memory();
    const s = new AutomationStore(inbox.kysely);
    const def = { name: 'a', triggers: [{ manual: {} }], steps: [{ id: 's', prompt: { workspace: 'W1', mode: 'live', message: 'hi' } }] } as never;
    const a = await s.create(def, { kind: 'user', id: null }, 1);
    await s.update(a.id, def, { kind: 'user', id: null }, 2, 1);
    await expect(s.update(a.id, def, { kind: 'user', id: null }, 3, 1)).rejects.toThrow(/changed \(now v2\)/);
    expect((await s.get(a.id))?.version).toBe(2);
    expect((await s.versions(a.id)).map((v) => v.version)).toEqual([2, 1]);
  });
});
