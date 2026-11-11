import { describe, expect, it, vi } from 'vitest';
import { registerFederationIpc, type LocalSearch } from './federationIpc';
import type { FederatedReader } from './federatedReader';

const A = '01JC0000000000000000000000';
function rig() {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const reader = { listSessions: vi.fn(async () => ({ pages: [], unavailable: [] })), summary: vi.fn(), call: vi.fn(), sources: vi.fn(() => []), search: vi.fn(),
    ownerCosts: vi.fn(async (id: string) => (id === A ? [{ owner: null, sessions: 1, usd: 1 }] : undefined)) };
  const search = { embed: vi.fn(), hits: vi.fn(), localIds: vi.fn() };
  registerFederationIpc({ handle: (c: string, f: never) => handlers.set(c, f) } as never, reader as never, search as never);
  return { h: handlers.get('sessions:listRemote')!, reader, handlers };
}

describe('sessions:listRemote', () => {
  it('first pages with no argument; one origin first page; one origin with a cursor', async () => {
    const { h, reader } = rig();
    await h({});
    expect(reader.listSessions).toHaveBeenLastCalledWith({});
    await h({}, { origin: A });
    expect(reader.listSessions).toHaveBeenLastCalledWith({ origin: A });
    await h({}, { origin: A, after: { lastActiveAt: 3, id: 's' } });
    expect(reader.listSessions).toHaveBeenLastCalledWith({ origin: A, after: { lastActiveAt: 3, id: 's' } });
  });
  it('refuses a malformed request', async () => {
    const { h } = rig();
    await expect(h({}, { origin: 'x', after: { lastActiveAt: 3, id: 's' } })).rejects.toThrow();
    await expect(h({}, { origin: A, after: { lastActiveAt: -1, id: 's' } })).rejects.toThrow();
  });
  it('refuses a cross-shaped or non-object request', async () => {
    const { h, reader } = rig();
    for (const bad of [{ origin: A, after: null }, { origin: A, after: { lastActiveAt: 1, id: 'a b' } }, { origin: A, after: { lastActiveAt: 1.5, id: 's' } }, 'x', 5, { after: { lastActiveAt: 1, id: 's' } }]) {
      await expect(h({}, bad), JSON.stringify(bad)).rejects.toThrow();
    }
    expect(reader.listSessions).not.toHaveBeenCalled();
  });
  it('passes only the parsed fields on', async () => {
    const { h, reader } = rig();
    await h({}, { origin: A, after: { lastActiveAt: 3, id: 's', workspaceId: 'x' }, limit: 9999 });
    expect(reader.listSessions).toHaveBeenLastCalledWith({ origin: A, after: { lastActiveAt: 3, id: 's' } });
  });
});

const R1 = '01JC0000000000000000000001';
const R2 = '01JC0000000000000000000002';
const L1 = 'L1';
const unitVec = (): Float32Array => { const v = new Float32Array(384); v[0] = 1; return v; };
const hit = (sessionId: string, score: number) => ({ sessionId, workspaceId: 'W', workspaceName: 'w', kind: 'turn' as const, ts: 1, text: 't', score });

function searchRig(o: { embed?: Float32Array | null; local?: ReturnType<typeof hit>[]; remote?: { origin: string; hits: ReturnType<typeof hit>[] }[] } = {}) {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const vec = o.embed === undefined ? unitVec() : o.embed;
  const reader = {
    listSessions: vi.fn(), summary: vi.fn(), call: vi.fn(),
    sources: vi.fn(() => [{ id: R1 }, { id: R2 }]),
    search: vi.fn(async () => ({ remote: o.remote ?? [], unavailable: [{ origin: R2, name: 'triage', reason: 'disabled' as const }] })),
  };
  const search: LocalSearch = {
    embed: vi.fn(async () => vec),
    hits: vi.fn(async () => o.local ?? []),
    localIds: vi.fn(async () => new Set([L1])),
  };
  registerFederationIpc({ handle: (c: string, f: never) => handlers.set(c, f) } as never, reader as unknown as FederatedReader, search);
  return { h: handlers.get('history:search')!, reader, search, vec };
}

