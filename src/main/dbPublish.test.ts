import { describe, expect, it } from 'vitest';
import * as db from './db.js';
import { partitionIdFor } from './publish/protocol.js';
import { openTestState } from './store/testStore.js';

describe('state v19: publish tables', () => {
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
