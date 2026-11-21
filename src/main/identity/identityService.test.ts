import { describe, expect, it, vi } from 'vitest';
import { IdentityService, toAccountSso } from './identityService.js';
import { DeviceFlowError, type DeviceCode, type PollResult } from './deviceFlow.js';
import { IdentityError, type Identity } from './types.js';
import type { GithubProbe } from './githubProvider.js';

const CODE: DeviceCode = {
  deviceCode: 'dc-secret',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresAt: 900_000,
  intervalMs: 5000
};
const IDENT: Identity = {
  provider: 'github',
  kind: 'user',
  login: 'octo',
  id: 42,
  name: null,
  avatarUrl: 'https://avatars.githubusercontent.com/u/42',
  teams: ['acme/platform']
};
const PROBE: GithubProbe = { identity: IDENT, scopes: ['read:org', 'read:packages'], sso: null };
const TOKEN = 'gho_secret_token';
const DONE: PollResult = { status: 'done', token: TOKEN, scopes: ['read:org', 'read:packages'] };

function fakeVault(available: boolean) {
  const store = new Map<string, string>();
  return {
    store,
    api: {
      isVaultAvailable: vi.fn(async () => available),
      getSecret: vi.fn(async (s: string, k: string) => store.get(`${s}|${k}`) ?? null),
      setSecret: vi.fn(async (s: string, k: string, v: string) => void store.set(`${s}|${k}`, v)),
      deleteAllForWorkspace: vi.fn(async (s: string) => {
        for (const k of [...store.keys()]) if (k.startsWith(`${s}|`)) store.delete(k);
      })
    }
  };
}

function setup(
  o: {
    clientId?: string | null;
    vaultAvailable?: boolean;
    polls?: Array<PollResult | Error>;
    probe?: GithubProbe | Error;
    patToken?: () => Promise<string | null>;
  } = {}
) {
  let t = 0;
  const polls = [...(o.polls ?? [])];
  let probe: GithubProbe | Error = o.probe ?? PROBE;
  const vault = fakeVault(o.vaultAvailable ?? true);
  const github = {
    requestDeviceCode: vi.fn(async () => CODE),
    pollDeviceToken: vi.fn(async () => {
      const r = polls.shift();
      if (!r) throw new Error('unexpected poll');
      if (r instanceof Error) throw r;
      return r;
    }),
    probe: vi.fn(async () => {
      if (probe instanceof Error) throw probe;
      return probe;
    })
  };
  const svc = new IdentityService({
    vault: vault.api,
    clientId: async () => (o.clientId === undefined ? 'Iv1.testclient' : o.clientId),
    github,
    now: () => t,
    patToken: o.patToken
  });
  return {
    svc,
    vault,
    github,
    advance: (ms: number) => {
      t += ms;
    },
    setProbe: (p: GithubProbe | Error) => {
      probe = p;
    }
  };
}

async function signIn(s: ReturnType<typeof setup>) {
  await s.svc.signInStart();
  s.advance(5000);
  const r = await s.svc.signInPoll();
  if (r.state !== 'done') throw new Error(`expected done, got ${JSON.stringify(r)}`);
  return r.status;
}

describe('IdentityService status', () => {
  it('reports signed out with configured + persisted', async () => {
    const { svc } = setup();
    expect(await svc.status()).toEqual({
      configured: true,
      persisted: true,
      signedIn: false,
      identity: null,
      scopes: [],
      packagesAccess: false,
      sso: null,
      notice: null,
      source: null
    });
  });

  it('reports not configured when no client id resolves', async () => {
    const { svc } = setup({ clientId: null });
    expect((await svc.status()).configured).toBe(false);
    await expect(svc.signInStart()).rejects.toThrow(
      "not-configured: GitHub sign-in isn't configured. Enter your organization's GitHub OAuth client ID in Settings → Account."
    );
  });
});

describe('IdentityService device-flow sign-in', () => {
  it('runs start → pending → done, stores the token in the vault and never returns it', async () => {
    const s = setup({ polls: [{ status: 'pending', intervalMs: 5000 }, DONE] });
    const start = await s.svc.signInStart();
    expect(start).toEqual({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 900_000, intervalMs: 5000 });
    expect(JSON.stringify(start)).not.toContain('dc-secret');

    // Too early: answered locally, no request to GitHub.
    expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 5000 });
    expect(s.github.pollDeviceToken).not.toHaveBeenCalled();

    s.advance(5000);
    expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 5000 });
    expect(s.github.pollDeviceToken).toHaveBeenCalledWith('Iv1.testclient', 'dc-secret', 5000);

    s.advance(5000);
    const done = await s.svc.signInPoll();
    expect(done.state).toBe('done');
    if (done.state !== 'done') return;
    expect(done.status).toMatchObject({
      signedIn: true,
      persisted: true,
      packagesAccess: true,
      scopes: ['read:org', 'read:packages'],
      identity: { provider: 'github', login: 'octo', id: 42, name: null, displayName: 'octo', teams: ['acme/platform'] }
    });
    expect(JSON.stringify(done)).not.toContain(TOKEN);
    expect(s.vault.store.get('identity:github|TOKEN')).toBe(TOKEN);
    expect(JSON.parse(s.vault.store.get('identity:github|PROFILE') ?? '{}').identity.login).toBe('octo');
    expect(s.github.probe).toHaveBeenCalledWith(TOKEN);
    expect(JSON.stringify(await s.svc.status())).not.toContain(TOKEN);
  });

  it('adopts a slower interval after slow_down', async () => {
    const s = setup({ polls: [{ status: 'pending', intervalMs: 10_000 }] });
    await s.svc.signInStart();
    s.advance(5000);
    expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 10_000 });
    s.advance(5000);
    expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 5000 });
    expect(s.github.pollDeviceToken).toHaveBeenCalledTimes(1);
  });

  it('reports an expired code without polling', async () => {
    const s = setup();
    await s.svc.signInStart();
    s.advance(900_000);
    expect(await s.svc.signInPoll()).toEqual({ state: 'error', message: 'The sign-in code expired. Start again.' });
    expect(s.github.pollDeviceToken).not.toHaveBeenCalled();
  });

  it('ends the flow on a terminal device-flow error', async () => {
    const s = setup({ polls: [new DeviceFlowError('denied', 'Sign-in was cancelled on GitHub.')] });
    await s.svc.signInStart();
    s.advance(5000);
    expect(await s.svc.signInPoll()).toEqual({ state: 'error', message: 'Sign-in was cancelled on GitHub.' });
    expect(await s.svc.signInPoll()).toEqual({ state: 'error', message: 'No sign-in in progress.' });
  });

  it('keeps polling through a network blip', async () => {
    const s = setup({ polls: [new DeviceFlowError('network', 'offline'), DONE] });
    await s.svc.signInStart();
    s.advance(5000);
    expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 5000 });
    s.advance(5000);
    expect((await s.svc.signInPoll()).state).toBe('done');
  });

  it('cancel abandons the flow', async () => {
    const s = setup({ polls: [DONE] });
    await s.svc.signInStart();
    s.svc.signInCancel();
    s.advance(5000);
    expect(await s.svc.signInPoll()).toEqual({ state: 'error', message: 'No sign-in in progress.' });
    expect(s.vault.store.size).toBe(0);
  });

  it('keeps the sign-in in memory when the vault is unavailable', async () => {
    const s = setup({ vaultAvailable: false, polls: [DONE] });
    const status = await signIn(s);
    expect(status).toMatchObject({ signedIn: true, persisted: false });
    expect(s.vault.api.setSecret).not.toHaveBeenCalled();
    expect((await s.svc.status()).signedIn).toBe(true);
    expect(await s.svc.packagesToken()).toBe(TOKEN);
  });
});

