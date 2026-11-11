import { describe, it, expect } from 'vitest';
import { mergeSessionPages, type RemoteSessionsResult } from '../../preload/federation';
import type { SessionListItem } from '../../preload';
import {
  sessionsForScope,
  filterSessions,
  partitionByOpen,
  orderByRecencyBucket,
  splitHeadless,
  splitCapture,
  tagCounts,
  limitSessions,
  canResumeHere,
  isRemoteRow,
  loadedMoreRemote,
  mergeUnavailable,
  refreshedRemote,
  reloadedRemote,
  remoteForScope,
  remoteNamesMap,
  remoteResumeMap,
  searchTargets,
  searchUnavailableText,
  unavailableText,
  withRemote,
  publishTargetsMap
} from './sessionsView';

// Minimal session shape — only what the scope logic touches.
const S = (id: string, workspaceId: string): { id: string; workspaceId: string } => ({
  id,
  workspaceId
});

// Three sessions across TWO workspaces — the live-workspace count (2) and the
// session count (3) differ, which is exactly the #149 confusion.
const ALL = [S('a1', 'wsA'), S('a2', 'wsA'), S('b1', 'wsB')];

describe('sessionsForScope', () => {
  // #149: the "All · N" badge counts the All view's rows. With 3 sessions in 2
  // workspaces, All must surface 3 sessions — a SESSION count, not a workspace count.
  it('All scope returns every session (the badge count is sessions, not workspaces)', () => {
    const all = sessionsForScope(ALL, 'all', null);
    expect(all).toHaveLength(3);
    expect(all.map((s) => s.id)).toEqual(['a1', 'a2', 'b1']);
  });

  it('workspace scope returns only the selected workspace’s sessions', () => {
    expect(sessionsForScope(ALL, 'workspace', 'wsA').map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(sessionsForScope(ALL, 'workspace', 'wsB').map((s) => s.id)).toEqual(['b1']);
  });

  it('workspace scope with nothing selected shows no sessions', () => {
    expect(sessionsForScope(ALL, 'workspace', null)).toEqual([]);
  });

  it('does not mutate or alias the input list in All scope', () => {
    const all = sessionsForScope(ALL, 'all', null);
    expect(all).not.toBe(ALL);
  });
});

const sess = (over: Partial<{
  id: string; workspaceId: string; workspaceName: string; tags: string[];
  userSetName: string | null; aiTitle: string | null; firstUserMessage: string | null;
}> = {}) => ({
  id: 'id-1', workspaceId: 'ws-1', workspaceName: 'alpha', tags: [],
  userSetName: null, aiTitle: null, firstUserMessage: 'hello world',
  ...over
});

describe('filterSessions', () => {
  it('matches a session id exactly (a picked search hit)', () => {
    const items = [sess({ id: '0f3c-a', firstUserMessage: 'x' }), sess({ id: 'b', firstUserMessage: 'y' })];
    expect(filterSessions(items, items[0].id, [])).toEqual([items[0]]);
    expect(filterSessions(items, `  ${items[0].id} `, [])).toEqual([items[0]]);
    expect(filterSessions(items, '0F3C-A', [])).toEqual([]);
  });
  it('empty query + no tags returns everything', () => {
    const items = [sess({ id: 'a' }), sess({ id: 'b' })];
    expect(filterSessions(items, '', [])).toEqual(items);
  });
  it('matches title precedence field (userSetName > aiTitle > firstUserMessage)', () => {
    const items = [
      sess({ id: 'a', userSetName: 'Broker fix' }),
      sess({ id: 'b', aiTitle: 'MCP hang' }),
      sess({ id: 'c', firstUserMessage: 'loadout publish' })
    ];
    expect(filterSessions(items, 'broker', []).map((s) => s.id)).toEqual(['a']);
    expect(filterSessions(items, 'mcp', []).map((s) => s.id)).toEqual(['b']);
    expect(filterSessions(items, 'publish', []).map((s) => s.id)).toEqual(['c']);
  });
  it('matches workspace name and tag text via plain substring', () => {
    const items = [
      sess({ id: 'a', workspaceName: 'devops' }),
      sess({ id: 'b', tags: ['reconnect', 'broker'] })
    ];
    expect(filterSessions(items, 'devop', []).map((s) => s.id)).toEqual(['a']);
    expect(filterSessions(items, 'reconn', []).map((s) => s.id)).toEqual(['b']);
  });
  it('activeTags require an exact tag, OR across tags, AND with the query', () => {
    const items = [
      sess({ id: 'a', tags: ['mcp'], firstUserMessage: 'one' }),
      sess({ id: 'b', tags: ['ci'], firstUserMessage: 'two' }),
      sess({ id: 'c', tags: ['mcp', 'ci'], firstUserMessage: 'three' })
    ];
    expect(filterSessions(items, '', ['mcp']).map((s) => s.id)).toEqual(['a', 'c']);
    expect(filterSessions(items, '', ['mcp', 'ci']).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(filterSessions(items, 'three', ['mcp']).map((s) => s.id)).toEqual(['c']);
  });
});

describe('splitHeadless', () => {
  it('moves automation runs out, preserving order on both sides', () => {
    const rows = [
      { id: 'a', headless: false },
      { id: 'r1', headless: true },
      { id: 'b' },
      { id: 'r2', headless: true }
    ];
    const { headless, rest } = splitHeadless(rows);
    expect(headless.map((s) => s.id)).toEqual(['r1', 'r2']);
    expect(rest.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('splitCapture', () => {
  it('moves capture forks out, preserving order', () => {
    const rows = [{ id: 'a' }, { id: 'f1', capture: true }, { id: 'b', capture: false }, { id: 'f2', capture: true }];
    const { capture, rest } = splitCapture(rows);
    expect(capture.map((s) => s.id)).toEqual(['f1', 'f2']);
    expect(rest.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('orderByRecencyBucket', () => {
  const B = 30 * 60_000;
  const row = (id: string, lastActiveAt: number | null, startedAt: number | null = 0) => ({ id, lastActiveAt, startedAt });

  it('puts newer buckets first', () => {
    const rows = [row('old', 1 * B), row('new', 3 * B + 5), row('mid', 2 * B)];
    expect(orderByRecencyBucket(rows, B).map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('ignores activity within a bucket — orders by start time instead', () => {
    const a = row('a', 4 * B + 10, 100);
    const b = row('b', 4 * B + 20, 200);
    expect(orderByRecencyBucket([a, b], B).map((s) => s.id)).toEqual(['b', 'a']);
    const aBusier = { ...a, lastActiveAt: 4 * B + 999 };
    expect(orderByRecencyBucket([aBusier, b], B).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('is independent of input order', () => {
    const rows = [row('x', B, 1), row('y', B, 1), row('z', 2 * B, 1)];
    const a = orderByRecencyBucket(rows, B).map((s) => s.id);
    const b = orderByRecencyBucket([...rows].reverse(), B).map((s) => s.id);
    expect(a).toEqual(['z', 'x', 'y']);
    expect(b).toEqual(a);
  });

  it('sinks rows with no activity', () => {
    const rows = [row('none', null), row('some', B)];
    expect(orderByRecencyBucket(rows, B).map((s) => s.id)).toEqual(['some', 'none']);
  });
});

describe('partitionByOpen', () => {
  it('splits preserving input order in both groups', () => {
    const items = [sess({ id: 'a' }), sess({ id: 'b' }), sess({ id: 'c' })];
    const { open, recent } = partitionByOpen(items, new Set(['c', 'a']));
    expect(open.map((s) => s.id)).toEqual(['a', 'c']);
    expect(recent.map((s) => s.id)).toEqual(['b']);
  });
  it('empty open set puts everything in recent', () => {
    const { open, recent } = partitionByOpen([sess({ id: 'a' })], new Set());
    expect(open).toEqual([]);
    expect(recent.map((s) => s.id)).toEqual(['a']);
  });
});

describe('tagCounts', () => {
  it('counts across sessions, sorted by count desc then alphabetically', () => {
    const items = [
      { tags: ['mcp', 'ci'] },
      { tags: ['mcp'] },
      { tags: ['broker'] }
    ];
    expect(tagCounts(items)).toEqual([['mcp', 2], ['broker', 1], ['ci', 1]]);
  });
  it('empty input gives empty output', () => {
    expect(tagCounts([])).toEqual([]);
  });
});

describe('limitSessions', () => {
  const DAY = 86_400_000;
  const NOW = 1_754_000_000_000;
  const row = (id: string, ageDays: number | null): { id: string; lastActiveAt: number | null } => ({
    id,
    lastActiveAt: ageDays === null ? null : NOW - ageDays * DAY
  });
  // last-active-descending, matching db.ts listSessions ordering.
  const ROWS = [row('a', 0), row('b', 2), row('c', 10), row('d', 40), row('e', null)];

  it('0/0 is a passthrough (unlimited), without aliasing the input', () => {
    const out = limitSessions(ROWS, { maxCount: 0, maxAgeDays: 0 }, NOW);
    expect(out).toEqual(ROWS);
    expect(out).not.toBe(ROWS);
  });

  it('age filter drops older rows; exactly at the boundary stays', () => {
    const boundary = [row('x', 7), row('y', 7.00001)];
    const out = limitSessions(boundary, { maxCount: 0, maxAgeDays: 7 }, NOW);
    expect(out.map((s) => s.id)).toEqual(['x']);
  });

  it('null lastActiveAt passes the age filter (age unknown ⇒ keep)', () => {
    const out = limitSessions(ROWS, { maxCount: 0, maxAgeDays: 7 }, NOW);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'e']);
  });

  it('count cap keeps the newest N (input order is last-active-descending)', () => {
    const out = limitSessions(ROWS, { maxCount: 2, maxAgeDays: 0 }, NOW);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('applies age first, then the cap', () => {
    const out = limitSessions(ROWS, { maxCount: 2, maxAgeDays: 30 }, NOW);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']); // d(40d) already gone before capping
  });
});

describe('withRemote', () => {
  const item = (id: string, la: number, ws: string, origin?: string) =>
    ({ id, workspaceId: ws, lastActiveAt: la, origin } as unknown as SessionListItem);
  it('returns the local array untouched with no remote rows', () => {
    const local = [item('a', 2, 'L')];
    expect(withRemote(local, null)).toBe(local);
    expect(withRemote(local, { rows: [], more: [] })).toBe(local);
  });
  it('interleaves by recency and tags local rows', () => {
    const remote = mergeSessionPages([{ origin: 'R', rows: [item('r', 3, 'R')], next: null }]);
    const out = withRemote([item('a', 4, 'L'), item('b', 2, 'L')], remote);
    expect(out.map((s) => `${s.origin}:${s.id}`)).toEqual(['local:a', 'R:r', 'local:b']);
    expect(out.map(isRemoteRow)).toEqual([false, true, false]);
  });
  it('names unavailable sources', () => {
    expect(unavailableText([])).toBeNull();
    expect(unavailableText([{ origin: 'R', name: 'review-bot', reason: 'unreachable' }])).toBe('1 source unavailable: review-bot');
    expect(unavailableText([{ origin: 'R', name: 'a', reason: 'timeout' }, { origin: 'S', name: 'b', reason: 'forbidden' }])).toBe('2 sources unavailable: a, b');
  });
});

describe('remote page state', () => {
  const item = (id: string, la: number, ws: string) =>
    ({ id, workspaceId: ws, lastActiveAt: la } as unknown as SessionListItem);
  const res = (pages: RemoteSessionsResult<SessionListItem>['pages'], unavailable: RemoteSessionsResult<SessionListItem>['unavailable'] = []) =>
    ({ pages, unavailable });
  const keys = (m: { rows: SessionListItem[] } | null) => (m ? m.rows.map((s) => `${s.origin}:${s.id}`) : null);

  it('load more then refresh keeps a dedup-shadowed row recoverable', () => {
    // 'x' (workspace W) comes from both R and S; R wins the dedup, S's copy is shadowed.
    let cur = mergeSessionPages([
      { origin: 'R', rows: [item('r1', 9, 'W'), item('x', 5, 'W')], next: null },
      { origin: 'S', rows: [item('s1', 8, 'W')], next: { lastActiveAt: 8, id: 's1' } }
    ]);
    cur = loadedMoreRemote(cur, res([{ origin: 'S', rows: [item('x', 5, 'W'), item('s2', 1, 'W')], next: null }]), 'S', { lastActiveAt: 8, id: 's1' })!;
    expect(keys(cur)).toEqual(['R:r1', 'S:s1', 'R:x', 'S:s2']);
    expect(cur.more).toEqual([]);
    // R's fresh first page no longer holds 'x': S's shadowed copy must surface.
    cur = refreshedRemote(cur, res([{ origin: 'R', rows: [item('r1', 9, 'W')], next: null }]), 'R')!;
    expect(keys(cur)).toEqual(['R:r1', 'S:s1', 'S:x', 'S:s2']);
  });

  it('a local row shadows a remote one only while it exists', () => {
    const remote = mergeSessionPages([{ origin: 'R', rows: [item('x', 5, 'W')], next: null }]);
    expect(withRemote([item('x', 5, 'W')], remote).map((s) => s.origin)).toEqual(['local']);
    expect(withRemote([], remote).map((s) => s.origin)).toEqual(['R']);
  });

  it('refresh drops an origin that is now unavailable or gone', () => {
    const cur = mergeSessionPages([
      { origin: 'R', rows: [item('r1', 9, 'R')], next: null },
      { origin: 'S', rows: [item('s1', 8, 'S')], next: null }
    ]);
    expect(keys(refreshedRemote(cur, res([], [{ origin: 'R', name: 'r', reason: 'timeout' }]), 'R'))).toEqual(['S:s1']);
    expect(refreshedRemote(mergeSessionPages([{ origin: 'R', rows: [item('r1', 9, 'R')], next: null }]), res([]), 'R')).toBeNull();
    expect(keys(refreshedRemote(null, res([{ origin: 'R', rows: [item('r1', 9, 'R')], next: null }]), 'R'))).toEqual(['R:r1']);
  });

  it('dropping the winning origin surfaces the shadowed copy', () => {
    const cur = mergeSessionPages([
      { origin: 'R', rows: [item('x', 5, 'W')], next: null },
      { origin: 'S', rows: [item('x', 5, 'W')], next: null }
    ]);
    expect(keys(cur)).toEqual(['R:x']);
    expect(keys(refreshedRemote(cur, res([], [{ origin: 'R', name: 'r', reason: 'timeout' }]), 'R'))).toEqual(['S:x']);
  });

  it('load more ignores a stale cursor and drops a source that failed', () => {
    const cur = mergeSessionPages([{ origin: 'R', rows: [item('r1', 9, 'R')], next: { lastActiveAt: 9, id: 'r1' } }]);
    const page = res([{ origin: 'R', rows: [item('r2', 3, 'R')], next: null }]);
    expect(loadedMoreRemote(cur, page, 'R', { lastActiveAt: 7, id: 'zz' })).toBe(cur);
    expect(loadedMoreRemote(null, page, 'R', { lastActiveAt: 9, id: 'r1' })).toBeNull();
    expect(loadedMoreRemote(cur, null, 'R', { lastActiveAt: 9, id: 'r1' })).toBe(cur);
    expect(loadedMoreRemote(cur, res([], [{ origin: 'R', name: 'r', reason: 'timeout' }]), 'R', { lastActiveAt: 9, id: 'r1' })).toBeNull();
  });

  const olderLoaded = () => {
    const cur = mergeSessionPages([
      { origin: 'R', rows: [item('a', 9, 'R'), item('b', 8, 'R')], next: { lastActiveAt: 8, id: 'b' } },
      { origin: 'S', rows: [item('s1', 7, 'S')], next: { lastActiveAt: 7, id: 's1' } }
    ]);
    return loadedMoreRemote(cur, res([{ origin: 'R', rows: [item('c', 6, 'R'), item('d', 5, 'R')], next: { lastActiveAt: 5, id: 'd' } }]), 'R', { lastActiveAt: 8, id: 'b' })!;
  };

  it('a refresh keeps the older pages loaded from its origin', () => {
    const cur = refreshedRemote(olderLoaded(), res([{ origin: 'R', rows: [item('n', 10, 'R'), item('a', 9, 'R')], next: { lastActiveAt: 9, id: 'a' } }]), 'R')!;
    expect(keys(cur)).toEqual(['R:n', 'R:a', 'R:b', 'S:s1', 'R:c', 'R:d']);
    expect(cur.more).toEqual([
      { origin: 'R', after: { lastActiveAt: 5, id: 'd' } },
      { origin: 'S', after: { lastActiveAt: 7, id: 's1' } }
    ]);
  });

  it('a refresh shows a row that moved up once, with fresh data', () => {
    const moved = { ...item('c', 11, 'R'), aiTitle: 'fresh' } as SessionListItem;
    const cur = refreshedRemote(olderLoaded(), res([{ origin: 'R', rows: [moved, item('a', 9, 'R')], next: { lastActiveAt: 9, id: 'a' } }]), 'R')!;
    expect(keys(cur)).toEqual(['R:c', 'R:a', 'R:b', 'S:s1', 'R:d']);
    expect(cur.rows[0].aiTitle).toBe('fresh');
  });

  it('a full reload keeps each origin\'s older pages and drops origins it no longer returns', () => {
    const r = res([
      { origin: 'R', rows: [item('n', 10, 'R'), item('a', 9, 'R')], next: { lastActiveAt: 9, id: 'a' } },
      { origin: 'T', rows: [item('t1', 4, 'T')], next: null }
    ], [{ origin: 'S', name: 's', reason: 'timeout' }]);
    const cur = reloadedRemote(olderLoaded(), r)!;
    expect(keys(cur)).toEqual(['R:n', 'R:a', 'R:b', 'R:c', 'R:d', 'T:t1']);
    expect(cur.more).toEqual([{ origin: 'R', after: { lastActiveAt: 5, id: 'd' } }]);
    expect(reloadedRemote(olderLoaded(), res([]))).toBeNull();
    expect(keys(reloadedRemote(null, res([{ origin: 'T', rows: [item('t1', 4, 'T')], next: null }])))).toEqual(['T:t1']);
  });

  it('remoteForScope keeps only the selected workspace\'s origin under "This workspace"', () => {
    const xs = [{ origin: 'R' }, { origin: 'S' }];
    expect(remoteForScope(xs, 'all', 'R')).toEqual(xs);
    expect(remoteForScope(xs, 'workspace', 'R')).toEqual([{ origin: 'R' }]);
    expect(remoteForScope(xs, 'workspace', 'L')).toEqual([]);
    expect(remoteForScope(xs, 'workspace', null)).toEqual([]);
  });

  it('mergeUnavailable replaces only the asked origin', () => {
    const u = [{ origin: 'R', name: 'r', reason: 'timeout' as const }, { origin: 'S', name: 's', reason: 'timeout' as const }];
    expect(mergeUnavailable(u, res([]), 'R')).toEqual([u[1]]);
    expect(mergeUnavailable(u, res([], [{ origin: 'R', name: 'r', reason: 'forbidden' }]), 'R').map((x) => `${x.origin}:${x.reason}`)).toEqual(['S:timeout', 'R:forbidden']);
    const both = res([], [{ origin: 'R', name: 'r', reason: 'forbidden' }, { origin: 'S', name: 's', reason: 'standby' }]);
    expect(mergeUnavailable(u, both, 'R').map((x) => `${x.origin}:${x.reason}`)).toEqual(['S:timeout', 'R:forbidden']);
  });
});

describe('remote resume gating', () => {
  const ws = (id: string, kind: string, state: string, tier?: string | null) =>
    ({ id, kind, state, ...(tier !== undefined ? { remote: { tier } } : {}) });
  const row = (workspaceId: string, origin?: string) => ({ id: 's', workspaceId, origin } as unknown as SessionListItem);
  const map = remoteResumeMap([
    ws('L', 'container', 'stopped'),
    ws('A', 'remote', 'running', 'session'),
    ws('B', 'remote', 'running', 'steer'),
    ws('C', 'remote', 'unreachable', 'session'),
    ws('D', 'remote', 'running', null)
  ]);

  it('maps only remote bookmarks', () => {
    expect(Object.keys(map).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('local rows always resume; remote rows need session tier and a running host', () => {
    expect(canResumeHere(row('L', 'local'), map)).toBe(true);
    expect(canResumeHere(row('L'), map)).toBe(true);
    expect(canResumeHere(row('A', 'A'), map)).toBe(true);
    expect(canResumeHere(row('B', 'B'), map)).toBe(false);
    expect(canResumeHere(row('C', 'C'), map)).toBe(false);
    expect(canResumeHere(row('D', 'D'), map)).toBe(false);
    expect(canResumeHere(row('Z', 'Z'), map)).toBe(false);
    expect(canResumeHere(row('A', 'A'), undefined)).toBe(false);
  });
});

describe('searchTargets', () => {
  const names = { R1: 'review-bot', R2: 'triage' };
  it('names who receives the query', () => {
    expect(searchTargets('all', null, names, () => false)).toEqual({ scope: 'all', label: 'Searching this desktop + review-bot, triage' });
    expect(searchTargets('workspace', 'R1', names, () => false)).toEqual({ scope: 'R1', label: 'Searching review-bot' });
    expect(searchTargets('workspace', 'L1', names, (id) => id === 'L1')).toEqual({ scope: 'L1', label: 'Searching this desktop' });
    expect(searchTargets('workspace', null, names, () => false)).toBeNull();
  });
  it('with no remotes, All searches only this desktop', () => {
    expect(searchTargets('all', 'R1', {}, () => true)).toEqual({ scope: 'all', label: 'Searching this desktop' });
  });
});

describe('searchUnavailableText', () => {
  it('says why a host left the search', () => {
    expect(searchUnavailableText([])).toBeNull();
    expect(searchUnavailableText([{ origin: 'R', name: 'review-bot', reason: 'disabled' }, { origin: 'S', name: 'triage', reason: 'model' }, { origin: 'T', name: 'x', reason: 'timeout' }]))
      .toBe('3 sources unavailable: review-bot (search off), triage (different model), x');
    expect(searchUnavailableText([{ origin: 'R', name: 'review-bot', reason: 'unreachable' }])).toBe('1 source unavailable: review-bot');
  });
});

describe('remoteNamesMap', () => {
  it('names remote bookmarks only', () => {
    expect(remoteNamesMap([{ id: 'R1', kind: 'remote', name: 'review-bot' }, { id: 'L1', kind: 'local', name: 'mine' }, { id: 'D1', kind: 'docker', name: 'c' }]))
      .toEqual({ R1: 'review-bot' });
  });
});

describe('publishTargetsMap', () => {
  it('maps publishing workspaces to their hosts’ names', () => {
    expect(publishTargetsMap([
      { id: 'R', kind: 'remote', name: 'review-bot' },
      { id: 'L', kind: 'local', name: 'mine', publish: { to: ['R', 'gone'], since: { R: 1, gone: 1 } } },
      { id: 'C', kind: 'container', name: 'quiet' }
    ])).toEqual({ L: ['review-bot', 'gone'] });
  });
});
