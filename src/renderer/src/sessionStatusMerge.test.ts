import { describe, expect, it } from 'vitest';
import {
  resolveBusyClaudeIds,
  resolveWaitingClaudeIds,
  resolveBusyByWorkspace,
  resolveWaitingByWorkspace,
  resolveTabBusy,
  type PeerKind
} from './sessionStatusMerge';

const peer = (entries: Array<[string, PeerKind]>) => new Map<string, PeerKind>(entries);

describe('resolveBusyClaudeIds', () => {
  it('peer busy wins; peer idle clears a stuck glyph (self-heal #283)', () => {
    const glyph = new Set(['stuck']); // glyph says busy but claude is done
    const out = resolveBusyClaudeIds(glyph, peer([['stuck', 'idle']]));
    expect(out.has('stuck')).toBe(false);
  });

  it('glyph governs sessions the peer has not reported', () => {
    const out = resolveBusyClaudeIds(new Set(['g']), peer([]));
    expect([...out]).toEqual(['g']);
  });

  it('peer adds a busy session the glyph missed', () => {
    const out = resolveBusyClaudeIds(new Set(), peer([['p', 'busy']]));
    expect(out.has('p')).toBe(true);
  });

  it('peer waiting is not busy', () => {
    expect(resolveBusyClaudeIds(new Set(['w']), peer([['w', 'waiting']])).has('w')).toBe(false);
  });
});

describe('resolveWaitingClaudeIds', () => {
  it('peer waiting extends the indicator beyond the hook', () => {
    expect(resolveWaitingClaudeIds(new Set(), peer([['p', 'waiting']])).has('p')).toBe(true);
  });

  it('peer idle clears a stale hook waiting entry', () => {
    expect(resolveWaitingClaudeIds(new Set(['h']), peer([['h', 'idle']])).has('h')).toBe(false);
  });

  it('hook governs sessions the peer has not reported', () => {
    expect(resolveWaitingClaudeIds(new Set(['h']), peer([])).has('h')).toBe(true);
  });
});

describe('resolveBusyByWorkspace', () => {
  const mappings = new Map([['wsA', new Map([['b1', 'c1'], ['b2', 'c2']])]]);

  it('clears a stale glyph chip when the peer says the mapped session is idle', () => {
    // glyph reports b1 busy (stuck); peer knows c1 idle → chip clears.
    const out = resolveBusyByWorkspace({ wsA: ['b1'] }, mappings, peer([['c1', 'idle']]));
    expect(out.wsA).toBe(false);
  });

  it('keeps the chip lit for a busy session the peer has not mapped yet', () => {
    // b3 has no mapping → glyph still governs it.
    const out = resolveBusyByWorkspace({ wsA: ['b3'] }, mappings, peer([['c1', 'idle']]));
    expect(out.wsA).toBe(true);
  });

  it('lights the chip from a peer-busy session with no glyph', () => {
    const out = resolveBusyByWorkspace({}, mappings, peer([['c2', 'busy']]));
    expect(out.wsA).toBe(true);
  });

  it('no peer info → falls back to the glyph chip', () => {
    expect(resolveBusyByWorkspace({ wsA: ['b1'] }, mappings, peer([])).wsA).toBe(true);
    expect(resolveBusyByWorkspace({ wsA: [] }, mappings, peer([])).wsA).toBe(false);
  });
});

describe('resolveTabBusy', () => {
  it('uses the peer-reconciled set once the broker→claude mapping is resolved', () => {
    // Mapping known (b1→c1); reconciled set says c1 busy → tab dot busy.
    expect(resolveTabBusy('c1', 'b1', new Set(['c1']), new Set())).toBe(true);
  });

  it('clears a stuck glyph the peer reconciled away (self-heal #283)', () => {
    // Glyph stuck busy on b1, but reconciled set (peer idle) omits c1 → not busy.
    expect(resolveTabBusy('c1', 'b1', new Set(), new Set(['b1']))).toBe(false);
  });

  it('falls back to the raw glyph while the broker→claude mapping is unresolved', () => {
    // claudeId not yet known → glyph (keyed by broker id) governs.
    expect(resolveTabBusy(undefined, 'b1', new Set(), new Set(['b1']))).toBe(true);
    expect(resolveTabBusy(undefined, 'b1', new Set(), new Set())).toBe(false);
  });

  it('agrees with the workspace chip and Sessions list for one session (#371)', () => {
    // Same underlying state: broker b1 → claude c1, glyph stuck busy, peer idle.
    const mappings = new Map([['wsA', new Map([['b1', 'c1']])]]);
    const p = peer([['c1', 'idle']]);
    // Sessions list source of truth (claude-keyed glyph = {c1} because mapping known).
    const list = resolveBusyClaudeIds(new Set(['c1']), p);
    // Workspace chip.
    const chip = resolveBusyByWorkspace({ wsA: ['b1'] }, mappings, p).wsA;
    // Tab dot, using the same reconciled set the list is built from.
    const dot = resolveTabBusy('c1', 'b1', list, new Set(['b1']));
    expect(chip).toBe(false);
    expect(list.has('c1')).toBe(false);
    expect(dot).toBe(false);
  });
});

describe('resolveWaitingByWorkspace', () => {
  const mappings = new Map([['wsA', new Map([['b1', 'c1']])]]);

  it('lights from a peer-waiting mapped session', () => {
    const out = resolveWaitingByWorkspace(new Map(), mappings, peer([['c1', 'waiting']]));
    expect(out.wsA).toBe(true);
  });

  it('keeps a hook waiting the peer has not overridden', () => {
    const hook = new Map<string, Set<string>>([['wsB', new Set(['x'])]]);
    const out = resolveWaitingByWorkspace(hook, mappings, peer([]));
    expect(out.wsB).toBe(true);
  });

  it('peer idle clears the hook waiting chip', () => {
    const hook = new Map([['wsA', new Set(['c1'])]]);
    const out = resolveWaitingByWorkspace(hook, mappings, peer([['c1', 'idle']]));
    expect(out.wsA).toBeUndefined();
  });
});
