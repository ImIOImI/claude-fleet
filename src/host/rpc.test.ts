import { describe, expect, it, vi } from 'vitest';
import type { Tier } from '../main/identity/grants.js';
import { brokerRpcChannels, dispatchRpc, RpcArgError, type RpcChannel } from './rpc.js';
import { createLogger } from './log.js';
import { fakeBroker, person } from './testFakes.js';

const caller = (tier: Tier) => ({ identity: person('alice', 1), tier });

describe('dispatchRpc', () => {
  const handle = vi.fn(async (args: unknown[]) => ({ echoed: args }));
  const reg = new Map<string, RpcChannel>([['x:steer', { tier: 'steer', handle }]]);

  it('runs a channel the caller has the tier for', async () => {
    expect(await dispatchRpc(reg, 'x:steer', { args: [1] }, caller('steer'))).toEqual({ status: 200, body: { ok: true, result: { echoed: [1] } } });
  });

  it('403s below the channel tier without running it', async () => {
    handle.mockClear();
    expect(await dispatchRpc(reg, 'x:steer', { args: [] }, caller('read'))).toEqual({ status: 403, body: { ok: false, error: 'forbidden: needs steer' } });
    expect(handle).not.toHaveBeenCalled();
  });

  it('404s an unregistered channel, 400s a body without args', async () => {
    expect((await dispatchRpc(reg, 'config:get', { args: [] }, caller('session'))).status).toBe(404);
    expect((await dispatchRpc(reg, 'x:steer', { nope: 1 }, caller('session'))).status).toBe(400);
  });

  it('maps RpcArgError to 400 and redacts other errors', async () => {
    const r = new Map<string, RpcChannel>([
      ['bad', { tier: 'read', handle: async () => { throw new RpcArgError('port must be 1-65535'); } }],
      ['boom', { tier: 'read', handle: async () => { throw new Error('Bearer gho_' + 'a'.repeat(36)); } }]
    ]);
    expect(await dispatchRpc(r, 'bad', { args: [] }, caller('read'))).toEqual({ status: 400, body: { ok: false, error: 'port must be 1-65535' } });
    const lines: string[] = [];
    expect(await dispatchRpc(r, 'boom', { args: [] }, caller('read'), createLogger((l) => lines.push(l)))).toEqual({
      status: 500,
      body: { ok: false, error: 'internal error' }
    });
    expect(lines.join('\n')).toContain('"channel":"boom"');
    expect(lines.join('\n')).not.toContain('gho_');
  });
});

describe('brokerRpcChannels', () => {
  it('declares read for listings and steer for ports:kill', () => {
    const reg = brokerRpcChannels(fakeBroker().ops);
    expect(Object.fromEntries([...reg].map(([k, v]) => [k, v.tier]))).toEqual({ 'sessions:live': 'read', 'ports:list': 'read', 'ports:kill': 'steer' });
  });

  it('ports:kill validates its port', async () => {
    const b = fakeBroker();
    const reg = brokerRpcChannels(b.ops);
    expect((await dispatchRpc(reg, 'ports:kill', { args: ['22; rm'] }, caller('steer'))).status).toBe(400);
    expect(b.killed).toEqual([]);
  });

  it('ports:kill refuses the host port and unattributed ports with 403', async () => {
    const b = fakeBroker(['s1']);
    b.ports.push({ port: 8080 }, { port: 9229 });
    const reg = brokerRpcChannels(b.ops, 8080);
    expect(await dispatchRpc(reg, 'ports:kill', { args: [8080] }, caller('session'))).toEqual({
      status: 403,
      body: { ok: false, error: 'forbidden: that port belongs to the host' }
    });
    expect((await dispatchRpc(reg, 'ports:kill', { args: [9229] }, caller('session'))).status).toBe(403);
    expect((await dispatchRpc(reg, 'ports:kill', { args: [3000] }, caller('steer'))).status).toBe(200);
    expect(b.killed).toEqual([3000]);
  });
});
