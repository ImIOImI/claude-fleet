import { describe, it, expect } from 'vitest';
import { sessionsForScope, filterSessions, partitionByOpen, tagCounts } from './sessionsView';

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
