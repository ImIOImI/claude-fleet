import { describe, expect, it } from 'vitest';
import { ftsQuery, rrf, suggestTopics } from './claimRank.js';

describe('ftsQuery', () => {
  it('quotes tokens and ORs them, keeping #, _ . and -', () => {
    expect(ftsQuery('why did #476 freeze buildSnapshot?')).toBe('"why" OR "did" OR "#476" OR "freeze" OR "buildSnapshot"');
  });
  it('returns null for punctuation-only input', () => {
    expect(ftsQuery('?? !!')).toBeNull();
  });
  it('strips embedded quotes', () => {
    expect(ftsQuery('a"b')).toBe('"ab"');
  });
});

describe('rrf', () => {
  it('fuses rank lists, favouring items high in both', () => {
    expect(rrf([['a', 'b', 'c'], ['b', 'c', 'd']])).toEqual(['b', 'c', 'a', 'd']);
  });
  it('handles an empty list', () => {
    expect(rrf([[], ['x']])).toEqual(['x']);
  });
});

describe('suggestTopics', () => {
  it('ranks neighbour topics by frequency, excluding given ones', () => {
    const n = [{ topics: ['state-db', 'mcp-query'] }, { topics: ['state-db'] }, { topics: ['perf'] }];
    expect(suggestTopics(n, ['mcp-query'], 2)).toEqual(['state-db', 'perf']);
  });
});
