import { describe, expect, it, vi } from 'vitest';
import type { AccountStatus, SignInPoll } from '../../preload/identityTypes';
import { createSignInFlow, type SignInFlowApi, type SignInFlowState } from './signInFlow';

const START = { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 900_000, intervalMs: 5 };

function rig(polls: Array<SignInPoll | Error>, start: () => Promise<typeof START> = async () => START) {
  const api: SignInFlowApi = {
    start: vi.fn(start),
    poll: vi.fn(async () => {
      const p = polls.shift();
      if (!p) return new Promise<never>(() => undefined);
      if (p instanceof Error) throw p;
      return p;
    }),
    cancel: vi.fn(async () => undefined),
    now: () => 0,
    setTimer: (fn) => (queueMicrotask(fn), 0),
    clearTimer: () => undefined
  };
  const flow = createSignInFlow(api);
  const snaps: SignInFlowState[] = [];
  flow.subscribe(() => snaps.push(flow.get()));
  return { flow, api, snaps, states: () => snaps.map((s) => s.phase) };
}

describe('signInFlow (D173)', () => {
  it('shows the code while waiting and returns to idle on done', async () => {
    const r = rig([{ state: 'pending', intervalMs: 5 }, { state: 'done', status: {} as AccountStatus }]);
    await r.flow.start();
    expect(r.states()).toEqual(['starting', 'waiting', 'idle']);
    expect(r.snaps[1]).toEqual({ phase: 'waiting', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 900_000 });
    expect(JSON.stringify(r.snaps)).not.toMatch(/token/i);
  });

  it('a cancel while main is still starting the flow never shows its code', async () => {
    let release: (v: typeof START) => void = () => undefined;
    const r = rig([], () => new Promise((ok) => (release = ok)));
    const p = r.flow.start();
    r.flow.cancel();
    release(START);
    await p;
    expect(r.states()).toEqual(['starting', 'idle']);
  });

  it('a start that fails after a cancel stays idle', async () => {
    let fail: (e: Error) => void = () => undefined;
    const r = rig([], () => new Promise((_ok, no) => (fail = no)));
    const p = r.flow.start();
    r.flow.cancel();
    fail(new Error('late'));
    await p;
    expect(r.flow.get()).toEqual({ phase: 'idle' });
  });

  it('a reset while main is still starting the flow never shows its code', async () => {
    let release: (v: typeof START) => void = () => undefined;
    const r = rig([], () => new Promise((ok) => (release = ok)));
    const p = r.flow.start();
    r.flow.reset();
    release(START);
    await p;
    expect(r.states()).toEqual(['starting', 'idle']);
    expect(r.api.cancel).not.toHaveBeenCalled();
  });

  it('a second start while one runs is ignored', async () => {
    const r = rig([]);
    void r.flow.start();
    void r.flow.start();
    await Promise.resolve();
    expect(r.api.start).toHaveBeenCalledOnce();
  });

  it('an error from GitHub or from start shows its message', async () => {
    const r = rig([{ state: 'error', message: 'Sign-in was cancelled on GitHub.' }]);
    await r.flow.start();
    expect(r.flow.get()).toEqual({ phase: 'error', message: 'Sign-in was cancelled on GitHub.' });
    const n = rig([], async () => {
      throw new Error("Error invoking remote method 'identity:signInStart': Error: not-configured: Set the GitHub client ID");
    });
    await n.flow.start();
    expect(n.flow.get()).toEqual({ phase: 'error', message: 'Set the GitHub client ID' });
  });

  it('cancel stops polling, tells main, and goes idle', async () => {
    const r = rig([]);
    const p = r.flow.start();
    await Promise.resolve();
    r.flow.cancel();
    await p;
    expect(r.flow.get().phase).toBe('idle');
    expect(r.api.cancel).toHaveBeenCalledOnce();
  });

  it('reset drops a pending flow without cancelling main (signed in elsewhere)', async () => {
    const r = rig([]);
    const p = r.flow.start();
    await Promise.resolve();
    r.flow.reset();
    await p;
    expect(r.flow.get().phase).toBe('idle');
    expect(r.api.cancel).not.toHaveBeenCalled();
  });
});