describe('IdentityService refresh, sign-out and the packages token', () => {
  it('clears a revoked token on refresh and says why', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    s.setProbe(new IdentityError('unauthorized', 'GitHub rejected the token', 401));
    const st = await s.svc.status({ refresh: true });
    expect(st.signedIn).toBe(false);
    expect(st.notice).toBe('GitHub no longer accepts the saved sign-in (revoked or expired). Sign in again.');
    expect(s.vault.store.size).toBe(0);
  });

  it('keeps the cached profile when GitHub is unreachable', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    s.setProbe(new IdentityError('network', 'GitHub unreachable (TypeError)'));
    expect((await s.svc.status({ refresh: true })).identity?.login).toBe('octo');
  });

  it('refresh picks up new teams and SSO hints', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    s.setProbe({ ...PROBE, identity: { ...IDENT, teams: ['acme/eng'] }, sso: { url: 'https://github.com/orgs/acme/sso', org: 'acme', orgIds: [] } });
    const st = await s.svc.status({ refresh: true });
    expect(st.identity?.teams).toEqual(['acme/eng']);
    expect(st.sso).toEqual({
      url: 'https://github.com/orgs/acme/sso',
      org: 'acme',
      orgCount: 0,
      appSettingsUrl: 'https://github.com/settings/connections/applications/Iv1.testclient'
    });
  });

  it('sign-out purges the identity scope', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    await s.svc.signOut();
    expect(s.vault.api.deleteAllForWorkspace).toHaveBeenCalledWith('identity:github');
    expect((await s.svc.status()).signedIn).toBe(false);
    expect(await s.svc.packagesToken()).toBeNull();
  });

  it('offers the token for packages only with read:packages', async () => {
    const withPkgs = setup({ polls: [DONE] });
    await signIn(withPkgs);
    expect(await withPkgs.svc.packagesToken()).toBe(TOKEN);

    const without = setup({ polls: [{ status: 'done', token: TOKEN, scopes: ['read:org'] }], probe: { ...PROBE, scopes: ['read:org'] } });
    await signIn(without);
    expect(await without.svc.packagesToken()).toBeNull();
    expect((await without.svc.status()).packagesAccess).toBe(false);

    expect(await setup().svc.packagesToken()).toBeNull();
  });

  it('offers the bearer token for remote hosts whatever its scopes, and none once signed out', async () => {
    const s = setup({ polls: [{ status: 'done', token: TOKEN, scopes: ['read:org'] }], probe: { ...PROBE, scopes: ['read:org'] } });
    expect(await s.svc.bearerToken()).toBeNull();
    await signIn(s);
    expect(await s.svc.bearerToken()).toBe(TOKEN);
    await s.svc.signOut();
    expect(await s.svc.bearerToken()).toBeNull();
  });

  it('reports the signed-in login, and null once signed out', async () => {
    const s = setup({ polls: [{ status: 'done', token: TOKEN, scopes: ['read:org'] }], probe: { ...PROBE, scopes: ['read:org'] } });
    expect(await s.svc.currentLogin()).toBeNull();
    await signIn(s);
    expect(await s.svc.currentLogin()).toBe(PROBE.identity.login);
    await s.svc.signOut();
    expect(await s.svc.currentLogin()).toBeNull();
  });
});

