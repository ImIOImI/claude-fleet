import { describe, it, expect } from 'vitest';
import { busyClaudeIdSet, openSessionMap } from './busySessions';

// The chip/tab busy signal is keyed by *broker* session id, but the left-rail
// Sessions list is keyed by *claude* session UUID. This resolves the former to
// the latter using each workspace's learned broker→claude mapping, so only the
// genuinely-running session's row pulses.
describe('busyClaudeIdSet', () => {
  it('is empty when nothing is busy', () => {
    expect(busyClaudeIdSet({}, new Map())).toEqual(new Set());
  });

  it('maps a workspace\'s busy broker session to its claude session id', () => {
    const set = busyClaudeIdSet(
      { wsA: ['broker-1'] },
      new Map([['wsA', new Map([['broker-1', 'claude-uuid-1']])]])
    );
    expect(set).toEqual(new Set(['claude-uuid-1']));
  });

  it('unions across workspaces and sessions', () => {
    const set = busyClaudeIdSet(
      { wsA: ['b1', 'b2'], wsB: ['b3'] },
      new Map([
        ['wsA', new Map([['b1', 'c1'], ['b2', 'c2']])],
        ['wsB', new Map([['b3', 'c3']])]
      ])
    );
    expect(set).toEqual(new Set(['c1', 'c2', 'c3']));
  });

  it('skips broker sessions whose claude mapping is not yet known', () => {
    const set = busyClaudeIdSet(
      { wsA: ['b1', 'unmapped'] },
      new Map([['wsA', new Map([['b1', 'c1']])]])
    );
    expect(set).toEqual(new Set(['c1']));
  });

  it('skips a workspace with no mapping at all', () => {
    const set = busyClaudeIdSet({ wsA: ['b1'] }, new Map());
    expect(set).toEqual(new Set());
  });

  it('ignores idle workspaces (empty busy-id arrays)', () => {
    const set = busyClaudeIdSet(
      { wsA: [], wsB: ['b1'] },
      new Map([
        ['wsA', new Map([['x', 'cx']])],
        ['wsB', new Map([['b1', 'c1']])]
      ])
    );
    expect(set).toEqual(new Set(['c1']));
  });
});

describe('openSessionMap', () => {
  it('maps live broker ids to claude UUIDs with their tab ref', () => {
    const mappings = new Map([['ws1', new Map([['b1', 'claude-1'], ['b2', 'claude-2']])]]);
    const out = openSessionMap({ ws1: ['b1', 'b2'] }, mappings);
    expect(out.get('claude-1')).toEqual({ workspaceId: 'ws1', brokerSessionId: 'b1' });
    expect(out.get('claude-2')).toEqual({ workspaceId: 'ws1', brokerSessionId: 'b2' });
    expect(out.size).toBe(2);
  });
  it('skips broker ids with no learned mapping', () => {
    const mappings = new Map([['ws1', new Map([['b1', 'claude-1']])]]);
    const out = openSessionMap({ ws1: ['b1', 'b-unmapped'] }, mappings);
    expect(out.size).toBe(1);
  });
  it('skips workspaces with no mapping table at all', () => {
    expect(openSessionMap({ ws9: ['b1'] }, new Map()).size).toBe(0);
  });
});
