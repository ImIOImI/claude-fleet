import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFederatedReader } from './federatedReader';
import { RemoteError } from '../remoteClient';
import type { RemoteSourceInfo } from '../remote';
import { EMBED_DIM, EMBED_MODEL_ID } from '../vectors';

const A = '01JC0000000000000000000000';
const B = '01JC0000000000000000000001';
const C = '01JC0000000000000000000002';
const src = (id: string, state: RemoteSourceInfo['state']): RemoteSourceInfo => ({ id, url: `http://${id}`, name: `n${id.slice(-1)}`, hue: 10, tier: 'read', state });
const row = (id: string, ws: string) => ({ id, workspaceId: ws, aiTitle: null, firstUserMessage: 'hi', userSetName: null, startedAt: 1, lastActiveAt: 5, eventCount: 1, usd: 0, tags: [], headless: false });

afterEach(() => vi.useRealTimers());

describe('FederatedReader', () => {
  it('fans out, overlays bookmark fields, and lists failures without waiting on down hosts', async () => {
    const rpc = vi.fn(async (url: string) => {
      if (url === `http://${A}`) return { rows: [row('s1', A)], next: null };
      throw new RemoteError('forbidden', 'no grant', 403);
    });
    const r = createFederatedReader({ sources: () => [src(A, 'running'), src(B, 'running'), src(C, 'unreachable')], rpc });
    const out = await r.listSessions({});
    expect(out.pages).toEqual([{ origin: A, next: null, rows: [{ ...row('s1', A), workspaceName: 'n0', workspaceColorHue: 10, workspaceState: 'running', capture: false, origin: A }] }]);
    expect(out.unavailable).toEqual([{ origin: B, name: 'n1', reason: 'forbidden' }, { origin: C, name: 'n2', reason: 'unreachable' }]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('bounds a hanging host at the timeout', async () => {
    vi.useFakeTimers();
    const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc: () => new Promise(() => undefined), timeoutMs: 3000 });
    const p = r.listSessions({});
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).unavailable).toEqual([{ origin: A, name: 'n0', reason: 'timeout' }]);
  });

  it('pages one origin with its cursor and shares identical in-flight calls', async () => {
    let resolve!: (v: unknown) => void;
    const rpc = vi.fn(() => new Promise((res) => (resolve = res)));
    const r = createFederatedReader({ sources: () => [src(A, 'running'), src(B, 'running')], rpc });
    const p1 = r.listSessions({ origin: A, after: { lastActiveAt: 5, id: 's1' } });
    const p2 = r.listSessions({ origin: A, after: { lastActiveAt: 5, id: 's1' } });
    resolve({ rows: [], next: null });
    await Promise.all([p1, p2]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(`http://${A}`, 'history:sessions', [{ after: { lastActiveAt: 5, id: 's1' }, limit: 200 }], 3000);
  });

  it('a malformed reply is a protocol failure; summary failure is undefined', async () => {
    const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc: async () => ({ nope: 1 }) });
    expect((await r.listSessions({})).unavailable[0].reason).toBe('protocol');
    expect(await r.summary(A, null)).toBeUndefined();
    expect(await r.summary('unknown', null)).toBeUndefined();
  });

  it('an unprobed host is checking and costs no call', async () => {
    const rpc = vi.fn();
    const r = createFederatedReader({ sources: () => [src(A, null), src(B, 'unreachable')], rpc });
    expect((await r.listSessions({})).unavailable.map((u) => u.reason)).toEqual(['checking', 'unreachable']);
    expect(await r.summary(A, null)).toBeUndefined();
    expect(await r.summary(B, 's')).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps each host error kind to its reason', async () => {
    const kinds = ['not-signed-in', 'unreachable', 'unauthorized', 'forbidden', 'standby', 'protocol'] as const;
    for (const kind of kinds) {
      const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc: async () => { throw new RemoteError(kind, 'x'); } });
      expect((await r.listSessions({})).unavailable).toEqual([{ origin: A, name: 'n0', reason: kind }]);
    }
    const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc: async () => { throw new TypeError('boom'); } });
    expect((await r.listSessions({})).unavailable[0].reason).toBe('protocol');
  });

  it('drops rows filed under another workspace, and keeps nothing once a call settles', async () => {
    const rpc = vi.fn(async () => ({ rows: [row('s1', A), row('s2', B)], next: { lastActiveAt: 5, id: 's1' } }));
    const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc });
    const first = await r.listSessions({});
    expect(first.pages[0].rows.map((x) => x.id)).toEqual(['s1']);
    expect(first.pages[0].next).toEqual({ lastActiveAt: 5, id: 's1' });
    await r.listSessions({});
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith(`http://${A}`, 'history:sessions', [{ after: null, limit: 200 }], 3000);
  });

  it('a first-page request ignores a cursor; an unknown origin reads nothing', async () => {
    const rpc = vi.fn(async () => ({ rows: [], next: null }));
    const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc });
    await r.listSessions({ after: { lastActiveAt: 1, id: 'x' } });
    expect(rpc).toHaveBeenLastCalledWith(`http://${A}`, 'history:sessions', [{ after: null, limit: 200 }], 3000);
    expect(await r.listSessions({ origin: B, after: { lastActiveAt: 1, id: 'x' } })).toEqual({ pages: [], unavailable: [] });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('summary asks the host for one session and validates the reply', async () => {
    const summary = {
      sessionId: 's1', title: 't', model: null, startedAt: 1, lastActiveAt: 2, eventCount: 0, inputTokens: 0, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, usd: 0, lastTurnContextTokens: null, contextWindowTokens: 1,
      topTools: [], recentToolCalls: [], costSeries: [], tokenSeries: []
    };
    const rpc = vi.fn(async (_u: string, _c: string, args: unknown[]) => (args[0] === 'none' ? null : summary));
    const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc });
    expect(await r.summary(A, 's1')).toEqual(summary);
    expect(rpc).toHaveBeenLastCalledWith(`http://${A}`, 'history:summary', ['s1'], 3000);
    expect(await r.summary(A, 'none')).toBeNull();
  });

  it('a call that settles inside the bound leaves no timer behind', async () => {
    vi.useFakeTimers();
    const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc: async () => ({ rows: [], next: null }) });
    await r.listSessions({});
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('search', () => {
    const vector = (() => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; })();
    const hit = (ws: string, sessionId = 's1', score = 0.5) => ({ sessionId, workspaceId: ws, kind: 'turn', ts: 1, text: 't', score });

    it('sends only the vector, model id and limit, and only to the origins given', async () => {
      const rpc = vi.fn(async (url: string) => ({ modelId: EMBED_MODEL_ID, hits: [hit(url.slice(7))] }));
      const r = createFederatedReader({ sources: () => [src(A, 'running'), src(B, 'running')], rpc });
      const out = await r.search({ vector, limit: 7, origins: [B] });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(`http://${B}`, 'history:search', [{ vector: Array.from(vector), modelId: EMBED_MODEL_ID, limit: 7 }], 3000);
      const arg = (rpc.mock.calls[0] as unknown[])[2] as [Record<string, unknown>];
      expect(Object.keys(arg[0]).sort()).toEqual(['limit', 'modelId', 'vector']);
      expect(Array.isArray(arg[0].vector)).toBe(true);
      expect(out).toEqual({ remote: [{ origin: B, hits: [{ ...hit(B), workspaceName: 'n1' }] }], unavailable: [] });
    });

    it('an origin list naming no bookmark reads nothing', async () => {
      const rpc = vi.fn();
      const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc });
      expect(await r.search({ vector, limit: 5, origins: [] })).toEqual({ remote: [], unavailable: [] });
      expect(await r.search({ vector, limit: 5, origins: ['local', B] })).toEqual({ remote: [], unavailable: [] });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('a host answering with another model id is unavailable (model) and its hits are dropped', async () => {
      const rpc = vi.fn(async (url: string) => ({ modelId: url.endsWith(A) ? 'other@fp32' : EMBED_MODEL_ID, hits: [hit(url.slice(7))] }));
      const r = createFederatedReader({ sources: () => [src(A, 'running'), src(B, 'running')], rpc });
      const out = await r.search({ vector, limit: 5, origins: [A, B] });
      expect(out.unavailable).toEqual([{ origin: A, name: 'n0', reason: 'model' }]);
      expect(out.remote.map((x) => x.origin)).toEqual([B]);
    });

    it('a host refusing the query model (400 model mismatch) is unavailable (model)', async () => {
      const rpc = vi.fn(async (url: string) => {
        if (url.endsWith(A)) throw new RemoteError('model', 'x', 400);
        return { modelId: EMBED_MODEL_ID, hits: [hit(url.slice(7))] };
      });
      const r = createFederatedReader({ sources: () => [src(A, 'running'), src(B, 'running')], rpc });
      const out = await r.search({ vector, limit: 5, origins: [A, B] });
      expect(out.unavailable).toEqual([{ origin: A, name: 'n0', reason: 'model' }]);
      expect(out.remote.map((x) => x.origin)).toEqual([B]);
    });

    it('maps search-off, timeout and a malformed reply to their reasons', async () => {
      vi.useFakeTimers();
      const rpc = vi.fn((url: string): Promise<unknown> => {
        if (url.endsWith(A)) return Promise.reject(new RemoteError('disabled', 'x', 503));
        if (url.endsWith(B)) return new Promise(() => undefined);
        return Promise.resolve({ hits: [] });
      });
      const r = createFederatedReader({ sources: () => [src(A, 'running'), src(B, 'running'), src(C, 'running')], rpc, timeoutMs: 3000 });
      const p = r.search({ vector, limit: 5, origins: [A, B, C] });
      await vi.advanceTimersByTimeAsync(3000);
      expect((await p).unavailable).toEqual([
        { origin: A, name: 'n0', reason: 'disabled' }, { origin: B, name: 'n1', reason: 'timeout' }, { origin: C, name: 'n2', reason: 'protocol' },
      ]);
    });

    it('a down or unprobed host is listed without a call (liveness gate)', async () => {
      const rpc = vi.fn();
      const r = createFederatedReader({ sources: () => [src(A, 'unreachable'), src(B, null)], rpc });
      expect((await r.search({ vector, limit: 5, origins: [A, B] })).unavailable).toEqual([
        { origin: A, name: 'n0', reason: 'unreachable' }, { origin: B, name: 'n1', reason: 'checking' },
      ]);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('drops hits filed under another workspace and keeps nothing between calls', async () => {
      const rpc = vi.fn(async () => ({ modelId: EMBED_MODEL_ID, hits: [hit(A, 's1'), hit(B, 's2')] }));
      const r = createFederatedReader({ sources: () => [src(A, 'running')], rpc });
      expect((await r.search({ vector, limit: 5, origins: [A] })).remote[0].hits.map((h) => h.sessionId)).toEqual(['s1']);
      await r.search({ vector, limit: 5, origins: [A] });
      expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('sources() is the live bookmark list', () => {
      let list = [src(A, 'running')];
      const r = createFederatedReader({ sources: () => list, rpc: vi.fn() });
      expect(r.sources().map((s) => s.id)).toEqual([A]);
      list = [src(B, null)];
      expect(r.sources().map((s) => s.id)).toEqual([B]);
    });
  });
});
