import { describe, expect, it } from 'vitest';
import { findLiveHandleId } from './ptyHandleLookup.js';

// Maps are keyed by ptyHandleId, mirroring ipc.ts.
const wsMap = new Map<string, string>([
  ['h1', 'wsA'],
  ['h2', 'wsA'],
  ['h3', 'wsB']
]);
const brokerMap = new Map<string, string>([
  ['h1', 's1'],
  ['h2', 's2'],
  ['h3', 's1'] // same broker session id as h1 but in a different workspace
]);

describe('findLiveHandleId', () => {
  it('resolves the handle for a (workspace, broker session) pair', () => {
    expect(findLiveHandleId(wsMap, brokerMap, 'wsA', 's1')).toBe('h1');
    expect(findLiveHandleId(wsMap, brokerMap, 'wsA', 's2')).toBe('h2');
  });

  it('disambiguates by workspace when the broker session id collides', () => {
    // s1 exists in both wsA (h1) and wsB (h3) — must not cross workspaces.
    expect(findLiveHandleId(wsMap, brokerMap, 'wsB', 's1')).toBe('h3');
  });

  it('returns null when no live handle matches', () => {
    expect(findLiveHandleId(wsMap, brokerMap, 'wsA', 'nope')).toBeNull();
    expect(findLiveHandleId(wsMap, brokerMap, 'wsC', 's1')).toBeNull();
  });

  it('returns null on empty maps', () => {
    expect(findLiveHandleId(new Map(), new Map(), 'wsA', 's1')).toBeNull();
  });
});
