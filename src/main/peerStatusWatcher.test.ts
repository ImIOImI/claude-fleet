import { describe, expect, it, vi } from 'vitest';
import { PeerStatusWatcher } from './peerStatusWatcher.js';

const file = (sessionId: string, status: string, statusUpdatedAt?: number) =>
  JSON.stringify({ sessionId, status, ...(statusUpdatedAt !== undefined ? { statusUpdatedAt } : {}) });

describe('PeerStatusWatcher core (no fs)', () => {
  it('ingest reports change only on a genuine status change', () => {
    const w = new PeerStatusWatcher();
    expect(w.ingest('/s/1.json', file('a', 'busy'))).toBe(true);
    expect(w.ingest('/s/1.json', file('a', 'busy'))).toBe(false); // same
    expect(w.ingest('/s/1.json', file('a', 'idle'))).toBe(true); // flipped
  });

  it('ignores partial/foreign files, keeping the prior entry', () => {
    const w = new PeerStatusWatcher();
    w.ingest('/s/1.json', file('a', 'busy'));
    expect(w.ingest('/s/1.json', '{"sessionId":"a","stat')).toBe(false);
    expect(w.snapshot()).toEqual([{ sessionId: 'a', status: 'busy' }]);
  });

  it('snapshot reduces multiple pid files to the newest per session', () => {
    const w = new PeerStatusWatcher();
    w.ingest('/s/old.json', file('a', 'idle', 100));
    w.ingest('/s/new.json', file('a', 'busy', 200));
    expect(w.snapshot()).toEqual([{ sessionId: 'a', status: 'busy', statusUpdatedAt: 200 }]);
  });

  it('drop forgets a removed file', () => {
    const w = new PeerStatusWatcher();
    w.ingest('/s/1.json', file('a', 'busy'));
    expect(w.drop('/s/1.json')).toBe(true);
    expect(w.snapshot()).toEqual([]);
    expect(w.drop('/s/1.json')).toBe(false);
  });

  it('emitIfChanged fires once per distinct reduced snapshot', () => {
    const w = new PeerStatusWatcher();
    const seen: string[] = [];
    w.on('change', (snap) => seen.push(snap.map((s) => `${s.sessionId}:${s.status}`).sort().join(',')));

    w.ingest('/s/1.json', file('a', 'busy'));
    w.emitIfChanged(); // a:busy
    w.emitIfChanged(); // no change → no emit
    w.ingest('/s/1.json', file('a', 'idle'));
    w.emitIfChanged(); // a:idle

    expect(seen).toEqual(['a:busy', 'a:idle']);
  });
});
