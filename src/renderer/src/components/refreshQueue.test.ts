import { describe, it, expect } from 'vitest';
import { readyToRefresh } from './refreshQueue';

const S = (...ids: string[]): Set<string> => new Set(ids);

describe('readyToRefresh', () => {
  it('returns idle, existing, non-ended pending ids', () => {
    expect(readyToRefresh(S('a', 'b'), S(), S(), S('a', 'b'))).toEqual(['a', 'b']);
  });
  it('defers ids whose session is busy', () => {
    expect(readyToRefresh(S('a', 'b'), S('a'), S(), S('a', 'b'))).toEqual(['b']);
  });
  it('skips ended sessions', () => {
    expect(readyToRefresh(S('a'), S(), S('a'), S('a'))).toEqual([]);
  });
  it('skips ids that no longer exist (tab closed while pending)', () => {
    expect(readyToRefresh(S('a'), S(), S(), S('b'))).toEqual([]);
  });
  it('returns empty for an empty queue', () => {
    expect(readyToRefresh(S(), S(), S(), S('a'))).toEqual([]);
  });
});