describe('history:search', () => {
  it('rejects an empty or oversized query and a bad scope before embedding', async () => {
    const { h, search, reader } = searchRig();
    for (const q of ['', '   ', 5, null, 'x'.repeat(2001)]) await expect(h({}, q, { scope: 'all' }), String(q)).rejects.toThrow('query must be');
    for (const opts of [{ scope: 'a b' }, { scope: 5 }, {}, null, { scope: '' }]) await expect(h({}, 'q', opts), JSON.stringify(opts)).rejects.toThrow('scope must be');
    expect(search.embed).not.toHaveBeenCalled();
    expect(reader.search).not.toHaveBeenCalled();
  });

  it('throws when the local embedder is not ready, and sends nothing anywhere', async () => {
    const { h, reader, search } = searchRig({ embed: null });
    await expect(h({}, 'q', { scope: 'all' })).rejects.toThrow('transcript search index is unavailable');
    expect(reader.search).not.toHaveBeenCalled();
    expect(search.hits).not.toHaveBeenCalled();
  });

  it('all: embeds the trimmed query once, searches local and every bookmark, merges by score', async () => {
    const { h, reader, search, vec } = searchRig({ local: [hit('a', 0.4), hit('b', 0.9)], remote: [{ origin: R1, hits: [hit('c', 0.6)] }] });
    const out = await h({}, '  find me  ', { scope: 'all', limit: 3 }) as { hits: { origin: string; sessionId: string }[]; unavailable: unknown[] };
    expect(search.embed).toHaveBeenCalledTimes(1);
    expect(search.embed).toHaveBeenCalledWith('find me');
    expect(search.hits).toHaveBeenCalledWith(vec, 'all', 3);
    expect(reader.search).toHaveBeenCalledWith({ vector: vec, limit: 3, origins: [R1, R2] });
    expect(out.hits.map((x) => `${x.origin}:${x.sessionId}`)).toEqual(['local:b', `${R1}:c`, 'local:a']);
    expect(out.unavailable).toEqual([{ origin: R2, name: 'triage', reason: 'disabled' }]);
  });

  it('a local workspace scope sends nothing to any host', async () => {
    const { h, reader, search } = searchRig({ local: [hit('a', 0.4)] });
    await h({}, 'q', { scope: L1 });
    expect(search.hits).toHaveBeenCalledWith(expect.any(Float32Array), L1, 20);
    expect(reader.search).toHaveBeenCalledWith(expect.objectContaining({ origins: [] }));
  });

  it('a remote workspace scope sends the vector to that host only and skips the local search', async () => {
    const { h, reader, search } = searchRig({ remote: [{ origin: R1, hits: [hit('c', 0.6)] }] });
    const out = await h({}, 'q', { scope: R1, limit: 999 }) as { hits: { origin: string }[] };
    expect(search.hits).not.toHaveBeenCalled();
    expect(reader.search).toHaveBeenCalledWith(expect.objectContaining({ origins: [R1], limit: 50 }));
    expect(out.hits.map((x) => x.origin)).toEqual([R1]);
  });

  it('clamps and defaults the limit', async () => {
    const { h, reader } = searchRig();
    await h({}, 'q', { scope: 'all', limit: 0 });
    expect(reader.search).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }));
    await h({}, 'q', { scope: 'all', limit: 2.5 });
    expect(reader.search).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20 }));
    await h({}, 'q', { scope: 'all' });
    expect(reader.search).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20 }));
  });
});

describe('observability:ownerCosts', () => {
  it('answers a remote workspace’s rows, null for anything else, and refuses a non-id', async () => {
    const { handlers, reader } = rig();
    const h = handlers.get('observability:ownerCosts')!;
    expect(await h({}, A)).toEqual([{ owner: null, sessions: 1, usd: 1 }]);
    expect(await h({}, '01JC0000000000000000000009')).toBeNull();
    await expect(h({}, '../x')).rejects.toThrow();
    await expect(h({}, 5)).rejects.toThrow();
    expect(reader.ownerCosts).toHaveBeenCalledTimes(2);
  });
});
