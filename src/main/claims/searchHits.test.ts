import { describe, expect, it } from 'vitest';
import { sessionIdsFromClaimResults, sessionIdsFromQueryRows, sessionIdsFromTranscriptHits } from './searchHits.js';

const U1 = '0d8e6c7a-1111-4222-8333-944445555666';

describe('search hit session extraction (#483 §5)', () => {
  it('transcript hits: distinct sessionIds in rank order', () => {
    expect(sessionIdsFromTranscriptHits([{ sessionId: 'b' }, { sessionId: 'a' }, { sessionId: 'b' }, { text: 'no id' }])).toEqual(['b', 'a']);
    expect(sessionIdsFromTranscriptHits(null)).toEqual([]);
  });
  it('claim results: the sessions behind each claim, in rank order', () => {
    const r = { results: [{ sources: [{ sessionId: null }, { sessionId: 's2' }] }, { sources: [{ sessionId: 's1' }, { sessionId: 's2' }] }] };
    expect(sessionIdsFromClaimResults(r)).toEqual(['s2', 's1']);
    expect(sessionIdsFromClaimResults({})).toEqual([]);
  });
  it('query rows: session_id-like columns, plus uuid-shaped id columns', () => {
    const rows = [{ session_id: 's1', n: 3 }, { sessionId: 's2' }, { claude_session_id: 's3' }, { id: U1 }, { id: 42 }, { id: 'not-a-uuid' }];
    expect(sessionIdsFromQueryRows(rows)).toEqual(['s1', 's2', 's3', U1]);
  });
});
