import { afterEach, describe, expect, it } from 'vitest';
import type { InboxStore } from '../main/inbox/inboxDb.js';
import { NotifyStore } from '../main/inbox/notifyStore.js';
import { openTestInbox } from '../main/store/testStore.js';
import { hostNotices, MAX_NOTICES_KEPT, NOTICE_HELD, NOTICE_RETENTION_MS } from './hostNotices.js';

const W = '01JC0000000000000000000000';

describe('host notices', () => {
  let inbox: InboxStore | null = null;
  afterEach(async () => { await inbox?.close(); inbox = null; });

  async function setup(clock: { now: number }, keep?: number) {
    inbox = await openTestInbox();
    const hints: number[] = [];
    const store = new NotifyStore(inbox.kysely);
    const n = hostNotices({ store, workspaceId: () => W, now: () => clock.now, changed: () => hints.push(clock.now), sourceName: () => 'review-bot', keep });
    return { n, hints, store };
  }

  it('records every notice undelivered and held "remote" for the hosted workspace, and hints', async () => {
    const clock = { now: 1_000 };
    const { n, hints } = await setup(clock);
    const row = await n.request({ kind: 'run-failed', title: 'nightly failed', body: 'exit 1', priority: 'high', source: { kind: 'automation', id: 'A' } });
    expect(row).toMatchObject({ delivered: false, heldReason: NOTICE_HELD, channel: null, kind: 'run-failed', workspaceId: W });
    expect(hints).toEqual([1_000]);
  });

  it('forces delivered=false and the hosted workspace whatever the input says', async () => {
    const { n } = await setup({ now: 1 });
    const row = await n.request({ kind: 'post', title: 't', priority: 'urgent', source: { kind: 'workspace', id: 'OTHER' }, workspaceId: 'OTHER', forceHold: 'x' });
    expect(row).toMatchObject({ delivered: false, heldReason: NOTICE_HELD, workspaceId: W });
  });

  it('one-lines and caps title, body, key and tags', async () => {
    const { n } = await setup({ now: 1 });
    const row = await n.request({
      kind: 'post', title: `a\nb\u0007c${'x'.repeat(300)}`, body: `line1\r\nline2${'y'.repeat(3000)}`, priority: 'normal',
      source: { kind: 'workspace', id: W }, dedupeKey: `k\n${'z'.repeat(300)}`, tags: Array.from({ length: 30 }, (_, i) => `t\n${i}${'q'.repeat(100)}`)
    });
    expect(row.title.startsWith('a b c')).toBe(true);
    expect(row.title).toHaveLength(200);
    expect(row.body!.startsWith('line1 line2')).toBe(true);
    expect(row.body).toHaveLength(2000);
    expect(row.dedupeKey).toHaveLength(200);
    expect(row.tags).toHaveLength(20);
    expect(row.tags.every((t) => t.length <= 64 && !/[\n\r]/.test(t))).toBe(true);
    for (const s of [row.title, row.body!, row.dedupeKey!]) expect(/[\u0000-\u001f\u007f]/.test(s)).toBe(false);
    expect((await n.request({ kind: 'post', title: '\n\n', priority: 'normal', source: { kind: 'workspace', id: W } })).title).toBe('(untitled)');
  });

  it('turns a todo post into a notice only when asked or urgent, like the desktop', async () => {
    const { n } = await setup({ now: 1 });
    const todo = { id: 'T', title: 'disk full', priority: 'normal', source: { kind: 'workspace', id: W }, seenCount: 1, workspaceId: W, dedupeKey: 'disk', tags: [] } as never;
    expect(await n.onTodoPosted(todo, 'created', false)).toBeNull();
    expect(await n.onTodoPosted(todo, 'created', true)).toMatchObject({ kind: 'todo', title: 'disk full', dedupeKey: 'disk', body: 'review-bot' });
    expect(await n.onTodoPosted({ ...(todo as object), priority: 'urgent' } as never, 'created', false)).toMatchObject({ title: 'Urgent · disk full' });
  });

  it('feeds oldest-first from sinceTs, newest page when sinceTs is null, only the hosted workspace, and prunes past retention', async () => {
    const clock = { now: 1_000 };
    const { n, store } = await setup(clock);
    for (let i = 0; i < 5; i++) {
      clock.now = 1_000 + i;
      await n.request({ kind: 'post', title: `n${i}`, priority: 'normal', source: { kind: 'workspace', id: W } });
    }
    await store.insert({ ts: 1_004, kind: 'post', title: 'stray', body: null, priority: 'normal', source: { kind: 'workspace', id: 'X' }, todoId: null, workspaceId: 'X', dedupeKey: null, tags: [], delivered: false, heldReason: 'remote', channel: null });
    expect((await n.feed({ sinceTs: 1_003, limit: 100 })).map((r) => r.title)).toEqual(['n3', 'n4']);
    expect((await n.feed({ sinceTs: null, limit: 2 })).map((r) => r.title)).toEqual(['n3', 'n4']);
    expect((await n.feed({ sinceTs: 0, limit: 2 })).map((r) => r.title)).toEqual(['n0', 'n1']);
    clock.now = 1_002 + NOTICE_RETENTION_MS;
    expect(await n.prune()).toBe(2);
    expect(NOTICE_RETENTION_MS).toBe(7 * 86_400_000);
  });

  it(`prune keeps only the newest ${MAX_NOTICES_KEPT} rows of the hosted workspace, same-ts rows by id`, async () => {
    expect(MAX_NOTICES_KEPT).toBe(5000);
    const clock = { now: 1_000 };
    const { n, store } = await setup(clock, 3);
    for (let i = 0; i < 6; i++) {
      clock.now = 1_000 + Math.floor(i / 2);
      await n.request({ kind: 'post', title: `n${i}`, priority: 'normal', source: { kind: 'workspace', id: W } });
    }
    await store.insert({ ts: 1, kind: 'post', title: 'stray', body: null, priority: 'normal', source: { kind: 'workspace', id: 'X' }, todoId: null, workspaceId: 'X', dedupeKey: null, tags: [], delivered: false, heldReason: 'remote', channel: null });
    const newest = (await n.feed({ sinceTs: 0, limit: 100 })).slice(-3).map((r) => r.id);
    expect(await n.prune()).toBe(3);
    expect((await n.feed({ sinceTs: 0, limit: 100 })).map((r) => r.id)).toEqual(newest);
    expect((await store.list({ workspaceId: 'X' })).map((r) => r.title)).toEqual(['stray']);
    expect(await n.prune()).toBe(0);
  });

  it('the feed pages a run of same-ts rows by (ts, id), strictly after the keyset', async () => {
    const clock = { now: 2_000 };
    const { n } = await setup(clock);
    for (let i = 0; i < 5; i++) await n.request({ kind: 'post', title: `s${i}`, priority: 'normal', source: { kind: 'workspace', id: W } });
    clock.now = 2_001;
    await n.request({ kind: 'post', title: 'later', priority: 'normal', source: { kind: 'workspace', id: W } });
    const all = await n.feed({ sinceTs: 2_000, limit: 100 });
    const first = await n.feed({ sinceTs: 2_000, limit: 2 });
    expect(first.map((r) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));
    const pages = [...first];
    for (let last = first.at(-1)!; ;) {
      const next = await n.feed({ sinceTs: last.ts, afterId: last.id, limit: 2 });
      pages.push(...next);
      if (next.length < 2) break;
      last = next.at(-1)!;
    }
    expect(pages.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(pages.at(-1)!.title).toBe('later');
  });
});
