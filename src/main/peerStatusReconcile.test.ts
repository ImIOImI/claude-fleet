import { describe, expect, it } from 'vitest';
import { reducePeerStatuses } from './peerStatusReconcile.js';
import type { PeerStatus } from './peerStatus.js';

const s = (sessionId: string, status: PeerStatus['status'], statusUpdatedAt?: number): PeerStatus => ({
  sessionId,
  status,
  ...(statusUpdatedAt !== undefined ? { statusUpdatedAt } : {})
});

describe('reducePeerStatuses', () => {
  it('collapses one entry per session', () => {
    const out = reducePeerStatuses([s('a', 'busy', 1), s('b', 'idle', 1)]);
    expect(out.get('a')?.status).toBe('busy');
    expect(out.get('b')?.status).toBe('idle');
    expect(out.size).toBe(2);
  });

  it('newest statusUpdatedAt wins when a session has multiple pid files', () => {
    // A resumed session: stale pid file (old, idle) + live pid file (new, busy).
    const out = reducePeerStatuses([s('a', 'idle', 100), s('a', 'busy', 200)]);
    expect(out.get('a')?.status).toBe('busy');
  });

  it('order-independent (newest still wins if the stale file is seen last)', () => {
    const out = reducePeerStatuses([s('a', 'busy', 200), s('a', 'idle', 100)]);
    expect(out.get('a')?.status).toBe('busy');
  });

  it('an entry with a timestamp beats one without', () => {
    expect(reducePeerStatuses([s('a', 'idle'), s('a', 'busy', 5)]).get('a')?.status).toBe('busy');
    expect(reducePeerStatuses([s('a', 'busy', 5), s('a', 'idle')]).get('a')?.status).toBe('busy');
  });

  it('empty input yields an empty map', () => {
    expect(reducePeerStatuses([]).size).toBe(0);
  });
});
