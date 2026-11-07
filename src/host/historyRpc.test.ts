import { describe, expect, it, vi } from 'vitest';
import { dispatchRpc } from './rpc.js';
import { historyRpcChannels } from './historyRpc.js';
import type { HistoryReader } from './historyRead.js';
import type { Principal } from './attachHub.js';
import { person } from './testFakes.js';

const caller = { tier: 'read', identity: person('amy', 1) } as unknown as Principal;
const reader = (): HistoryReader => ({
  workspaceId: 'W',
  sessions: vi.fn(async () => ({ rows: [], next: null })),
  summary: vi.fn(async () => null),
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

  it('redacts a store failure as 500', async () => {
    const r = reader();
    (r.sessions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('relation "secret" does not exist'));
    expect(await dispatchRpc(historyRpcChannels(() => r), 'history:sessions', { args: [{}] }, caller)).toEqual({ status: 500, body: { ok: false, error: 'internal error' } });
  });

  it('every channel needs read, and a caller without a tier is refused', async () => {
    const reg = historyRpcChannels(() => reader());
    expect([...reg.keys()].sort()).toEqual(['history:sessions', 'history:summary']);
    for (const ch of reg.values()) expect(ch.tier).toBe('read');
    const none = { ...caller, tier: null } as unknown as Principal;
    expect((await dispatchRpc(reg, 'history:summary', { args: [] }, none)).status).toBe(403);
  });
});
