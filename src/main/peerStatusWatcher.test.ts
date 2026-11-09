import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('PeerStatusWatcher overlapping reads', () => {
  it('applies only the newest-started read of a path when reads finish out of order', async () => {
    const fsMod = await import('node:fs');
    const releases: Array<() => void> = [];
    const contents = [file('a', 'busy'), file('a', 'idle')];
    const spy = vi.spyOn(fsMod.promises, 'readFile').mockImplementation(() => {
      const body = contents.shift()!;
      return new Promise((resolve) => releases.push(() => resolve(body)));
    });
    try {
      const w = new PeerStatusWatcher();
      const touch = (w as unknown as { onTouch: (p: string) => Promise<void> }).onTouch.bind(w);
      const first = touch('/s/1.json');   // reads 'busy'
      const second = touch('/s/1.json');  // reads 'idle'
      releases[1]();
      await second;
      releases[0]();                      // the stale 'busy' read lands last
      await first;
      expect(w.snapshot().map((x) => x.status)).toEqual(['idle']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe.each([
  ['chokidar', false],
  ['native recursive fs.watch', true]
])('PeerStatusWatcher on disk (%s)', (_backend, nativeRecursive) => {
  const until = async (cond: () => boolean) => {
    const end = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('picks up existing and new pid files, status flips and removals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-'));
    const w = new PeerStatusWatcher({ nativeRecursive });
    let last: Array<{ sessionId: string; status: string }> = [];
    w.on('change', (s) => { last = s; });
    try {
      writeFileSync(join(dir, '1.json'), file('a', 'busy'));
      await w.start();
      w.registerDir(dir);
      await until(() => last.some((x) => x.sessionId === 'a' && x.status === 'busy'));
      writeFileSync(join(dir, '1.json'), file('a', 'idle'));
      writeFileSync(join(dir, '2.json'), file('b', 'waiting'));
      await until(() => last.some((x) => x.sessionId === 'a' && x.status === 'idle') && last.some((x) => x.sessionId === 'b'));
      unlinkSync(join(dir, '2.json'));
      await until(() => !last.some((x) => x.sessionId === 'b'));
    } finally {
      await w.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