describe('toAccountSso', () => {
  it('counts partial-results orgs and links the app settings page', () => {
    expect(toAccountSso({ url: null, org: null, orgIds: [7, 9] }, 'Iv1.testclient')).toEqual({
      url: null,
      org: null,
      orgCount: 2,
      appSettingsUrl: 'https://github.com/settings/connections/applications/Iv1.testclient'
    });
    expect(toAccountSso({ url: null, org: null, orgIds: [] }, null).appSettingsUrl).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('IdentityService transient failures', () => {
  it('keeps the saved sign-in and says so when a refresh fails transiently', async () => {
    for (const err of [
      new IdentityError('network', 'GitHub unreachable (TypeError)'),
      new IdentityError('upstream', 'GitHub teams lookup failed (HTTP 502)', 502),
      new IdentityError('forbidden', 'not acceptable', 403)
    ]) {
      const s = setup({ polls: [DONE] });
      await signIn(s);
      s.setProbe(err);
      const st = await s.svc.status({ refresh: true });
      expect(st).toMatchObject({ signedIn: true, identity: { login: 'octo', teams: ['acme/platform'] } });
      expect(st.notice).toMatch(/^Couldn't refresh your GitHub account/);
      expect(s.vault.store.get('identity:github|TOKEN')).toBe(TOKEN);
    }
  });

  it('clears the refresh notice once a refresh succeeds', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    s.setProbe(new IdentityError('network', 'offline'));
    await s.svc.status({ refresh: true });
    s.setProbe(PROBE);
    expect((await s.svc.status({ refresh: true })).notice).toBeNull();
  });

  it('fails a sign-in whose profile read fails transiently, storing nothing', async () => {
    const s = setup({ polls: [DONE], probe: new IdentityError('upstream', 'GitHub teams lookup failed (HTTP 502)', 502) });
    await s.svc.signInStart();
    s.advance(5000);
    const r = await s.svc.signInPoll();
    expect(r.state).toBe('error');
    if (r.state === 'error') expect(r.message).toMatch(/try again/i);
    expect(s.vault.store.size).toBe(0);
    expect((await s.svc.status()).signedIn).toBe(false);
  });

  it('never echoes a non-IdentityError message from the profile read', async () => {
    const s = setup({ polls: [DONE], probe: new Error(`boom ${TOKEN}`) });
    await s.svc.signInStart();
    s.advance(5000);
    const r = await s.svc.signInPoll();
    expect(r.state).toBe('error');
    expect(JSON.stringify(r).includes(TOKEN)).toBe(false);
  });
});

describe('IdentityService sign-out wins races', () => {
  function racing() {
    const s = setup({ polls: [DONE] });
    const gate = deferred<GithubProbe>();
    return { s, gate, hold: () => s.github.probe.mockImplementationOnce(() => gate.promise) };
  }

  it('a refresh in flight during sign-out does not resurrect the token', async () => {
    const { s, gate, hold } = racing();
    await signIn(s);
    hold();
    const refreshing = s.svc.status({ refresh: true });
    await s.svc.signOut();
    gate.resolve(PROBE);
    expect((await refreshing).signedIn).toBe(false);
    expect(s.vault.store.size).toBe(0);
    expect(await s.svc.packagesToken()).toBeNull();
  });

  it('a sign-in whose profile read is in flight during sign-out is discarded', async () => {
    const { s, gate, hold } = racing();
    hold();
    await s.svc.signInStart();
    s.advance(5000);
    const polling = s.svc.signInPoll();
    await vi.waitFor(() => expect(s.github.probe).toHaveBeenCalled());
    await s.svc.signOut();
    gate.resolve(PROBE);
    expect((await polling).state).toBe('error');
    expect(s.vault.store.size).toBe(0);
  });

  it('a sign-in whose profile read is in flight during cancel is discarded', async () => {
    const { s, gate, hold } = racing();
    hold();
    await s.svc.signInStart();
    s.advance(5000);
    const polling = s.svc.signInPoll();
    await vi.waitFor(() => expect(s.github.probe).toHaveBeenCalled());
    s.svc.signInCancel();
    gate.resolve(PROBE);
    expect((await polling).state).toBe('error');
    expect(s.vault.store.size).toBe(0);
  });

  it('a refresh in flight while a new sign-in completes does not restore the old token', async () => {
    const NEW = 'gho_new_token';
    const s = setup({ polls: [DONE, { status: 'done', token: NEW, scopes: ['read:org', 'read:packages'] }] });
    await signIn(s);
    const gate = deferred<GithubProbe>();
    s.github.probe.mockImplementationOnce(() => gate.promise);
    const refreshing = s.svc.status({ refresh: true });
    await vi.waitFor(() => expect(s.github.probe).toHaveBeenCalledTimes(2));
    await signIn(s);
    gate.resolve(PROBE);
    await refreshing;
    expect(s.vault.store.get('identity:github|TOKEN') === NEW).toBe(true);
  });

  it('sign-out clears an in-memory sign-in when the vault is unavailable', async () => {
    const s = setup({ vaultAvailable: false, polls: [DONE] });
    await signIn(s);
    await s.svc.signOut();
    expect((await s.svc.status()).signedIn).toBe(false);
    expect(await s.svc.packagesToken()).toBeNull();
  });
});

describe('IdentityService saved-profile validation', () => {
  async function withProfile(profile: unknown) {
    const s = setup();
    s.vault.store.set('identity:github|TOKEN', TOKEN);
    s.vault.store.set('identity:github|PROFILE', typeof profile === 'string' ? profile : JSON.stringify(profile));
    return s;
  }
  const GOOD = { identity: IDENT, scopes: ['read:org', 'read:packages'], sso: null, verifiedAt: 1 };

  it('accepts a well-formed saved profile', async () => {
    const s = await withProfile(GOOD);
    expect((await s.svc.status()).signedIn).toBe(true);
  });

  it.each([
    ['a machine identity', { ...GOOD, identity: { ...IDENT, kind: 'machine', appId: 1 } }],
    ['a non-github provider', { ...GOOD, identity: { ...IDENT, provider: 'other' } }],
    ['non-string teams', { ...GOOD, identity: { ...IDENT, teams: [1] } }],
    ['non-string scopes', { ...GOOD, scopes: [1] }],
    ['malformed sso', { ...GOOD, sso: { url: 1, org: null, orgIds: [] } }],
    ['invalid JSON', '{nope']
  ])('treats %s as signed out and withholds the token', async (_label, profile) => {
    const s = await withProfile(profile);
    expect((await s.svc.status()).signedIn).toBe(false);
    expect(await s.svc.packagesToken()).toBeNull();
  });

  it('drops a saved SSO url that is not https://github.com', async () => {
    const s = await withProfile({ ...GOOD, sso: { url: 'https://evil.example/orgs/acme/sso', org: 'acme', orgIds: [] } });
    expect((await s.svc.status()).sso?.url).toBeNull();
  });
});

describe('IdentityService save/sign-out serialisation', () => {
  /** Serialises writes like vault.ts withLock; holds the next PROFILE write until released. */
  function lockingVault() {
    const store = new Map<string, string>();
    let chain: Promise<unknown> = Promise.resolve();
    let release: (() => void) | null = null;
    let armed = false;
    const lock = <T>(fn: () => Promise<T>) => {
      const n = chain.then(fn);
      chain = n.catch(() => {});
      return n;
    };
    const api = {
      isVaultAvailable: vi.fn(async () => true),
      getSecret: vi.fn(async (s: string, k: string) => store.get(`${s}|${k}`) ?? null),
      setSecret: vi.fn((s: string, k: string, v: string) =>
        lock(async () => {
          if (k === 'PROFILE' && armed) {
            armed = false;
            await new Promise<void>((r) => (release = r));
          }
          store.set(`${s}|${k}`, v);
        })
      ),
      deleteAllForWorkspace: vi.fn((s: string) =>
        lock(async () => {
          for (const k of [...store.keys()]) if (k.startsWith(`${s}|`)) store.delete(k);
        })
      )
    };
    return {
      store,
      api,
      arm: () => {
        armed = true;
      },
      held: () => release !== null,
      release: () => release?.()
    };
  }

  function lockedSetup(polls: PollResult[] = [DONE]) {
    const v = lockingVault();
    let t = 0;
    const queue = [...polls];
    const github = {
      requestDeviceCode: vi.fn(async () => CODE),
      pollDeviceToken: vi.fn(async () => queue.shift() ?? { status: 'pending' as const, intervalMs: 5000 }),
      probe: vi.fn(async (): Promise<GithubProbe> => PROBE)
    };
    const svc = new IdentityService({ vault: v.api, clientId: async () => 'Iv1.testclient', github, now: () => t });
    return { v, svc, github, advance: (ms: number) => void (t += ms) };
  }

  it('sign-out during a refresh save leaves no TOKEN behind', async () => {
    const { v, svc } = lockedSetup();
    v.store.set('identity:github|TOKEN', TOKEN);
    v.store.set('identity:github|PROFILE', JSON.stringify({ identity: IDENT, scopes: ['read:org', 'read:packages'], sso: null, verifiedAt: 0 }));
    v.arm();
    const refreshing = svc.status({ refresh: true });
    await vi.waitFor(() => expect(v.held()).toBe(true));
    const out = svc.signOut();
    v.release();
    const [st] = await Promise.all([refreshing, out]);
    expect(st.signedIn).toBe(false);
    expect([...v.store.keys()]).toEqual([]);
  });

  it('sign-out during a sign-in save leaves no TOKEN behind', async () => {
    const { v, svc, advance } = lockedSetup();
    await svc.signInStart();
    advance(5000);
    v.arm();
    const polling = svc.signInPoll();
    await vi.waitFor(() => expect(v.held()).toBe(true));
    const out = svc.signOut();
    v.release();
    const [r] = await Promise.all([polling, out]);
    expect(r.state).toBe('error');
    expect([...v.store.keys()]).toEqual([]);
    expect(await svc.packagesToken()).toBeNull();
  });

  it.each(['cancel', 'start'] as const)('%s during a refresh save keeps the valid sign-in', async (action) => {
    const { v, svc } = lockedSetup();
    v.store.set('identity:github|TOKEN', TOKEN);
    v.store.set('identity:github|PROFILE', JSON.stringify({ identity: IDENT, scopes: ['read:org', 'read:packages'], sso: null, verifiedAt: 0 }));
    v.arm();
    const refreshing = svc.status({ refresh: true });
    await vi.waitFor(() => expect(v.held()).toBe(true));
    if (action === 'cancel') svc.signInCancel();
    else await svc.signInStart();
    v.release();
    expect((await refreshing).signedIn).toBe(true);
    expect([...v.store.keys()].sort()).toEqual(['identity:github|PROFILE', 'identity:github|TOKEN']);
    expect(await svc.packagesToken() === TOKEN).toBe(true);
  });

  it('a concurrent poll while the profile is being read says pending, not "no sign-in"', async () => {
    const { svc, github, advance } = lockedSetup();
    const gate = deferred<GithubProbe>();
    github.probe.mockImplementationOnce(() => gate.promise);
    await svc.signInStart();
    advance(5000);
    const first = svc.signInPoll();
    await vi.waitFor(() => expect(github.probe).toHaveBeenCalled());
    expect((await svc.signInPoll()).state).toBe('pending');
    expect(github.pollDeviceToken).toHaveBeenCalledTimes(1);
    gate.resolve(PROBE);
    expect((await first).state).toBe('done');
    expect((await svc.signInPoll()).state).toBe('error');
  });

  it('starting a new sign-in discards one whose profile read is in flight', async () => {
    const { v, svc, github, advance } = lockedSetup();
    const gate = deferred<GithubProbe>();
    github.probe.mockImplementationOnce(() => gate.promise);
    await svc.signInStart();
    advance(5000);
    const first = svc.signInPoll();
    await vi.waitFor(() => expect(github.probe).toHaveBeenCalled());
    await svc.signInStart();
    gate.resolve(PROBE);
    expect((await first).state).toBe('error');
    expect(v.store.size).toBe(0);
  });

  it('a refresh probe with no scopes (missing X-OAuth-Scopes) keeps the saved scopes', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    s.setProbe({ ...PROBE, scopes: [] });
    const st = await s.svc.status({ refresh: true });
    expect(st).toMatchObject({ scopes: ['read:org', 'read:packages'], packagesAccess: true });
    expect(await s.svc.packagesToken()).toBe(TOKEN);
  });
});

describe('IdentityService throttled polling', () => {
  it('backs off after a throttled (429/5xx) network result', async () => {
    const s = setup({ polls: [new DeviceFlowError('network', 'GitHub is temporarily unavailable (HTTP 503).', true), DONE] });
    await s.svc.signInStart();
    s.advance(5000);
    expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 10_000 });
    s.advance(5000);
    expect((await s.svc.signInPoll()).state).toBe('pending');
    expect(s.github.pollDeviceToken).toHaveBeenCalledTimes(1);
    s.advance(5000);
    expect((await s.svc.signInPoll()).state).toBe('done');
    expect(s.github.pollDeviceToken).toHaveBeenLastCalledWith('Iv1.testclient', 'dc-secret', 10_000);
  });

  it('keeps the interval after a plain transport failure', async () => {
    const s = setup({ polls: [new DeviceFlowError('network', 'offline')] });
    await s.svc.signInStart();
    s.advance(5000);
    expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 5000 });
  });
});

