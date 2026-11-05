import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxStore } from '../inbox/inboxDb.js';
import { openTestInbox } from '../store/testStore.js';
import { ClaimStore, type NewClaim } from './claimStore.js';
import type { ClaimSourceInput } from './types.js';

let inbox: InboxStore; let s: ClaimStore;
beforeEach(async () => { inbox = await openTestInbox(); s = new ClaimStore(inbox.kysely, inbox.dialect); });
afterEach(async () => { await inbox.close(); });

const M = 'model@q8';
const src = (ws: string): ClaimSourceInput => ({ workspaceId: ws, sessionId: null, via: 'agent', captureRun: null });
const claim = (id: string, ws: string, over: Partial<NewClaim> = {}): NewClaim => ({
  id, text: `claim ${id} about snapshot`, kind: 'fact', topics: ['mcp-query'], refs: ['#476'],
  visibility: 'fleet', workspaceId: ws, now: 1000, ...over
});

describe('ClaimStore', () => {
  it('round-trips a claim with its vector and source', async () => {
    await s.insert(claim('c1', 'wsA'), Buffer.from([1, 2]), M, src('wsA'));
    expect(await s.get('c1')).toMatchObject({ id: 'c1', topics: ['mcp-query'], refs: ['#476'], status: 'current', confirmations: 1 });
    const v = await s.visible('wsA', M, false);
    expect(v.map((x) => [x.claim.id, x.vec?.length])).toEqual([['c1', 2]]);
    expect((await s.sources(['c1'])).get('c1')).toHaveLength(1);
  });

  it('hides other workspaces\' private claims but shows fleet ones', async () => {
    await s.insert(claim('pubB', 'wsB'), null, M, src('wsB'));
    await s.insert(claim('privB', 'wsB', { visibility: 'private' }), null, M, src('wsB'));
    await s.insert(claim('privA', 'wsA', { visibility: 'private' }), null, M, src('wsA'));
    const ids = (await s.visible('wsA', M, false)).map((x) => x.claim.id).sort();
    expect(ids).toEqual(['privA', 'pubB']);
    expect((await s.ftsIds('wsA', '"snapshot"', 10, false)).sort()).toEqual(['privA', 'pubB']);
  });

  it('confirm bumps confirmations and adds a source', async () => {
    await s.insert(claim('c1', 'wsA'), null, M, src('wsA'));
    await s.confirm('c1', src('wsB'), 2000);
    expect(await s.get('c1')).toMatchObject({ confirmations: 2, updatedAt: 2000 });
    expect((await s.sources(['c1'])).get('c1')).toHaveLength(2);
  });

  it('supersede and retract remove claims from the default visible set', async () => {
    await s.insert(claim('old', 'wsA'), null, M, src('wsA'));
    await s.insert(claim('new', 'wsA'), null, M, src('wsA'));
    await s.insert(claim('bad', 'wsA'), null, M, src('wsA'));
    await s.supersede('old', 'new', 3000);
    await s.retract('bad', 'wrong', 3000);
    expect((await s.visible('wsA', M, false)).map((x) => x.claim.id)).toEqual(['new']);
    expect((await s.visible('wsA', M, true)).length).toBe(3);
    expect(await s.get('old')).toMatchObject({ status: 'superseded', supersededBy: 'new' });
    expect(await s.get('bad')).toMatchObject({ status: 'retracted', retractReason: 'wrong' });
    expect(await s.ftsIds('wsA', '"snapshot"', 10, false)).toEqual(['new']);
  });

  it('lists and fills missing vectors', async () => {
    await s.insert(claim('c1', 'wsA'), null, M, src('wsA'));
    expect(await s.missingVectors(M, 10)).toEqual([{ id: 'c1', text: 'claim c1 about snapshot' }]);
    await s.setVector('c1', M, Buffer.from([9]));
    expect(await s.missingVectors(M, 10)).toEqual([]);
  });
});
