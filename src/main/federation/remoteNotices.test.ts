import { describe, expect, it } from 'vitest';
import {
  createRemoteNotifier, CURSOR_IDS, CURSOR_OVERLAP_MS, FEED_LIMIT, MAX_PAGES, OVERLAP_PAGES, POLL_MS, remoteNoticeInput, REMOTE_LATE_MS, REMOTE_NOTICE_RATE,
  type FeedQuery, type NoticeCursor
} from './remoteNotices.js';
import type { RemoteNotice } from '../../preload/remoteAutomations.js';
import type { NotifyInput } from '../inbox/notifyService.js';

const O = '01JC0000000000000000000000';
const id = (i: number) => `01JC${String(i).padStart(22, '0')}`;
const n = (i: number, ts: number, over: Partial<RemoteNotice> = {}): RemoteNotice =>
  ({ id: id(i), ts, kind: 'post', title: `t${i}`, body: null, priority: 'normal', dedupeKey: null, ...over });

/** A host feed over `all` with the real keyset semantics, page cap FEED_LIMIT. */
const hostFeed = (all: () => RemoteNotice[], o: { ignoreAfterId?: boolean } = {}) => (q: FeedQuery): RemoteNotice[] => {
  const sorted = [...all()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  if (q.sinceTs === null) return sorted.slice(-FEED_LIMIT);
  const since = q.sinceTs;
  const rows = q.afterId !== undefined && !o.ignoreAfterId
    ? sorted.filter((x) => x.ts > since || (x.ts === since && x.id > q.afterId!))
    : sorted.filter((x) => x.ts >= since);
  return rows.slice(0, FEED_LIMIT);
};

function setup(feed: (q: FeedQuery) => RemoteNotice[], clock = { now: 10_000_000 }) {
  const sent: NotifyInput[] = [];
  const queries: FeedQuery[] = [];
  const cursors = new Map<string, NoticeCursor>();
  const forgotten: string[] = [];
  const errors: unknown[] = [];
  const pulls = { n: 0 };
  const r = createRemoteNotifier({
    fetch: async (_o, q) => {
      queries.push(q);
      if (queries.length > 1_000) throw new Error('runaway pull');
      return feed(q);
    },
    name: () => 'review-bot',
    request: async (x) => { sent.push(x); },
    getCursor: async (o) => { pulls.n++; return cursors.get(o) ?? null; },
    setCursor: async (o, c) => { cursors.set(o, { ts: c.ts, id: c.id, ids: [...c.ids], floor: c.floor }); },
    cursorOrigins: async () => [...cursors.keys()],
    forget: async (o) => { forgotten.push(o); cursors.delete(o); },
    now: () => clock.now,
    schedule: (fn) => { void Promise.resolve().then(fn); return () => undefined; },
    onError: (e) => errors.push(e)
  });
  return { r, sent, queries, cursors, forgotten, clock, errors, pulls };
}
const flush = () => new Promise((res) => setTimeout(res, 20));

describe('remote notices', () => {
  it('maps to the local policy: workspace source, host key kept, tags dropped, name prefixed, plain body', () => {
    const x = remoteNoticeInput(n(1, 5, { kind: 'run-failed', title: 'nightly failed', body: 'exit 1', priority: 'high', dedupeKey: 'nightly' }), O, 'review-bot', null);
    expect(x).toEqual({
      kind: 'run-failed', title: 'review-bot · nightly failed', body: 'exit 1', priority: 'high',
      source: { kind: 'workspace', id: O }, todoId: null, workspaceId: O, dedupeKey: 'nightly', tags: []
    });
    expect(remoteNoticeInput(n(1, 5), O, 'r', 'remote-rate').forceHold).toBe('remote-rate');
  });

  it('first contact seeds the cursor from the newest notices and notifies nothing', async () => {
    const { r, sent, cursors, queries } = setup((q) => (q.sinceTs === null ? [n(1, 100), n(2, 200)] : []));
    r.hint(O);
    await flush();
    expect(sent).toEqual([]);
    expect(queries).toEqual([{ sinceTs: null }]);
    expect(cursors.get(O)).toEqual({ ts: 200, id: id(2), ids: [id(1), id(2)], floor: null });
  });

  it('first contact with an empty host seeds ts 0 (host time, never this clock)', async () => {
    const { r, cursors } = setup(() => []);
    r.hint(O);
    await flush();
    expect(cursors.get(O)).toEqual({ ts: 0, id: '', ids: [], floor: null });
  });

  it('later notices are requested once each, re-reading the overlap window', async () => {
    const all = [n(1, 100), n(2, 200), n(3, 201)];
    const { r, sent, cursors, queries } = setup(hostFeed(() => all));
    cursors.set(O, { ts: 200, id: id(2), ids: [id(1), id(2)], floor: null });
    r.hint(O);
    await flush();
    r.hint(O);
    await flush();
    expect(sent.map((s) => s.title)).toEqual(['review-bot · t3']);
    expect(queries[0]).toEqual({ sinceTs: 0 });
    expect(queries[1]).toEqual({ sinceTs: Math.max(0, 201 - CURSOR_OVERLAP_MS) });
  });

  it('a notice committed late with an older ts inside the overlap is still delivered (never skipped)', async () => {
    const all = [n(1, 50_000), n(3, 60_000)];
    const { r, sent, cursors } = setup(hostFeed(() => all));
    cursors.set(O, { ts: 60_000, id: id(3), ids: [id(1), id(3)], floor: null });
    all.push(n(2, 60_000 - CURSOR_OVERLAP_MS + 1));
    r.hint(O);
    await flush();
    expect(sent.map((s) => s.title)).toEqual(['review-bot · t2']);
    expect(cursors.get(O)).toMatchObject({ ts: 60_000, id: id(3) });
  });

  it('a full page of one ts, all already seen, does not stall: it pages on by (ts, id)', async () => {
    const T = 9_000_000;
    const same = Array.from({ length: FEED_LIMIT + 30 }, (_, i) => n(i + 1, T));
    const { r, sent, cursors, queries } = setup(hostFeed(() => same));
    cursors.set(O, { ts: T, id: id(FEED_LIMIT), ids: same.slice(0, FEED_LIMIT).map((x) => x.id), floor: null });
    r.hint(O);
    await flush();
    expect(sent).toHaveLength(30);
    expect(new Set(sent.map((s) => s.title)).size).toBe(30);
    expect(queries[1]).toEqual({ sinceTs: T, afterId: id(FEED_LIMIT) });
    expect(queries).toHaveLength(2);
    expect(cursors.get(O)).toMatchObject({ ts: T, id: id(FEED_LIMIT + 30) });
    r.hint(O);
    await flush();
    expect(sent).toHaveLength(30);
  });

  it('a host that ignores afterId ends the pull instead of looping', async () => {
    const T = 9_000_000;
    const same = Array.from({ length: FEED_LIMIT + 5 }, (_, i) => n(i + 1, T));
    const { r, queries, cursors } = setup(hostFeed(() => same, { ignoreAfterId: true }));
    cursors.set(O, { ts: T, id: id(FEED_LIMIT), ids: same.slice(0, FEED_LIMIT).map((x) => x.id), floor: null });
    r.hint(O);
    await flush();
    expect(queries).toHaveLength(2);
  });

  it(`stops after ${MAX_PAGES} pages and continues on the next pull`, async () => {
    const many = Array.from({ length: FEED_LIMIT * (MAX_PAGES + 1) + 3 }, (_, i) => n(i + 1, 9_000_000 + i));
    const clock = { now: 9_000_000 };
    const { r, sent, cursors, queries, pulls } = setup(hostFeed(() => many), clock);
    cursors.set(O, { ts: 0, id: '', ids: [], floor: null });
    r.hint(O);
    await flush();
    await flush();
    expect(queries.length).toBeGreaterThan(MAX_PAGES);
    expect(pulls.n).toBe(2);
    expect(sent).toHaveLength(many.length);
    expect(new Set(sent.map((s) => s.title)).size).toBe(many.length);
  });

  it(`holds past ${REMOTE_NOTICE_RATE} a minute and holds late notices`, async () => {
    const clock = { now: 10_000_000 };
    const burst = Array.from({ length: REMOTE_NOTICE_RATE + 2 }, (_, i) => n(i + 1, clock.now - 1_000 + i));
    const { r, sent, cursors } = setup(hostFeed(() => [n(90, clock.now - REMOTE_LATE_MS - 1), ...burst]), clock);
    cursors.set(O, { ts: 0, id: '', ids: [], floor: null });
    r.hint(O);
    await flush();
    expect(sent[0].forceHold).toBe('remote-late');
    expect(sent.filter((s) => !s.forceHold)).toHaveLength(REMOTE_NOTICE_RATE);
    expect(sent.filter((s) => s.forceHold === 'remote-rate')).toHaveLength(2);
  });

  it('an unavailable host sends nothing and keeps the cursor; a forgotten bookmark is cleaned up', async () => {
    const { r, sent, cursors, forgotten } = setup(() => { throw new Error('down'); });
    cursors.set(O, { ts: 5, id: '', ids: [], floor: null });
    r.hint(O);
    await flush();
    expect(sent).toEqual([]);
    expect(cursors.get(O)).toEqual({ ts: 5, id: '', ids: [], floor: null });
    r.sync([]);
    await flush();
    expect(forgotten).toEqual([O]);
  });

  it('sync keeps bookmarked origins and polls one not pulled for a while', async () => {
    const clock = { now: 10_000_000 };
    const { r, cursors, forgotten, queries } = setup(() => [], clock);
    cursors.set(O, { ts: 5, id: '', ids: [], floor: null });
    r.sync([O]);
    await flush();
    expect(forgotten).toEqual([]);
    expect(queries).toHaveLength(1);
    r.sync([O]);
    await flush();
    expect(queries).toHaveLength(1);
    clock.now += POLL_MS;
    r.sync([O]);
    await flush();
    expect(queries).toHaveLength(2);
  });

  it(`remembers ${CURSOR_IDS} ids and never re-reads before the newest one it forgot`, async () => {
    const T = 9_000_000;
    const burst = Array.from({ length: CURSOR_IDS + 100 }, (_, i) => n(i + 1, T + Math.floor(i / 10)));
    const all = [...burst];
    const { r, sent, cursors, queries } = setup(hostFeed(() => all), { now: T });
    cursors.set(O, { ts: T - 1, id: '', ids: [], floor: null });
    r.hint(O);
    await flush();
    expect(sent).toHaveLength(burst.length);
    const c = cursors.get(O)!;
    expect(c.ids).toEqual(burst.slice(-CURSOR_IDS).map((x) => x.id));
    expect(c.floor).toEqual({ ts: burst[99].ts, id: burst[99].id });
    all.push(n(5000, c.ts + 1));
    queries.length = 0;
    r.hint(O);
    await flush();
    expect(sent.slice(burst.length).map((x) => x.title)).toEqual(['review-bot · t5000']);
    expect(queries[0]).toEqual({ sinceTs: burst[99].ts, afterId: burst[99].id });
    expect(queries.length).toBeLessThanOrEqual(OVERLAP_PAGES + 1);
  });

  it('stop cancels pending pulls', async () => {
    const { r, queries } = setup(() => []);
    r.stop();
    r.hint(O);
    await flush();
    expect(queries).toEqual([]);
  });
});

describe('wiring', () => {
  it('the inbox services feed the notifier into the notify service only, and stop it on teardown', async () => {
    const { readFileSync } = await import('node:fs');
    const index = readFileSync('src/main/index.ts', 'utf8');
    expect(index).toMatch(/request: \(n\) => svc\.request\(n\),/);
    expect(index).toMatch(/reader\.one\(origin, 'notices:feed', \[\{ \.\.\.q, limit: 100 \}\], \(v\) => parseNoticeRows\(v\)\)/);
    expect(index).toMatch(/inboxTeardown\.push\(\(\) => \{ notifier\.stop\(\); setRemoteNoticeSink\(null\); \}\);/);
    const ipc = readFileSync('src/main/ipc.ts', 'utf8');
    expect(ipc).toMatch(/if \(channel === 'notices:changed'\) remoteNoticeSink\?\.hint\(origin\);/);
    expect(ipc).toMatch(/remoteNoticeSink\?\.sync\(ms\.filter\(\(m\) => m\.kind === 'remote'\)\.map\(\(m\) => m\.id\)\)/);
  });
});
