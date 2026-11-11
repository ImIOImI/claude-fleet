import { describe, expect, it, vi } from 'vitest';
import { dispatchRpc } from './rpc.js';
import { historyRpcChannels } from './historyRpc.js';
import type { HistoryReader } from './historyRead.js';
import type { Principal } from './attachHub.js';
import { person } from './testFakes.js';
import { EMBED_MODEL_ID } from '../main/vectors.js';

const caller = { tier: 'read', identity: person('amy', 1) } as unknown as Principal;
const reader = (): HistoryReader => ({
  workspaceId: 'W',
  sessions: vi.fn(async () => ({ rows: [], next: null })),
  summary: vi.fn(async () => null),
  search: vi.fn(async () => ({ modelId: EMBED_MODEL_ID, hits: [] })),
});

describe('history RPC', () => {
  it('passes only the parsed request and the session id through', async () => {
    const r = reader();
    const reg = historyRpcChannels(() => r);
    const res = await dispatchRpc(reg, 'history:sessions', { args: [{ after: { lastActiveAt: 5, id: 'a', workspaceId: 'X' }, limit: 10, workspaceId: 'X' }, 'X'] }, caller);
    expect(res).toEqual({ status: 200, body: { ok: true, result: { rows: [], next: null } } });
    expect(r.sessions).toHaveBeenCalledWith({ after: { lastActiveAt: 5, id: 'a' }, limit: 10 });
    expect((await dispatchRpc(reg, 'history:sessions', { args: [] }, caller)).status).toBe(200);
    expect(r.sessions).toHaveBeenLastCalledWith({ after: null, limit: 200 });
    expect((await dispatchRpc(reg, 'history:summary', { args: [] }, caller)).status).toBe(200);
    expect(r.summary).toHaveBeenCalledWith(null);
    expect((await dispatchRpc(reg, 'history:summary', { args: ['s-1', 'X'] }, caller)).status).toBe(200);
    expect(r.summary).toHaveBeenLastCalledWith('s-1');
  });

  it('400s a bad argument and 503s without a holder', async () => {
    const r = reader();
    const reg = historyRpcChannels(() => r);
    expect((await dispatchRpc(reg, 'history:sessions', { args: [{ limit: 0 }] }, caller)).status).toBe(400);
    expect((await dispatchRpc(reg, 'history:sessions', { args: [{ after: { lastActiveAt: 1, id: "' OR 1=1" } }] }, caller)).status).toBe(400);
    expect((await dispatchRpc(reg, 'history:summary', { args: ['a b'] }, caller)).status).toBe(400);
    expect(r.sessions).not.toHaveBeenCalled();
    expect(r.summary).not.toHaveBeenCalled();
    const none = historyRpcChannels(() => null);
    expect(await dispatchRpc(none, 'history:sessions', { args: [{}] }, caller)).toEqual({ status: 503, body: { ok: false, error: 'history unavailable' } });
    expect(await dispatchRpc(none, 'history:summary', { args: [] }, caller)).toEqual({ status: 503, body: { ok: false, error: 'history unavailable' } });
  });

  it('history:search validates the vector and model', async () => {
    const r = reader();
    const reg = historyRpcChannels(() => r);
    const unit = Array(384).fill(1 / Math.sqrt(384));
    const ok = await dispatchRpc(reg, 'history:search', { args: [{ vector: unit, modelId: EMBED_MODEL_ID, limit: 10, workspaceId: 'X' }] }, caller);
    expect(ok).toEqual({ status: 200, body: { ok: true, result: { modelId: EMBED_MODEL_ID, hits: [] } } });
    const req = vi.mocked(r.search).mock.calls[0][0];
    expect(req.vector).toBeInstanceOf(Float32Array);
    expect(Object.keys(req).filter((k) => !['vector', 'limit', 'kind'].includes(k))).toEqual([]);
    expect(req.limit).toBe(10);
    expect((await dispatchRpc(reg, 'history:search', { args: [{ vector: unit, modelId: EMBED_MODEL_ID, kind: 'summary' }] }, caller)).status).toBe(200);
    expect(vi.mocked(r.search).mock.calls[1][0]).toMatchObject({ limit: 10, kind: 'summary' });
    const mismatch = await dispatchRpc(reg, 'history:search', { args: [{ vector: unit, modelId: 'other@fp32', limit: 10 }] }, caller);
    expect(mismatch).toEqual({ status: 400, body: { ok: false, error: `model mismatch: host uses ${EMBED_MODEL_ID}` } });
    for (const bad of [
      undefined,
      [unit],
      { vector: unit, limit: 10 },
      { vector: unit.slice(1), modelId: EMBED_MODEL_ID, limit: 10 },
      { vector: [...unit, 0], modelId: EMBED_MODEL_ID, limit: 10 },
      { vector: Array(384).fill(1), modelId: EMBED_MODEL_ID, limit: 10 },
      { vector: Array(384).fill(0), modelId: EMBED_MODEL_ID, limit: 10 },
      { vector: [...unit.slice(1), NaN], modelId: EMBED_MODEL_ID, limit: 10 },
      { vector: [...unit.slice(1), Infinity], modelId: EMBED_MODEL_ID, limit: 10 },
      { vector: [...unit.slice(1), '0.05'], modelId: EMBED_MODEL_ID, limit: 10 },
      { vector: unit, modelId: EMBED_MODEL_ID, limit: 51 },
      { vector: unit, modelId: EMBED_MODEL_ID, limit: 0 },
      { vector: unit, modelId: EMBED_MODEL_ID, limit: 2.5 },
      { vector: unit, modelId: EMBED_MODEL_ID, kind: 'event' },
    ]) expect((await dispatchRpc(reg, 'history:search', { args: [bad] }, caller)).status).toBe(400);
    expect(r.search).toHaveBeenCalledTimes(2);
    const scaled = (f: number) => ({ vector: unit.map((x) => x * f), modelId: EMBED_MODEL_ID });
    expect((await dispatchRpc(reg, 'history:search', { args: [scaled(1.0009)] }, caller)).status).toBe(200);
    expect((await dispatchRpc(reg, 'history:search', { args: [scaled(0.9991)] }, caller)).status).toBe(200);
    expect((await dispatchRpc(reg, 'history:search', { args: [scaled(1.0011)] }, caller)).status).toBe(400);
    expect((await dispatchRpc(reg, 'history:search', { args: [scaled(0.9989)] }, caller)).status).toBe(400);
    expect((await dispatchRpc(reg, 'history:search', { args: [{ vector: unit, modelId: EMBED_MODEL_ID, limit: 50 }] }, caller)).status).toBe(200);
  });

  it('history:search answers 503 search unavailable when the embedder is off (D79)', async () => {
    const r = reader();
    const reg = historyRpcChannels(() => r, { search: () => false });
    expect(await dispatchRpc(reg, 'history:search', { args: [{ nonsense: true }] }, caller)).toEqual({ status: 503, body: { ok: false, error: 'search unavailable' } });
    expect(r.search).not.toHaveBeenCalled();
    expect((await dispatchRpc(reg, 'history:sessions', { args: [] }, caller)).status).toBe(200);
    expect(await dispatchRpc(historyRpcChannels(() => null), 'history:search', { args: [{}] }, caller)).toEqual({ status: 503, body: { ok: false, error: 'history unavailable' } });
  });

  it('redacts a store failure as 500', async () => {
    const r = reader();
    (r.sessions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('relation "secret" does not exist'));
    expect(await dispatchRpc(historyRpcChannels(() => r), 'history:sessions', { args: [{}] }, caller)).toEqual({ status: 500, body: { ok: false, error: 'internal error' } });
  });

  it('every channel needs read, and a caller without a tier is refused', async () => {
    const reg = historyRpcChannels(() => reader());
    expect([...reg.keys()].sort()).toEqual(['history:search', 'history:sessions', 'history:summary']);
    for (const ch of reg.values()) expect(ch.tier).toBe('read');
    const none = { ...caller, tier: null } as unknown as Principal;
    expect((await dispatchRpc(reg, 'history:summary', { args: [] }, none)).status).toBe(403);
  });
});
