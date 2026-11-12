import { describe, expect, it } from 'vitest';
import { actionChannel, memoryActionLedger, ACTION_LIMITS } from './hostActions.js';
import { dispatchRpc, RpcArgError } from './rpc.js';
import { LeaseLostError } from './pgLease.js';
import { UnauthLimiter } from './rateLimit.js';
import type { Principal } from './attachHub.js';

const ann: Principal = { identity: { provider: 'github', kind: 'user', login: 'ann', id: 7, name: null, avatarUrl: null, teams: [] }, tier: 'steer' };
const bob: Principal = { ...ann, identity: { ...ann.identity, login: 'bob', id: 8 } };
const reader: Principal = { ...ann, tier: 'read' };
const RID = '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a';

function setup(run: (a: { n: number }) => Promise<unknown>, limiter?: UnauthLimiter) {
  const ledger = memoryActionLedger(() => 1_000);
  const ch = actionChannel<{ n: number }>({
    tier: 'steer', channel: 'test:act', ledger: () => ledger,
    parse: (o) => {
      if (typeof o.n !== 'number') throw new RpcArgError('n must be a number');
      return { n: o.n };
    },
    ...(limiter ? { limit: { key: 'test', limiter } } : {}),
    run: (a) => run(a)
  });
  return { reg: new Map([['test:act', ch]]), ledger };
}

describe('actionChannel', () => {
  it('runs once per (actor, requestId) and replays the stored result', async () => {
    let calls = 0;
    const { reg } = setup(async ({ n }) => ({ n, call: ++calls }));
    const first = await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    const again = await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    expect(first).toEqual({ status: 200, body: { ok: true, result: { replayed: false, result: { n: 1, call: 1 }, error: null } } });
    expect(again).toEqual({ status: 200, body: { ok: true, result: { replayed: true, result: { n: 1, call: 1 }, error: null } } });
    expect(calls).toBe(1);
  });

  it('keys request ids per person: another person reusing an id runs their own action', async () => {
    let calls = 0;
    const { reg } = setup(async () => ++calls);
    await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    const b = await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, bob);
    expect((b.body as { result: { replayed: boolean } }).result.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('two concurrent calls with one id run the action once', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { reg } = setup(async () => { calls++; await gate; return 'done'; });
    const a = dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    const b = dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    const rb = await b;
    release();
    await a;
    expect(calls).toBe(1);
    expect(rb.body).toEqual({ ok: true, result: { replayed: true, result: null, error: null } });
  });

  it('stores a business error and replays it', async () => {
    let calls = 0;
    const { reg } = setup(async () => { calls++; throw new Error('nightly is disabled'); });
    const one = await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    const two = await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    expect(one.body).toEqual({ ok: true, result: { replayed: false, result: null, error: 'nightly is disabled' } });
    expect(two.body).toEqual({ ok: true, result: { replayed: true, result: null, error: 'nightly is disabled' } });
    expect(calls).toBe(1);
  });

  it('refuses a read caller, a missing or malformed requestId and bad args before claiming', async () => {
    const { reg, ledger } = setup(async () => 'x');
    expect((await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, reader)).status).toBe(403);
    expect((await dispatchRpc(reg, 'test:act', { args: [{ n: 1 }] }, ann)).status).toBe(400);
    expect((await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID.toUpperCase(), n: 1 }] }, ann)).status).toBe(400);
    expect((await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 'x' }] }, ann)).status).toBe(400);
    expect(await ledger.claim('github:7', RID, 'test:act')).toEqual({ fresh: true });
  });

  it('a requestId reused for another channel is a 400', async () => {
    const { reg, ledger } = setup(async () => 'x');
    await ledger.claim('github:7', RID, 'other:act');
    const r = await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    expect(r).toEqual({ status: 400, body: { ok: false, error: 'requestId was already used for another action' } });
  });

  it('answers 429 with Retry-After once the per-identity window is spent; nothing is claimed', async () => {
    const limiter = new UnauthLimiter({ max: 1, windowMs: 60_000, maxIps: 100, now: () => 0 });
    const { reg } = setup(async () => 'x', limiter);
    await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    const r = await dispatchRpc(reg, 'test:act', { args: [{ requestId: '1b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a', n: 1 }] }, ann);
    expect(r.status).toBe(429);
    expect(r.retryAfterSec).toBe(60);
  });

  it('a concurrent burst of fresh ids cannot overshoot the window', async () => {
    const limiter = new UnauthLimiter({ max: 2, windowMs: 60_000, maxIps: 100, now: () => 0 });
    let calls = 0;
    const { reg } = setup(async () => ++calls, limiter);
    const ids = ['1', '2', '3', '4'].map((d) => `${d}b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a`);
    const rs = await Promise.all(ids.map((requestId) => dispatchRpc(reg, 'test:act', { args: [{ requestId, n: 1 }] }, ann)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 429, 429]);
    expect(calls).toBe(2);
  });

  it('the window is per person', async () => {
    const limiter = new UnauthLimiter({ max: 1, windowMs: 60_000, maxIps: 100, now: () => 0 });
    const { reg } = setup(async () => 'x', limiter);
    await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    expect((await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, bob)).status).toBe(200);
  });

  it('a lost lease is 503 and leaves the claim unsettled: a retry replays without running', async () => {
    let calls = 0;
    const { reg } = setup(async () => { calls++; throw new LeaseLostError('epoch 2'); });
    expect(await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann)).toEqual({ status: 503, body: { ok: false, error: 'automations unavailable' } });
    expect((await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann)).body).toEqual({ ok: true, result: { replayed: true, result: null, error: null } });
    expect(calls).toBe(1);
  });

  it('a claim refused by the fence is 503 and nothing runs', async () => {
    let calls = 0;
    const ch = actionChannel<{ n: number }>({
      tier: 'steer', channel: 'test:act', parse: () => ({ n: 1 }),
      ledger: () => ({ claim: async () => { throw new LeaseLostError('not the holder'); }, settle: async () => undefined }),
      run: async () => ++calls
    });
    expect((await dispatchRpc(new Map([['test:act', ch]]), 'test:act', { args: [{ requestId: RID }] }, ann)).status).toBe(503);
    expect(calls).toBe(0);
  });

  it('answers 503 without a holder, before claiming', async () => {
    const ch = actionChannel<{ n: number }>({ tier: 'steer', channel: 'test:act', parse: () => ({ n: 1 }), ledger: () => null, run: async () => 1 });
    expect(await dispatchRpc(new Map([['test:act', ch]]), 'test:act', { args: [{ requestId: RID }] }, ann)).toEqual({ status: 503, body: { ok: false, error: 'automations unavailable' } });
  });

  it('stores a redacted, one-line error', async () => {
    const { reg } = setup(async () => { throw new Error('bad\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789'); });
    const r = (await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann)).body as { result: { error: string } };
    expect(r.result.error).not.toMatch(/ghp_|\n/);
  });

  it('limits: run 6/min, draft 2/min, other actions 60/min', () => {
    expect(ACTION_LIMITS).toEqual({ run: 6, other: 60 });
  });

  it('caps a stored result at 16 KiB', async () => {
    const { reg } = setup(async () => 'x'.repeat(20_000));
    await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    const r = await dispatchRpc(reg, 'test:act', { args: [{ requestId: RID, n: 1 }] }, ann);
    expect((r.body as { result: { result: unknown } }).result.result).toEqual({ truncated: true });
  });
});
