import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { CaptureRunStore } from './captureRunStore.js';

let inbox: InboxStore; let r: CaptureRunStore;
beforeEach(() => { inbox = InboxStore.memory(); r = new CaptureRunStore(inbox.kysely); });
afterEach(() => inbox.close());

describe('CaptureRunStore', () => {
  it('validates tokens only for running runs in the same workspace', async () => {
    const id = await r.start({ workspaceId: 'wsA', sessionId: 's1', forkSessionId: 'f1', trigger: 'ctx-60', now: 1 });
    expect((await r.runningFor(id, 'wsA'))?.session_id).toBe('s1');
    expect(await r.runningFor(id, 'wsB')).toBeNull();
    expect(await r.runningFor('nope', 'wsA')).toBeNull();
    await r.finish(id, { status: 'done', usage: { cost: 0.1 }, error: null, now: 2 });
    expect(await r.runningFor(id, 'wsA')).toBeNull();
  });
  it('counts claims, reports last run and fork ids, fails stale running runs', async () => {
    const a = await r.start({ workspaceId: 'wsA', sessionId: 's1', forkSessionId: 'f1', trigger: 'turns', now: 1 });
    await r.incrementClaims(a); await r.incrementClaims(a);
    const b = await r.start({ workspaceId: 'wsA', sessionId: 's1', forkSessionId: 'f2', trigger: 'ctx-85', now: 5 });
    expect((await r.lastFor('s1'))?.id).toBe(b);
    expect((await r.lastFor('s1'))?.claims_recorded).toBe(0);
    expect((await r.forkSessionIds()).sort()).toEqual(['f1', 'f2']);
    expect(await r.failRunning(9, 'interrupted by app restart')).toBe(2);
    expect(await r.runningFor(a, 'wsA')).toBeNull();
  });
});
