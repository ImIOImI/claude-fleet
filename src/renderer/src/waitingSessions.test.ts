import { describe, it, expect } from 'vitest';
import { mergeWaitingSessionIds, waitingFlags } from './waitingSessions';

describe('mergeWaitingSessionIds', () => {
  it('unions across workspaces', () => {
    const byWorkspace = new Map([
      ['ws1', new Set(['claude-1', 'claude-2'])],
      ['ws2', new Set(['claude-3'])]
    ]);
    const result = mergeWaitingSessionIds(byWorkspace);
    expect(result).toEqual(new Set(['claude-1', 'claude-2', 'claude-3']));
  });

  it('dedupes ids that appear in multiple workspaces', () => {
    const byWorkspace = new Map([
      ['ws1', new Set(['claude-1'])],
      ['ws2', new Set(['claude-1', 'claude-2'])]
    ]);
    const result = mergeWaitingSessionIds(byWorkspace);
    expect(result.size).toBe(2);
    expect(result).toEqual(new Set(['claude-1', 'claude-2']));
  });

  it('empty map yields empty set', () => {
    const result = mergeWaitingSessionIds(new Map());
    expect(result.size).toBe(0);
  });
});

describe('waitingFlags', () => {
  it('workspace with non-empty set → flag true', () => {
    const byWorkspace = new Map([['ws1', new Set(['claude-1'])]]);
    const result = waitingFlags(byWorkspace);
    expect(result['ws1']).toBe(true);
  });

  it('workspace with empty set → flag false', () => {
    const byWorkspace = new Map([['ws1', new Set<string>()]]);
    const result = waitingFlags(byWorkspace);
    expect(result['ws1']).toBe(false);
  });

  it('empty map yields empty record', () => {
    const result = waitingFlags(new Map());
    expect(Object.keys(result).length).toBe(0);
  });
});
