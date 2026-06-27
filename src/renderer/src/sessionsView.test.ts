import { describe, it, expect } from 'vitest';
import { sessionsForScope } from './sessionsView';

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
