import { describe, expect, it } from 'vitest';
import * as db from './db.js';
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
