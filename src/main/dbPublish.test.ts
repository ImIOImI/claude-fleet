import { describe, expect, it } from 'vitest';
import * as db from './db.js';
import { partitionIdFor } from './publish/protocol.js';
import { openTestState } from './store/testStore.js';

describe('state v20: publish tables', () => {
  it('creates publish_cursors, publish_withheld and usage_events.origin', async () => {
    await openTestState('pub-schema-');
    const k = db.stateKysely();
    await k.insertInto('publish_cursors').values({ source_workspace_id: 'W', target_workspace_id: 'R', last_event_id: 5, updated_at: 1 }).execute();
    await k.insertInto('publish_withheld').values({ session_id: 's1', workspace_id: 'W', withheld_at: 1 }).execute();
    await k.insertInto('usage_events').values({ ts: 1, workspace_id: 'W', session_id: 's1', kind: 'marked-useful', detail: null, origin: 'pub_x' }).execute();
    expect(Number((await k.selectFrom('publish_cursors').select('last_event_id').executeTakeFirstOrThrow()).last_event_id)).toBe(5);
    expect((await k.selectFrom('usage_events').select('origin').executeTakeFirstOrThrow()).origin).toBe('pub_x');
    await expect(
      k.insertInto('publish_cursors').values({ source_workspace_id: 'W', target_workspace_id: 'R', last_event_id: 6, updated_at: 2 }).execute()
    ).rejects.toThrow();
  });
});

describe('ingest into a published partition', () => {
  const PUB = partitionIdFor({ provider: 'github', id: 1 }, '01J0000000000000000000000A');
  const S = '11111111-2222-5333-8444-555555555555';
  const title = (t: string): string => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: S });
  const sessionRow = async (): Promise<{ ai_title: string | null; first_user_message: string | null }> =>
    db.stateKysely().selectFrom('sessions').select(['ai_title', 'first_user_message']).where('id', '=', S).executeTakeFirstOrThrow();
  const LINE_429 = JSON.stringify({
    type: 'assistant',
    uuid: 'ebc349f7-f938-4798-a930-533183e64d62',
    timestamp: '2026-07-12T13:54:34.503Z',
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 6pm (UTC)" }] },
  });

  it.each([
    [PUB, 'second'],
    ['W', 'first'],
  ])('a re-sent ai-title line in %s leaves the title at %s', async (ws, want) => {
    await openTestState('pub-title-');
    await db.ingestLine(ws, S, title('first'));
    await db.ingestLine(ws, S, title('second'));
    expect((await db.ingestLine(ws, S, title('first'))).inserted).toBe(false);
    expect((await sessionRow()).ai_title).toBe(want);
  });

  it.each([
    [PUB, null],
    ['W', 'hello'],
  ])('a re-sent user line in %s sets first_user_message to %s', async (ws, want) => {
    await openTestState('pub-first-');
    const user = JSON.stringify({ type: 'user', uuid: 'u1', sessionId: S, message: { role: 'user', content: 'hello' } });
    await db.ingestLine(ws, S, user);
    expect((await sessionRow()).first_user_message).toBe('hello');
    await db.stateKysely().updateTable('sessions').set({ first_user_message: null }).where('id', '=', S).execute();
    await db.ingestLine(ws, S, user);
    expect((await sessionRow()).first_user_message).toBe(want);
  });

  it('records no usage anchor from a published rate-limit line; the desktop still does', async () => {
    await openTestState('pub-anchor-');
    await db.ingestLine(PUB, S, LINE_429);
    expect(await db.latestLimitHitAnchor()).toBeNull();
    await db.ingestLine('W', 'sess-w', LINE_429);
    expect((await db.latestLimitHitAnchor())?.kind).toBe('limit-hit');
  });
});

const W = '01JC0000000000000000000005';
const turn = (sessionId: string, uuid: string, ts: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, sessionId, timestamp: ts, message: { role: 'user', content } });

