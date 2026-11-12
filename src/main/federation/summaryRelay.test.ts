import { describe, expect, it, vi } from 'vitest';
import type { RemoteSourceInfo } from '../remote';
import { createSummaryRelay } from './summaryRelay';

const A = '01JC0000000000000000000000';
describe('SummaryRelay', () => {
  it('subscribes per bookmark, debounces hints, and pushes fetched summaries', async () => {
    const handlers = new Map<string, (e: { channel: string; payload: unknown }) => void>();
    const stops = new Map<string, ReturnType<typeof vi.fn>>();
    const timers: Array<() => void> = [];
    const broadcast = vi.fn();
    let sources = [{ id: A, url: 'http://a', name: 'a', hue: null, tier: 'read' as const, state: 'running' as const }];
    const relay = createSummaryRelay({
      sources: () => sources,
      subscribe: (url, on) => { handlers.set(url, on); const s = vi.fn(); stops.set(url, s); return s; },
      fetchSummary: async () => ({ sessionId: 's' }) as never,
      broadcast,
      schedule: (fn) => { timers.push(fn); return () => undefined; },
    });
    relay.sync();
    const on = handlers.get('http://a')!;
    on({ channel: 'observability:summary', payload: { workspaceId: A } });
    on({ channel: 'observability:summary', payload: { workspaceId: A } });
    on({ channel: 'observability:summary', payload: { workspaceId: 'other' } });
    expect(timers).toHaveLength(1);
    await timers.shift()!();
    expect(broadcast).toHaveBeenCalledWith(A, { sessionId: 's' });
    sources = [];
    relay.sync();
    expect(stops.get('http://a')).toHaveBeenCalled();
  });

  it('a failed fetch pushes nothing', async () => {
    const timers: Array<() => void> = [];
    const broadcast = vi.fn();
    let on!: (e: { channel: string; payload: unknown }) => void;
    const relay = createSummaryRelay({
      sources: () => [{ id: A, url: 'http://a', name: 'a', hue: null, tier: 'read', state: 'running' }],
      subscribe: (_u, f) => { on = f; return () => undefined; },
      fetchSummary: async () => undefined,
      broadcast,
      schedule: (fn) => { timers.push(fn); return () => undefined; },
    });
    relay.sync();
    on({ channel: 'observability:summary', payload: { workspaceId: A } });
    await timers.shift()!();
    expect(broadcast).not.toHaveBeenCalled();
  });

  function rig(fetchSummary: () => Promise<unknown> = async () => null) {
    type State = (connected: boolean, why?: { retryInMs: number | null }) => void;
    const subs: Array<{ url: string; on: (e: { channel: string; payload: unknown }) => void; state: State; stopped: boolean }> = [];
    const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
    const broadcast = vi.fn();
    let sources: RemoteSourceInfo[] = [{ id: A, url: 'http://a', name: 'a', hue: null, tier: 'read', state: 'running' }];
    const relay = createSummaryRelay({
      sources: () => sources,
      subscribe: (url, on, state) => { const s = { url, on, state, stopped: false }; subs.push(s); return () => void (s.stopped = true); },
      fetchSummary: fetchSummary as never,
      broadcast,
      schedule: (fn) => { const t = { fn, cancelled: false }; timers.push(t); return () => void (t.cancelled = true); },
    });
    const hint = (i = subs.length - 1) => subs[i].on({ channel: 'observability:summary', payload: { workspaceId: A } });
    return { relay, subs, timers, broadcast, hint, setSources: (s: RemoteSourceInfo[]) => void (sources = s) };
  }

  it('pushes a null summary (no sessions yet); a rejected fetch pushes nothing', async () => {
    const r = rig();
    r.relay.sync();
    r.hint();
    await r.timers[0].fn();
    expect(r.broadcast).toHaveBeenCalledWith(A, null);
    const bad = rig(async () => { throw new Error('x'); });
    bad.relay.sync();
    bad.hint();
    await bad.timers[0].fn();
    expect(bad.broadcast).not.toHaveBeenCalled();
  });

  it('ignores other channels; one subscription per bookmark across syncs; a moved URL resubscribes', () => {
    const r = rig();
    r.relay.sync();
    r.relay.sync();
    expect(r.subs).toHaveLength(1);
    r.subs[0].on({ channel: 'workspace:list', payload: { workspaceId: A } });
    r.subs[0].on({ channel: 'observability:summary', payload: null });
    expect(r.timers).toHaveLength(0);
    r.setSources([{ id: A, url: 'http://b', name: 'a', hue: null, tier: 'read', state: 'running' }]);
    r.relay.sync();
    expect(r.subs.map((s) => [s.url, s.stopped])).toEqual([['http://a', true], ['http://b', false]]);
  });

  it('stop cancels pending fetches and unsubscribes; a late fetch for a dropped bookmark pushes nothing', async () => {
    const r = rig();
    r.relay.sync();
    r.hint();
    r.relay.stop();
    expect(r.subs[0].stopped).toBe(true);
    expect(r.timers[0].cancelled).toBe(true);
    await r.timers[0].fn();
    expect(r.broadcast).not.toHaveBeenCalled();
  });

  it('a subscription that stops retrying is dropped, so the next sync resubscribes', () => {
    const r = rig();
    r.relay.sync();
    r.subs[0].state(false, { retryInMs: 1_000 });
    r.relay.sync();
    expect(r.subs).toHaveLength(1);
    r.subs[0].state(false, { retryInMs: null });
    expect(r.subs[0].stopped).toBe(true);
    r.relay.sync();
    expect(r.subs.map((s) => s.stopped)).toEqual([true, false]);
    r.subs[0].state(false, { retryInMs: null });
    expect(r.subs[1].stopped).toBe(false);
  });

  it('subscribes only to a running source; an existing subscription rides out a down state', () => {
    const r = rig();
    const src = (state: RemoteSourceInfo['state']): RemoteSourceInfo[] => [{ id: A, url: 'http://a', name: 'a', hue: null, tier: 'read', state }];
    r.setSources(src(null));
    r.relay.sync();
    r.setSources(src('unreachable'));
    r.relay.sync();
    expect(r.subs).toHaveLength(0);
    r.setSources(src('running'));
    r.relay.sync();
    expect(r.subs).toHaveLength(1);
    r.setSources(src('unreachable'));
    r.relay.sync();
    expect(r.subs.map((s) => s.stopped)).toEqual([false]);
  });

  it('a hint after a push schedules a new read', async () => {
    const r = rig();
    r.relay.sync();
    r.hint();
    await r.timers[0].fn();
    r.hint();
    expect(r.timers).toHaveLength(2);
  });
  it('forwards automation, proposal, inbox and notice hints for the subscribed host, and reports connects', async () => {
    const changes: Array<[string, string]> = [];
    const connected: string[] = [];
    let emit!: (e: { channel: string; payload: unknown }) => void;
    let state!: (c: boolean) => void;
    const relay = createSummaryRelay({
      sources: () => [{ id: 'W', url: 'http://w', name: 'w', hue: null, tier: 'read', state: 'running' }],
      subscribe: (_u, on, st) => { emit = on; state = st; return () => undefined; },
      fetchSummary: async () => null, broadcast: () => undefined,
      onHostChange: (o, ch) => changes.push([o, ch]), onConnected: (o) => connected.push(o)
    });
    relay.sync();
    state(true);
    emit({ channel: 'automations:changed', payload: null });
    emit({ channel: 'notices:changed', payload: { workspaceId: 'W' } });
    emit({ channel: 'sessions:changed', payload: {} });
    expect(changes).toEqual([['W', 'automations:changed'], ['W', 'notices:changed']]);
    expect(connected).toEqual(['W']);
    relay.stop();
  });

  it('drops hints from a subscription that is no longer current', () => {
    const changes: string[] = [];
    let emit!: (e: { channel: string; payload: unknown }) => void;
    let state!: (c: boolean, why?: { retryInMs: number | null }) => void;
    let sources = [{ id: 'W', url: 'http://w', name: 'w', hue: null, tier: 'read' as const, state: 'running' as const }];
    const relay = createSummaryRelay({
      sources: () => sources,
      subscribe: (_u, on, st) => { emit = on; state = st; return () => undefined; },
      fetchSummary: async () => null, broadcast: () => undefined,
      onHostChange: (o) => changes.push(o), onConnected: (o) => changes.push(`up:${o}`)
    });
    relay.sync();
    const stale = emit, staleState = state;
    sources = [];
    relay.sync();
    stale({ channel: 'inbox:changed', payload: null });
    staleState(true);
    expect(changes).toEqual([]);
    relay.stop();
  });
});
