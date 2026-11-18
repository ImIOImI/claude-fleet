import { describe, expect, it } from 'vitest';
import { memoryDrainStore } from './drainStore.js';
import { drainRpcChannels } from './drainRpc.js';
import { dispatchRpc, RpcUnavailableError } from './rpc.js';
import type { Principal } from './attachHub.js';

const caller = (tier: Principal['tier']): Principal => ({ identity: { provider: 'github', kind: 'user', login: 'ann', id: 7, name: null, avatarUrl: null, teams: [] }, tier });

describe('sessions:drained', () => {
  it('is read tier, last 24 h, newest first; empty without db; 503 with db and no holder', async () => {
    const s = memoryDrainStore();
    await s.recordDrained([{ instance: 'i', brokerSessionId: 'tab1', sessionId: 'c1', reason: null }], 1_000);
    await s.recordDrained([{ instance: 'i', brokerSessionId: 'tab2', sessionId: 'c2', reason: null }], 90_000_000);
    const reg = drainRpcChannels(() => s, { db: true, now: () => 90_000_000 });
    const ch = reg.get('sessions:drained')!;
    expect(ch.tier).toBe('read');
    expect(await ch.handle([], caller('read'))).toEqual({ rows: [{ brokerSessionId: 'tab2', sessionId: 'c2', drainedAt: 90_000_000 }] });
    expect(await dispatchRpc(reg, 'sessions:drained', { args: [] }, caller('read'))).toMatchObject({ status: 200 });
    expect(await drainRpcChannels(() => null, { db: false }).get('sessions:drained')!.handle([], caller('read'))).toEqual({ rows: [] });
    await expect(drainRpcChannels(() => null, { db: true }).get('sessions:drained')!.handle([], caller('read'))).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it('caps the answer at 200 rows', async () => {
    const s = memoryDrainStore();
    await s.recordDrained(Array.from({ length: 250 }, (_, i) => ({ instance: 'i', brokerSessionId: `tab${i}`, sessionId: `c${i}`, reason: null })), 5);
    const r = (await drainRpcChannels(() => s, { db: true, now: () => 10 }).get('sessions:drained')!.handle([], caller('read'))) as { rows: unknown[] };
    expect(r.rows).toHaveLength(200);
  });
});
