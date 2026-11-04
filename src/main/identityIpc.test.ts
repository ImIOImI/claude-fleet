import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_CHANNELS, registerIdentityIpc, type IdentityIpcApi } from './identityIpc.js';
import { IdentityService } from './identity/identityService.js';

function harness(svc: IdentityIpcApi) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerIdentityIpc({ handle: (ch, fn) => void handlers.set(ch, fn as (...args: unknown[]) => unknown) }, svc);
  const call = (ch: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(ch)!({}, ...args));
  return { handlers, call };
}

function mockSvc() {
  return {
    status: vi.fn(async () => ({}) as never),
    signInStart: vi.fn(async () => ({}) as never),
    signInPoll: vi.fn(async () => ({}) as never),
    signInCancel: vi.fn(),
    signOut: vi.fn(async () => undefined)
  };
}

describe('identity:* IPC', () => {
  it('registers exactly the identity channels', () => {
    expect([...harness(mockSvc()).handlers.keys()].sort()).toEqual([...IDENTITY_CHANNELS].sort());
    expect(IDENTITY_CHANNELS).toEqual([
      'identity:status',
      'identity:signInStart',
      'identity:signInPoll',
      'identity:signInCancel',
      'identity:signOut'
    ]);
  });

  it('passes refresh only when it is literally true, and nothing else', async () => {
    const svc = mockSvc();
    const { call } = harness(svc);
    await call('identity:status', { refresh: true, extra: 'x' });
    await call('identity:status', { refresh: 'yes' });
    await call('identity:status', { refresh: 1 });
    await call('identity:status', [true]);
    await call('identity:status', 'refresh');
    await call('identity:status', null);
    await call('identity:status');
    expect(svc.status.mock.calls).toEqual([
      [{ refresh: true }],
      [{ refresh: false }],
      [{ refresh: false }],
      [{ refresh: false }],
      [{ refresh: false }],
      [{ refresh: false }],
      [{ refresh: false }]
    ]);
  });

  it('a getter named refresh is not trusted', async () => {
    const svc = mockSvc();
    const { call } = harness(svc);
    const opts = Object.create({ refresh: true }) as object;
    await call('identity:status', opts);
    expect(svc.status.mock.calls).toEqual([[{ refresh: false }]]);
  });

  it('forwards no renderer arguments to the argument-less methods', async () => {
    const svc = mockSvc();
    const { call } = harness(svc);
    await call('identity:signInStart', 'Iv1.evil', { scope: 'repo' });
    await call('identity:signInPoll', { deviceCode: 'x' });
    await call('identity:signInCancel', 1);
    await call('identity:signOut', 'all');
    expect(svc.signInStart.mock.calls).toEqual([[]]);
    expect(svc.signInPoll.mock.calls).toEqual([[]]);
    expect(svc.signInCancel.mock.calls).toEqual([[]]);
    expect(svc.signOut.mock.calls).toEqual([[]]);
  });

  it('signInCancel and signOut resolve to undefined', async () => {
    const svc = mockSvc();
    svc.signInCancel.mockReturnValue('leak' as never);
    svc.signOut.mockResolvedValue('leak' as never);
    const { call } = harness(svc);
    expect(await call('identity:signInCancel')).toBeUndefined();
    expect(await call('identity:signOut')).toBeUndefined();
  });

  it('never returns the token or device code over any channel', async () => {
    const TOKEN = 'gho_secret_token';
    const store = new Map<string, string>();
    let t = 0;
    const svc = new IdentityService({
      vault: {
        isVaultAvailable: async () => true,
        getSecret: async (s, k) => store.get(`${s}|${k}`) ?? null,
        setSecret: async (s, k, v) => void store.set(`${s}|${k}`, v),
        deleteAllForWorkspace: async () => store.clear()
      },
      clientId: async () => 'Iv1.testclient',
      now: () => t,
      github: {
        requestDeviceCode: async () => ({
          deviceCode: 'dc-secret',
          userCode: 'U-1',
          verificationUri: 'https://github.com/login/device',
          expiresAt: 900_000,
          intervalMs: 5000
        }),
        pollDeviceToken: async () => ({ status: 'done', token: TOKEN, scopes: ['read:org', 'read:packages'] }),
        probe: async () => ({
          identity: { provider: 'github', kind: 'user', login: 'octo', id: 42, name: null, avatarUrl: null, teams: [] },
          scopes: ['read:org', 'read:packages'],
          sso: null
        })
      }
    });
    const { call } = harness(svc);
    const out: unknown[] = [];
    out.push(await call('identity:signInStart'));
    out.push(await call('identity:signInPoll'));
    t = 5000;
    out.push(await call('identity:signInPoll'));
    out.push(await call('identity:status'));
    out.push(await call('identity:status', { refresh: true }));
    out.push(await call('identity:signInCancel'));
    out.push(await call('identity:signOut'));
    out.push(await call('identity:status'));
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(TOKEN);
    expect(wire).not.toContain('dc-secret');
    expect(wire).toContain('octo');
    expect(await svc.packagesToken()).toBeNull();
  });
});
