import { describe, expect, it } from 'vitest';
import type { RemoteChange } from '../../preload/remoteAutomations';
import { createRemoteChangeForwarder, REMOTE_CHANGE_DEBOUNCE_MS } from './remoteChanges';

function rig(bookmarked: Set<string>) {
  const sent: RemoteChange[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const f = createRemoteChangeForwarder({
    isBookmarked: (o) => bookmarked.has(o),
    send: (c) => sent.push(c),
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    }
  });
  const flush = () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); };
  return { f, sent, timers, flush };
}

describe('remote change forwarder', () => {
  it('debounces per host and channel, and sends only the hint', () => {
    const r = rig(new Set(['W', 'V']));
    r.f.hint('W', 'inbox:changed');
    r.f.hint('W', 'inbox:changed');
    r.f.hint('W', 'automations:changed');
    r.f.hint('V', 'inbox:changed');
    expect(r.timers.map((t) => t.ms)).toEqual([REMOTE_CHANGE_DEBOUNCE_MS, REMOTE_CHANGE_DEBOUNCE_MS, REMOTE_CHANGE_DEBOUNCE_MS]);
    r.flush();
    expect(r.sent).toEqual([{ origin: 'W', channel: 'inbox:changed' }, { origin: 'W', channel: 'automations:changed' }, { origin: 'V', channel: 'inbox:changed' }]);
    r.f.hint('W', 'inbox:changed');
    expect(r.timers).toHaveLength(1);
  });

  it('drops a hint for a host that is not (or no longer) bookmarked', () => {
    const marks = new Set(['W']);
    const r = rig(marks);
    r.f.hint('X', 'inbox:changed');
    r.f.hint('W', 'inbox:changed');
    marks.delete('W');
    r.flush();
    expect(r.sent).toEqual([]);
  });

  it('ignores an unknown channel; a reconnect refreshes every channel; stop cancels pending', () => {
    const r = rig(new Set(['W']));
    r.f.hint('W', 'sessions:changed' as never);
    expect(r.timers).toHaveLength(0);
    r.f.connected('W');
    expect(r.timers).toHaveLength(4);
    r.f.stop();
    r.flush();
    expect(r.sent).toEqual([]);
  });
});