describe('publish helpers', () => {
  it('lists a workspace’s events after the cursor in id order, with each session’s start and attachments expanded', async () => {
    await openTestState('pub-ev-');
    await db.ingestBatch(W, 'old', [turn('old', 'o1', '2026-11-01T00:00:00Z', 'before opt-in')]);
    await db.ingestBatch(W, 'new', [turn('new', 'n1', '2026-11-05T00:00:00Z', 'first'), turn('new', 'n2', '2026-11-05T00:01:00Z', 'second')]);
    await db.ingestBatch(W, 'bare', [JSON.stringify({ type: 'user', uuid: 'b1', sessionId: 'bare', message: { role: 'user', content: 'no timestamp' } })]);
    await db.ingestBatch('01JC0000000000000000000006', 'x', [turn('x', 'x1', '2026-11-05T00:00:00Z', 'other workspace')]);
    const all = await db.publishableEvents(W, 0, 10);
    expect(all.map((e) => [e.sessionId, JSON.parse(e.rawJsonl).message.content, e.startedAt])).toEqual([
      ['old', 'before opt-in', Date.parse('2026-11-01T00:00:00Z')],
      ['new', 'first', Date.parse('2026-11-05T00:00:00Z')],
      ['new', 'second', Date.parse('2026-11-05T00:00:00Z')],
      ['bare', 'no timestamp', null]
    ]);
    expect(await db.publishableEvents(W, all[1].id, 10)).toEqual(all.slice(2));
    expect(await db.publishableEvents(W, 0, 1)).toEqual([all[0]]);
    expect(await db.workspaceMaxEventId(W)).toBe(all[3].id);
    expect(await db.workspaceMaxEventId('01JC0000000000000000000009')).toBe(0);
    // An event without a sessions row still comes back, so the cursor can move past it.
    await db.stateKysely().deleteFrom('sessions').where('id', '=', 'bare').execute();
    expect((await db.publishableEvents(W, all[2].id, 10)).map((e) => [e.id, e.startedAt])).toEqual([[all[3].id, null]]);
  });

  it('drops every cursor towards a forgotten target', async () => {
    await openTestState('pub-cur-to-');
    const O = '01JC0000000000000000000006';
    await db.setPublishCursor(W, 'R', 3);
    await db.setPublishCursor(O, 'R', 4);
    await db.setPublishCursor(W, 'R2', 5);
    await db.deletePublishCursorsTo('R');
    expect([await db.getPublishCursor(W, 'R'), await db.getPublishCursor(O, 'R'), await db.getPublishCursor(W, 'R2')]).toEqual([0, 0, 5]);
  });

  it('keeps cursors and withheld sessions per workspace, and purges them with it', async () => {
    await openTestState('pub-cur-');
    expect(await db.getPublishCursor(W, 'R')).toBe(0);
    await db.setPublishCursor(W, 'R', 7);
    await db.setPublishCursor(W, 'R', 9);
    expect(await db.getPublishCursor(W, 'R')).toBe(9);
    await db.withholdSession(W, 's1');
    await db.withholdSession(W, 's1');
    expect(await db.withheldSessions(W)).toEqual(new Set(['s1']));
    await db.deletePublishCursor(W, 'R');
    expect(await db.getPublishCursor(W, 'R')).toBe(0);
    await db.setPublishCursor(W, 'R', 3);
    await db.purgeWorkspace(W);
    expect(await db.getPublishCursor(W, 'R')).toBe(0);
    expect(await db.withheldSessions(W)).toEqual(new Set());
  });

  it('purging a workspace leaves other workspaces’ cursors and withheld rows, and drops cursors that target it', async () => {
    await openTestState('pub-cur2-');
    const O = '01JC0000000000000000000006';
    await db.setPublishCursor(W, 'R', 3);
    await db.setPublishCursor(O, 'R', 4);
    await db.setPublishCursor(O, W, 5);
    await db.withholdSession(O, 's2');
    await db.purgeWorkspace(W);
    expect(await db.getPublishCursor(O, 'R')).toBe(4);
    expect(await db.getPublishCursor(O, W)).toBe(0);
    expect(await db.withheldSessions(O)).toEqual(new Set(['s2']));
  });
});