describe('IdentityService revocation and expiry caps', () => {
  const NEW = 'gho_new_token';
  const DONE_NEW: PollResult = { status: 'done', token: NEW, scopes: ['read:org', 'read:packages'] };
  const UNAUTH = () => new IdentityError('unauthorized', 'GitHub rejected the token', 401);

  function rejectable<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('a 401 for the old token does not cancel a sign-in that is finishing', async () => {
    const s = setup({ polls: [DONE, DONE_NEW] });
    await signIn(s);
    await s.svc.signInStart();
    const oldProbe = rejectable<GithubProbe>();
    const newProbe = rejectable<GithubProbe>();
    s.github.probe.mockImplementationOnce(() => oldProbe.promise).mockImplementationOnce(() => newProbe.promise);
    const refreshing = s.svc.status({ refresh: true });
    await vi.waitFor(() => expect(s.github.probe).toHaveBeenCalledTimes(2));
    s.advance(5000);
    const polling = s.svc.signInPoll();
    await vi.waitFor(() => expect(s.github.probe).toHaveBeenCalledTimes(3));
    oldProbe.reject(UNAUTH());
    await refreshing;
    newProbe.resolve(PROBE);
    expect((await polling).state).toBe('done');
    expect(s.vault.store.get('identity:github|TOKEN') === NEW).toBe(true);
  });

  it('a 401 for the old token arriving after a new sign-in saved leaves the new token', async () => {
    const s = setup({ polls: [DONE, DONE_NEW] });
    await signIn(s);
    const oldProbe = rejectable<GithubProbe>();
    s.github.probe.mockImplementationOnce(() => oldProbe.promise);
    const refreshing = s.svc.status({ refresh: true });
    await vi.waitFor(() => expect(s.github.probe).toHaveBeenCalledTimes(2));
    await signIn(s);
    oldProbe.reject(UNAUTH());
    const st = await refreshing;
    expect(st.signedIn).toBe(true);
    expect(st.notice).toBeNull();
    expect(s.vault.store.get('identity:github|TOKEN') === NEW).toBe(true);
  });

  it('a 401 still clears the revoked token after an unrelated cancel', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    const oldProbe = rejectable<GithubProbe>();
    s.github.probe.mockImplementationOnce(() => oldProbe.promise);
    const refreshing = s.svc.status({ refresh: true });
    s.svc.signInCancel();
    oldProbe.reject(UNAUTH());
    expect((await refreshing).signedIn).toBe(false);
    expect(s.vault.store.size).toBe(0);
  });

  it('a concurrent successful refresh of a revoked token does not save it back', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    const a = rejectable<GithubProbe>();
    const b = rejectable<GithubProbe>();
    s.github.probe.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const ra = s.svc.status({ refresh: true });
    const rb = s.svc.status({ refresh: true });
    await vi.waitFor(() => expect(s.github.probe).toHaveBeenCalledTimes(3));
    a.reject(UNAUTH());
    await ra;
    b.resolve(PROBE);
    expect((await rb).signedIn).toBe(false);
    expect(s.vault.store.size).toBe(0);
  });

  describe('reads wait for queued writes', () => {
    function heldSave() {
      const s = setup({ polls: [DONE] });
      let release!: () => void;
      return {
        s,
        async start() {
          await signIn(s);
          s.vault.api.setSecret.mockImplementationOnce(async (sc: string, k: string, v: string) => {
            await new Promise<void>((r) => (release = r));
            s.vault.store.set(`${sc}|${k}`, v);
          });
          const refreshing = s.svc.status({ refresh: true });
          await vi.waitFor(() => expect(release).toBeTypeOf('function'));
          const out = s.svc.signOut();
          return { refreshing, out, release: () => release() };
        }
      };
    }

    it('packagesToken() during a queued sign-out returns null', async () => {
      const h = heldSave();
      const { refreshing, out, release } = await h.start();
      const tok = h.s.svc.packagesToken();
      release();
      await Promise.all([refreshing, out]);
      expect(await tok).toBeNull();
    });

    it('status() during a queued sign-out reports signed out', async () => {
      const h = heldSave();
      const { refreshing, out, release } = await h.start();
      const st = h.s.svc.status();
      release();
      await Promise.all([refreshing, out]);
      expect((await st).signedIn).toBe(false);
    });
  });

  describe('signInPoll waits', () => {
    function soon(expiresAt: number, polls: Array<PollResult | Error> = []) {
      const s = setup({ polls });
      s.github.requestDeviceCode.mockResolvedValueOnce({ ...CODE, expiresAt });
      return s;
    }

    it('caps the start interval and every pending wait at the time left', async () => {
      const s = soon(8000, [{ status: 'pending', intervalMs: 5000 }]);
      expect((await s.svc.signInStart()).intervalMs).toBe(5000);
      s.advance(1000);
      expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 4000 });
      s.advance(4000);
      expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 3000 });

      const t = soon(3000);
      expect((await t.svc.signInStart()).intervalMs).toBe(3000);
      expect(await t.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 3000 });
    });

    it('caps the wait after a network blip at the time left', async () => {
      const s = soon(7000, [new DeviceFlowError('network', 'offline')]);
      await s.svc.signInStart();
      s.advance(5000);
      expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 2000 });
    });

    it('caps every returned wait at 60s but still polls GitHub no faster than its interval', async () => {
      const s = setup({ polls: [{ status: 'pending', intervalMs: 90_000 }] });
      await s.svc.signInStart();
      s.advance(5000);
      expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 60_000 });
      s.advance(60_000);
      expect(await s.svc.signInPoll()).toEqual({ state: 'pending', intervalMs: 30_000 });
      expect(s.github.pollDeviceToken).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ['http:', 'http://avatars.githubusercontent.com/u/42'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:image/png;base64,AAAA'],
    ['garbage', 'not a url']
  ])('drops a %s avatar URL', async (_label, avatarUrl) => {
    const s = setup({ polls: [DONE], probe: { ...PROBE, identity: { ...IDENT, avatarUrl } } });
    expect((await signIn(s)).identity?.avatarUrl).toBeNull();
    expect((await s.svc.status()).identity?.avatarUrl).toBeNull();
  });

  it('keeps an https avatar URL', async () => {
    const s = setup({ polls: [DONE] });
    expect((await signIn(s)).identity?.avatarUrl).toBe('https://avatars.githubusercontent.com/u/42');
  });
});

