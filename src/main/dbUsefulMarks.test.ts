import { describe, expect, it } from 'vitest';
import * as db from './db.js';
import { openTestState } from './store/testStore.js';

describe('usefulMarkCounts', () => {
  it('counts marked-useful only where the origin is another workspace', async () => {
    await openTestState('useful-');
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'pub1', kind: 'marked-useful', origin: 'pub_a' });
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'pub1', kind: 'marked-useful', origin: 'pub_a' });
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'own1', kind: 'marked-useful', origin: 'H' });
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'old1', kind: 'marked-useful' });
    await db.recordUsageEvent({ workspaceId: 'H', sessionId: 'pub1', kind: 'clickthrough', origin: 'pub_a' });
    expect(await db.usefulMarkCounts(['pub1', 'own1', 'old1', 'none'])).toEqual(new Map([['pub1', 2]]));
    expect(await db.usefulMarkCounts([])).toEqual(new Map());
  });

  it('counts across more ids than one chunk', async () => {
    await openTestState('useful-many-');
    const ids = Array.from({ length: 1_201 }, (_, i) => `s${i}`);
    for (const id of [ids[0], ids[600], ids[1_200]]) await db.recordUsageEvent({ workspaceId: 'H', sessionId: id, kind: 'marked-useful', origin: 'pub_a' });
    expect(await db.usefulMarkCounts(ids)).toEqual(new Map([[ids[0], 1], [ids[600], 1], [ids[1_200], 1]]));
  });
});
