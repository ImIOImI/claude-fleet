import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxStore } from '../inbox/inboxDb.js';
import { openTestInbox } from '../store/testStore.js';
import { CaptureRunStore, startOfLocalDay } from './captureRunStore.js';

let inbox: InboxStore; let r: CaptureRunStore;
beforeEach(async () => { inbox = await openTestInbox(); r = new CaptureRunStore(inbox.kysely); });
afterEach(async () => { await inbox.close(); });

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
  it('stores the user-turn baseline and counts runs started since a time', async () => {
    await r.start({ workspaceId: 'wsA', sessionId: 's1', forkSessionId: 'f1', trigger: 'search', userTurns: 42, now: 100 });
    await r.start({ workspaceId: 'wsA', sessionId: 's2', forkSessionId: 'f2', trigger: 'ctx-85', now: 200 });
    expect((await r.lastFor('s1'))?.user_turns).toBe(42);
    expect((await r.lastFor('s2'))?.user_turns).toBeNull();
    expect(await r.countSince(150)).toBe(1);
    expect(await r.countSince(0)).toBe(2);
  });
  it('stores the effective capture visibility and compaction count at admit', async () => {
    await r.start({ workspaceId: 'wsA', sessionId: 's1', forkSessionId: 'f1', trigger: 'ctx-85', visibility: 'private', compactions: 3, now: 1 });
    await r.start({ workspaceId: 'wsA', sessionId: 's2', forkSessionId: 'f2', trigger: 'search', now: 2 });
    expect(await r.lastFor('s1')).toMatchObject({ visibility: 'private', compactions: 3 });
    expect(await r.lastFor('s2')).toMatchObject({ visibility: null, compactions: null });
  });
  it('startOfLocalDay is local midnight', () => {
    expect(startOfLocalDay(new Date(2026, 10, 4, 15, 30).getTime())).toBe(new Date(2026, 10, 4).getTime());
  });
});