describe('IdentityService vault PAT', () => {
  const PAT = 'ghp_vault_pat';
  const PAT_IDENT: Identity = { ...IDENT, login: 'pat-user', id: 7 };
  const PAT_PROBE: GithubProbe = { identity: PAT_IDENT, scopes: ['read:org', 'read:packages'], sso: null };
  const REJECTED = 'The GitHub token in the Vault was rejected (401).';
  const FINE_GRAINED =
    'Fine-grained tokens report no scopes: GHCR access and team grants need a classic token with read:org and read:packages.';
  const UNAUTHORIZED = () => new IdentityError('unauthorized', 'GitHub rejected the token', 401);

  function patSetup(o: Parameters<typeof setup>[0] & { pat?: string | null } = {}) {
    let pat: string | null = o.pat === undefined ? PAT : o.pat;
    const s = setup({ probe: PAT_PROBE, ...o, patToken: async () => pat });
    return {
      ...s,
      setPat: (v: string | null) => {
        pat = v;
      }
    };
  }

  /** Device sign-in first, then a PAT appears in the vault. */
  async function deviceThenPat(o: Parameters<typeof patSetup>[0] = {}) {
    const s = patSetup({ ...o, pat: null, polls: [DONE], probe: PROBE });
    await signIn(s);
    s.setProbe(PAT_PROBE);
    s.setPat(PAT);
    s.github.probe.mockClear();
    return s;
  }

  it('prefers a vault PAT over the device token and verifies it once', async () => {
    const s = await deviceThenPat();
    const s1 = await s.svc.status();
    const s2 = await s.svc.status();
    expect(s1).toMatchObject({ signedIn: true, source: 'pat', identity: { login: 'pat-user' }, packagesAccess: true, notice: null });
    expect(s2.source).toBe('pat');
    expect(await s.svc.bearerToken()).toBe(PAT);
    expect(await s.svc.packagesToken()).toBe(PAT);
    expect(await s.svc.currentLogin()).toBe('pat-user');
    expect(s.github.probe).toHaveBeenCalledTimes(1);
    expect(s.github.probe).toHaveBeenCalledWith(PAT);
    expect(s.vault.store.get('identity:github|TOKEN')).toBe(TOKEN);
    expect(JSON.stringify(s1)).not.toContain(PAT);
  });

  it('trims the PAT and treats a blank one as absent', async () => {
    const s = patSetup({ pat: '  \n' });
    expect(await s.svc.status()).toMatchObject({ signedIn: false, source: null });
    expect(s.github.probe).not.toHaveBeenCalled();
    s.setPat(`  ${PAT}\n`);
    expect(await s.svc.bearerToken()).toBe(PAT);
    expect(s.github.probe).toHaveBeenCalledWith(PAT);
  });

  it('keeps the verification across service instances without storing the PAT', async () => {
    const s = patSetup();
    await s.svc.status();
    const again = new IdentityService({
      vault: s.vault.api,
      clientId: async () => 'Iv1.testclient',
      github: s.github,
      patToken: async () => PAT
    });
    expect(await again.status()).toMatchObject({ signedIn: true, source: 'pat' });
    expect(s.github.probe).toHaveBeenCalledTimes(1);
    expect([...s.vault.store.values()].some((v) => v.includes(PAT))).toBe(false);
  });

  it('re-verifies when the PAT changes', async () => {
    const s = patSetup({ pat: 'ghp_a' });
    expect(await s.svc.bearerToken()).toBe('ghp_a');
    s.setPat('ghp_b');
    expect(await s.svc.bearerToken()).toBe('ghp_b');
    expect(s.github.probe).toHaveBeenCalledTimes(2);
    expect(s.github.probe).toHaveBeenNthCalledWith(1, 'ghp_a');
    expect(s.github.probe).toHaveBeenNthCalledWith(2, 'ghp_b');
  });

  it('a rejected PAT falls back to the device token with a notice and clears nothing', async () => {
    const s = await deviceThenPat();
    s.setProbe(UNAUTHORIZED());
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'device', identity: { login: 'octo' }, notice: REJECTED });
    expect(await s.svc.bearerToken()).toBe(TOKEN);
    expect(s.vault.api.deleteAllForWorkspace).not.toHaveBeenCalled();
    expect(s.vault.store.get('identity:github|TOKEN')).toBe(TOKEN);
    expect(JSON.parse(s.vault.store.get('identity:github|PROFILE') ?? '{}').identity.login).toBe('octo');
    expect(s.vault.store.get('identity:github|PAT_PROFILE')).not.toContain(PAT);
    // Remembered for this PAT: status polls don't re-probe.
    expect(s.github.probe).toHaveBeenCalledTimes(1);
    s.setPat(null);
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'device', identity: { login: 'octo' }, notice: null });
    expect(await s.svc.bearerToken()).toBe(TOKEN);
  });

  it('a rejected PAT with no device token signs nobody in, with the notice', async () => {
    const s = patSetup({ probe: UNAUTHORIZED() });
    expect(await s.svc.status()).toMatchObject({ signedIn: false, source: null, identity: null, notice: REJECTED });
    expect(await s.svc.bearerToken()).toBeNull();
  });

  it('a device sign-in completed while the PAT is rejected stays in effect', async () => {
    const s = patSetup({ probe: UNAUTHORIZED(), polls: [DONE] });
    expect((await s.svc.status()).notice).toBe(REJECTED);
    s.setProbe(PROBE);
    expect((await signIn(s)).signedIn).toBe(true);
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'device', identity: { login: 'octo' }, notice: REJECTED });
    expect(await s.svc.bearerToken()).toBe(TOKEN);
  });

  it('a PAT rejection survives a restart without removing the PAT', async () => {
    const s = await deviceThenPat();
    s.setProbe(UNAUTHORIZED());
    await s.svc.status();
    const fresh = new IdentityService({
      vault: s.vault.api,
      clientId: async () => 'Iv1.testclient',
      github: s.github,
      patToken: async () => PAT
    });
    expect(await fresh.status()).toMatchObject({ signedIn: true, source: 'device', notice: REJECTED });
    expect(await fresh.bearerToken()).toBe(TOKEN);
    expect(s.github.probe).toHaveBeenCalledTimes(1);
  });

  it('a PAT rejection survives a restart with no device token', async () => {
    const s = patSetup({ probe: UNAUTHORIZED() });
    await s.svc.status();
    const fresh = new IdentityService({
      vault: s.vault.api,
      clientId: async () => 'Iv1.testclient',
      github: s.github,
      patToken: async () => PAT
    });
    expect(await fresh.bearerToken()).toBeNull();
    expect(s.github.probe).toHaveBeenCalledTimes(1);
  });

  it('a device sign-out keeps the PAT rejection', async () => {
    const s = await deviceThenPat();
    s.setProbe(UNAUTHORIZED());
    await s.svc.status();
    await s.svc.signOut();
    expect(s.vault.store.has('identity:github|TOKEN')).toBe(false);
    const fresh = new IdentityService({
      vault: s.vault.api,
      clientId: async () => 'Iv1.testclient',
      github: s.github,
      patToken: async () => PAT
    });
    expect(await fresh.status()).toMatchObject({ signedIn: false, notice: REJECTED });
    expect(s.github.probe).toHaveBeenCalledTimes(1);
  });

  it('a replacement for a rejected PAT is verified', async () => {
    const s = patSetup({ probe: UNAUTHORIZED() });
    expect((await s.svc.status()).notice).toBe(REJECTED);
    s.setProbe(PAT_PROBE);
    s.setPat('ghp_new');
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'pat', notice: null });
  });

  it('refresh re-probes a rejected PAT and signs it in once GitHub accepts it', async () => {
    const s = patSetup({ probe: UNAUTHORIZED() });
    await s.svc.status();
    await s.svc.status();
    expect(s.github.probe).toHaveBeenCalledTimes(1);
    s.setProbe(PAT_PROBE);
    expect(await s.svc.status({ refresh: true })).toMatchObject({ signedIn: true, source: 'pat', notice: null });
    expect(s.github.probe).toHaveBeenCalledTimes(2);
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'pat' });
    expect(s.github.probe).toHaveBeenCalledTimes(2);
  });

  it('a transient PAT failure falls back to the device token and backs off for 60s', async () => {
    const s = await deviceThenPat();
    s.setProbe(new IdentityError('network', 'GitHub returned 500', 500));
    const st = await s.svc.status();
    expect(st).toMatchObject({ signedIn: true, source: 'device', identity: { login: 'octo' } });
    expect(st.notice).toBe("Couldn't verify the GitHub token in the Vault (GitHub returned 500).");
    expect(await s.svc.bearerToken()).toBe(TOKEN);
    expect(s.github.probe).toHaveBeenCalledTimes(1);
    s.advance(59_999);
    expect((await s.svc.status()).source).toBe('device');
    expect(s.github.probe).toHaveBeenCalledTimes(1);
    s.setProbe(PAT_PROBE);
    s.advance(1);
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'pat', notice: null });
    expect(s.github.probe).toHaveBeenCalledTimes(2);
  });

  it('a transient PAT failure with no device token signs nobody in', async () => {
    const s = patSetup({ probe: new IdentityError('network', 'offline') });
    expect(await s.svc.status()).toMatchObject({ signedIn: false, source: null, notice: "Couldn't verify the GitHub token in the Vault (offline)." });
    expect(await s.svc.bearerToken()).toBeNull();
  });

  it('refresh re-probes a backed-off PAT', async () => {
    const s = patSetup({ probe: new IdentityError('network', 'offline') });
    await s.svc.status();
    s.setProbe(PAT_PROBE);
    expect(await s.svc.status({ refresh: true })).toMatchObject({ signedIn: true, source: 'pat', notice: null });
    expect(s.github.probe).toHaveBeenCalledTimes(2);
  });

  it('a PAT probe does not hold up a device sign-out', async () => {
    const s = patSetup({ pat: null, polls: [DONE], probe: PROBE });
    await signIn(s);
    let release!: () => void;
    s.github.probe.mockImplementationOnce(
      () =>
        new Promise<GithubProbe>((r) => {
          release = () => r(PAT_PROBE);
        })
    );
    s.setPat(PAT);
    const st = s.svc.status();
    await vi.waitFor(() => expect(release).toBeDefined());
    await s.svc.signOut();
    expect(s.vault.store.has('identity:github|TOKEN')).toBe(false);
    release();
    expect(await st).toMatchObject({ signedIn: true, source: 'pat' });
  });

  it('a PAT changed mid-probe drops the stale result and reports the new PAT', async () => {
    const s = patSetup({ pat: 'ghp_a' });
    let release!: () => void;
    s.github.probe.mockImplementationOnce(
      () =>
        new Promise<GithubProbe>((r) => {
          release = () => r(PAT_PROBE);
        })
    );
    const st = s.svc.status();
    await vi.waitFor(() => expect(release).toBeDefined());
    s.setPat('ghp_b');
    s.setProbe({ ...PAT_PROBE, identity: { ...PAT_IDENT, login: 'b-user' } });
    release();
    expect(await st).toMatchObject({ signedIn: true, source: 'pat', identity: { login: 'b-user' } });
    expect(await s.svc.bearerToken()).toBe('ghp_b');
    expect(s.github.probe).toHaveBeenNthCalledWith(2, 'ghp_b');
  });

  it('a device revoke notice survives the PAT being removed afterwards', async () => {
    const s = await deviceThenPat();
    s.setProbe(UNAUTHORIZED());
    expect(await s.svc.status()).toMatchObject({ source: 'device', notice: REJECTED });
    expect(await s.svc.status({ refresh: true })).toMatchObject({ signedIn: false });
    s.setPat(null);
    const st = await s.svc.status();
    expect(st.signedIn).toBe(false);
    expect(st.notice).toMatch(/no longer accepts the saved sign-in/);
  });

  it('concurrent reads share one PAT probe', async () => {
    const s = patSetup();
    const [a, b] = await Promise.all([s.svc.status(), s.svc.bearerToken()]);
    expect(a.source).toBe('pat');
    expect(b).toBe(PAT);
    expect(s.github.probe).toHaveBeenCalledTimes(1);
  });

  it('fine-grained PAT (no scopes) gets the scopes notice', async () => {
    const s = patSetup({ probe: { ...PAT_PROBE, scopes: [] } });
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'pat', scopes: [], packagesAccess: false, notice: FINE_GRAINED });
    expect(await s.svc.packagesToken()).toBeNull();
    expect(await s.svc.bearerToken()).toBe(PAT);
  });

  it('without a PAT the device token is used with source device', async () => {
    const s = patSetup({ pat: null, polls: [DONE], probe: PROBE });
    expect((await signIn(s)).source).toBe('device');
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'device', identity: { login: 'octo' } });
    expect(await s.svc.bearerToken()).toBe(TOKEN);
  });

  it('removing the PAT falls back to the device token, never pairing the PAT profile with it', async () => {
    const s = await deviceThenPat();
    expect((await s.svc.status()).identity?.login).toBe('pat-user');
    s.setPat(null);
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'device', identity: { login: 'octo' } });
    expect(await s.svc.currentLogin()).toBe('octo');
    expect(await s.svc.bearerToken()).toBe(TOKEN);
  });

  it('a device load ignores a PAT-sourced PROFILE', async () => {
    const s = patSetup({ pat: null });
    s.vault.store.set('identity:github|TOKEN', TOKEN);
    s.vault.store.set(
      'identity:github|PROFILE',
      JSON.stringify({ identity: PAT_IDENT, scopes: [], sso: null, verifiedAt: 1, source: 'pat', tokenSha: 'x' })
    );
    expect(await s.svc.status()).toMatchObject({ signedIn: false, source: null });
  });

  it('removing the PAT with no device token signs out without clearing anything', async () => {
    const s = patSetup();
    await s.svc.status();
    s.setPat(null);
    expect(await s.svc.status()).toMatchObject({ signedIn: false, source: null });
    expect(s.vault.api.deleteAllForWorkspace).not.toHaveBeenCalled();
  });

  it('signOut with a PAT active keeps every saved secret and the PAT sign-in', async () => {
    const s = await deviceThenPat();
    await s.svc.status();
    const before = new Map(s.vault.store);
    await s.svc.signOut();
    expect(s.vault.api.deleteAllForWorkspace).not.toHaveBeenCalled();
    expect(s.vault.store).toEqual(before);
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'pat' });
    expect(s.github.probe).toHaveBeenCalledTimes(1);
  });

  it('a PAT sign-in never writes TOKEN', async () => {
    const s = patSetup();
    await s.svc.status();
    expect(s.vault.api.setSecret.mock.calls.some((c) => c[1] === 'TOKEN')).toBe(false);
    expect(s.vault.store.has('identity:github|TOKEN')).toBe(false);
  });

  it('refresh re-verifies the PAT and picks up new teams without touching TOKEN', async () => {
    const s = patSetup();
    await s.svc.status();
    s.setProbe({ ...PAT_PROBE, identity: { ...PAT_IDENT, teams: ['acme/new'] } });
    expect(await s.svc.status({ refresh: true })).toMatchObject({ signedIn: true, source: 'pat', identity: { teams: ['acme/new'] } });
    expect(s.github.probe).toHaveBeenCalledTimes(2);
    expect(s.vault.store.has('identity:github|TOKEN')).toBe(false);
    expect((await s.svc.status()).identity?.teams).toEqual(['acme/new']);
    expect(s.github.probe).toHaveBeenCalledTimes(2);
  });

  it('refresh of a revoked PAT signs out with the rejection notice and clears nothing', async () => {
    const s = patSetup();
    await s.svc.status();
    s.setProbe(UNAUTHORIZED());
    expect(await s.svc.status({ refresh: true })).toMatchObject({ signedIn: false, notice: REJECTED });
    expect(s.vault.api.deleteAllForWorkspace).not.toHaveBeenCalled();
    expect(await s.svc.bearerToken()).toBeNull();
  });

  it('refresh of a PAT failing transiently keeps the cached PAT profile', async () => {
    const s = patSetup();
    await s.svc.status();
    s.setProbe(new IdentityError('network', 'offline'));
    const st = await s.svc.status({ refresh: true });
    expect(st).toMatchObject({ signedIn: true, source: 'pat' });
    expect(st.notice).toContain("Couldn't refresh your GitHub account (offline)");
  });

  it('a PAT verification queued behind a device sign-out is not wiped by it', async () => {
    const s = patSetup({ pat: null, polls: [DONE], probe: PROBE });
    await signIn(s);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const del = s.vault.api.deleteAllForWorkspace.getMockImplementation()!;
    s.vault.api.deleteAllForWorkspace.mockImplementationOnce(async (scope: string) => {
      await gate;
      await del(scope);
    });
    const out = s.svc.signOut();
    await vi.waitFor(() => expect(s.vault.api.deleteAllForWorkspace).toHaveBeenCalled());
    s.setProbe(PAT_PROBE);
    s.setPat(PAT);
    const st = s.svc.status();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.github.probe).toHaveBeenCalledTimes(1);
    release();
    await out;
    expect(await st).toMatchObject({ signedIn: true, source: 'pat' });
    expect(s.vault.store.has('identity:github|TOKEN')).toBe(false);
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'pat' });
    expect(s.github.probe).toHaveBeenCalledTimes(2);
  });

  it('keeps the PAT verification in memory when the vault is unavailable', async () => {
    const s = patSetup({ vaultAvailable: false });
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'pat', persisted: false });
    await s.svc.status();
    expect(s.github.probe).toHaveBeenCalledTimes(1);
    expect(s.vault.api.setSecret).not.toHaveBeenCalled();
  });

  it('with no patToken dep the device sign-in reports source device', async () => {
    const s = setup({ polls: [DONE] });
    await signIn(s);
    expect(await s.svc.status()).toMatchObject({ signedIn: true, source: 'device' });
  });
});
