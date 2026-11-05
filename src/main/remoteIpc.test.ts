import { describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../preload/identityTypes.js';
import type { RemoteBackend } from './remote.js';
import { RemoteError, type WhoAmI } from './remoteClient.js';
import { assertNotRemoteSpec, REMOTE_CHANNELS, registerRemoteIpc, type RemoteIpcDeps } from './remoteIpc.js';
import type { WorkspaceSpec } from './workspaces.js';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));

const ID = '01JC0000000000000000000000';
const TOKEN = 'gho_' + 'S'.repeat(36);
const WHO: WhoAmI = {
  workspace: { id: ID, name: 'review-bot', description: 'reviews', color: { hue: 210 } },
  user: { provider: 'github', kind: 'user', login: 'alice', id: 1, name: 'Alice', avatarUrl: null },
  tier: 'steer'
};
const bookmarkAt = (url: string, extra: Partial<WorkspaceSpec> = {}) =>
  ({ id: ID, name: 'my-name', kind: 'remote', remote: { url, tier: 'read', login: 'alice', checkedAt: 1 }, ...extra }) as WorkspaceSpec;

function harness(whoami: () => Promise<WhoAmI>, opts: { manifests?: WorkspaceSpec[]; sso?: AccountStatus['sso']; rpc?: (...a: unknown[]) => Promise<unknown> } = {}) {
  const store = new Map((opts.manifests ?? []).map((m) => [m.id, m]));
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const urls: string[] = [];
  const client = {
    whoami,
    rpc: opts.rpc ?? (async () => []),
    redact: async (t: string) => t.split(TOKEN).join('[redacted]')
  };
  const deps: RemoteIpcDeps = {
    backend: { clientFor: (u: string) => (urls.push(u), client) } as unknown as RemoteBackend,
    accountStatus: async () => ({ sso: opts.sso ?? null }) as AccountStatus,
    readManifest: async (id) => store.get(id) ?? null,
    writeManifest: vi.fn(async (s: WorkspaceSpec) => void store.set(s.id, s)),
    findByName: async (n) => [...store.values()].find((m) => m.name === n) ?? null,
    invalidate: vi.fn(),
    now: () => 5
  };
  registerRemoteIpc({ handle: (ch, fn) => void handlers.set(ch, fn as (...a: unknown[]) => unknown) }, deps);
  const call = (ch: string, ...a: unknown[]) => Promise.resolve(handlers.get(ch)!({}, ...a));
  return { call, store, handlers, deps, urls };
}

describe('remote:* IPC', () => {
  it('registers exactly the remote channels', () => {
    expect([...harness(async () => WHO).handlers.keys()].sort()).toEqual([...REMOTE_CHANNELS].sort());
  });

  it('probe normalizes the URL, reports tier and the plain-http warning, and returns only the probe fields', async () => {
    const h = harness(async () => ({ ...WHO, user: { ...WHO.user, token: TOKEN } as never, extra: TOKEN }) as WhoAmI);
    const r = await h.call('remote:probe', ' http://fleet-agent-svc:8080/ ');
    expect(h.urls).toEqual(['http://fleet-agent-svc:8080']);
    expect(r).toEqual({
      ok: true,
      url: 'http://fleet-agent-svc:8080',
      workspace: WHO.workspace,
      user: { login: 'alice', name: 'Alice', avatarUrl: null },
      tier: 'steer',
      warning: expect.stringMatching(/unencrypted/),
      existing: false,
      existingUrl: null
    });
  });

  it('probe reports the existing bookmark URL when it differs', async () => {
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://old')] });
    expect(await h.call('remote:probe', 'https://new')).toMatchObject({ ok: true, existing: true, existingUrl: 'https://old' });
    expect(await h.call('remote:probe', 'https://old/')).toMatchObject({ ok: true, existing: true, existingUrl: null });
  });

  it.each([
    [new RemoteError('unreachable', 'x is not reachable'), 'unreachable'],
    [new RemoteError('forbidden', 'no grant for @alice'), 'forbidden'],
    [new RemoteError('not-signed-in', 'sign in'), 'not-signed-in']
  ])('probe maps %s to %s', async (err, kind) => {
    expect(await harness(async () => { throw err; }).call('remote:probe', 'https://h')).toMatchObject({ ok: false, kind });
  });

  it('probe never echoes the token, from a host error or an unexpected one', async () => {
    const leak = await harness(async () => { throw new RemoteError('protocol', `bad ${TOKEN}`); }).call('remote:probe', 'https://h');
    expect(JSON.stringify(leak)).not.toContain(TOKEN);
    const odd = await harness(async () => { throw new Error(`boom ${TOKEN}`); }).call('remote:probe', 'https://h');
    expect(odd).toEqual({ ok: false, kind: 'protocol', message: 'Unexpected error talking to the host' });
  });

  it('probe refuses a non-string or oversized URL without contacting anything', async () => {
    const h = harness(async () => WHO);
    for (const bad of [undefined, 42, ['https://h'], { toString: () => 'https://h' }, 'https://h/' + 'a'.repeat(3000), 'ftp://h']) {
      expect(await h.call('remote:probe', bad)).toMatchObject({ ok: false, kind: 'invalid-url' });
    }
    expect(h.urls).toEqual([]);
  });

  it('a 403 with a pending SSO authorisation says so', async () => {
    const sso = { url: 'https://github.com/orgs/acme/sso?x', org: 'acme', orgCount: 1, appSettingsUrl: null };
    const r = await harness(async () => { throw new RemoteError('forbidden', 'no grant'); }, { sso }).call('remote:probe', 'https://h');
    expect(r).toMatchObject({ ok: false, kind: 'sso', ssoUrl: sso.url });
  });

  it('add writes a bookmark under the host-reported id, suffixing a clashing name', async () => {
    const taken = { id: 'other', name: 'review-bot', kind: 'container' } as WorkspaceSpec;
    const h = harness(async () => WHO, { manifests: [taken] });
    expect(await h.call('remote:add', 'https://h/')).toMatchObject({ ok: true, existing: false });
    expect(h.store.get(ID)).toEqual({
      id: ID,
      name: 'review-bot-2',
      description: 'reviews',
      labels: [],
      color: { hue: 210 },
      workspaceRoot: '',
      workspaceSubdir: '',
      kind: 'remote',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      mirror: { default: 'on', cleanup: 'delete' },
      remote: { url: 'https://h', tier: 'steer', login: 'alice', checkedAt: 5 },
      createdAt: 5,
      lastUsedAt: 5
    });
    expect(h.deps.invalidate).toHaveBeenCalled();
  });

  it('add drops a malformed host colour and falls back for an empty name', async () => {
    const h = harness(async () => ({ ...WHO, workspace: { ...WHO.workspace, name: '', color: { hue: Number.NaN } } }));
    await h.call('remote:add', 'https://h');
    expect(h.store.get(ID)).toMatchObject({ name: 'remote' });
    expect(h.store.get(ID)!.color).toBeUndefined();
  });

  it('add of a known id at the same URL refreshes the tier and keeps the local name', async () => {
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://h')] });
    expect(await h.call('remote:add', 'https://h')).toMatchObject({ ok: true, existing: true });
    expect(h.store.get(ID)).toMatchObject({ name: 'my-name', remote: { url: 'https://h', tier: 'steer' } });
  });

  it('add refuses to re-point a bookmark to a new URL unless sameHostNewAddress is set', async () => {
    const prior = bookmarkAt('https://old');
    const h = harness(async () => WHO, { manifests: [prior] });
    expect(await h.call('remote:add', 'https://new')).toEqual({
      ok: false,
      kind: 'moved',
      message: expect.stringContaining('https://old'),
      existingUrl: 'https://old'
    });
    expect(await h.call('remote:add', 'https://new', { sameHostNewAddress: false })).toMatchObject({ ok: false, kind: 'moved' });
    expect(h.store.get(ID)).toBe(prior);
    expect(h.deps.writeManifest).not.toHaveBeenCalled();
    expect(h.deps.invalidate).not.toHaveBeenCalled();

    expect(await h.call('remote:add', 'https://new', { sameHostNewAddress: true })).toMatchObject({ ok: true, existing: true });
    expect(h.store.get(ID)).toMatchObject({ name: 'my-name', remote: { url: 'https://new', tier: 'steer' } });
  });

  it('add refuses malformed options and passes no extra fields', async () => {
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://old')] });
    for (const bad of [{ sameHostNewAddress: 'yes' }, { sameHostNewAddress: true, url: 'https://x' }, [true], 'true', null]) {
      await expect(h.call('remote:add', 'https://new', bad)).rejects.toThrow(/options/);
    }
    expect(h.deps.writeManifest).not.toHaveBeenCalled();
  });

  it('add refuses an id that belongs to a workspace that is not a remote bookmark', async () => {
    for (const kind of ['local', 'container'] as const) {
      const mine = { id: ID, name: 'x', kind } as WorkspaceSpec;
      const h = harness(async () => WHO, { manifests: [mine] });
      expect(await h.call('remote:add', 'https://h', { sameHostNewAddress: true })).toMatchObject({ ok: false, kind: 'clash' });
      expect(h.store.get(ID)).toBe(mine);
      expect(h.deps.writeManifest).not.toHaveBeenCalled();
    }
  });

  it("liveSessions asks the bookmark's host over sessions:live and returns only id/alive", async () => {
    const rpc = vi.fn(async () => [{ id: 's1', alive: true, owner: TOKEN }, { id: 5 }, 'junk', { id: 's2', alive: 'yes' }]);
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://h')], rpc });
    expect(await h.call('remote:liveSessions', ID)).toEqual([{ id: 's1', alive: true }]);
    expect(rpc).toHaveBeenCalledWith('sessions:live', []);
    expect(h.urls).toEqual(['https://h']);
    await expect(h.call('remote:liveSessions', 'nope')).rejects.toThrow(/Not a remote/);
    await expect(h.call('remote:liveSessions', ['x'])).rejects.toThrow();
  });

  it('liveSessions refuses a workspace that is not a remote bookmark', async () => {
    const h = harness(async () => WHO, { manifests: [{ id: 'L', name: 'l', kind: 'local', remote: { url: 'https://evil' } } as unknown as WorkspaceSpec] });
    await expect(h.call('remote:liveSessions', 'L')).rejects.toThrow(/Not a remote/);
    expect(h.urls).toEqual([]);
  });

  it('rename changes only the local name and refuses a clash', async () => {
    const a = bookmarkAt('https://h', { id: 'A', name: 'a' });
    const b = { id: 'B', name: 'b', kind: 'container' } as WorkspaceSpec;
    const h = harness(async () => WHO, { manifests: [a, b] });
    await h.call('remote:rename', 'A', ' renamed ');
    expect(h.store.get('A')).toEqual({ ...a, name: 'renamed' });
    await expect(h.call('remote:rename', 'A', 'b')).rejects.toThrow(/already exists/);
    await expect(h.call('remote:rename', 'B', 'z')).rejects.toThrow(/Not a remote/);
    await expect(h.call('remote:rename', 'A', 'x\u0007y')).rejects.toThrow(/control/);
    await expect(h.call('remote:rename', 'A', 'x'.repeat(81))).rejects.toThrow(/too long/);
    await expect(h.call('remote:rename', 'A', { name: 'x' })).rejects.toThrow(/name is required/);
  });
});

describe('assertNotRemoteSpec', () => {
  it('refuses creating, converting or editing a bookmark through the generic workspace channels', () => {
    expect(() => assertNotRemoteSpec('remote', null)).toThrow(/Remote workspaces/);
    expect(() => assertNotRemoteSpec('container', bookmarkAt('https://h'))).toThrow(/Remote workspaces/);
    expect(() => assertNotRemoteSpec('local', null)).not.toThrow();
    expect(() => assertNotRemoteSpec(undefined, { id: ID, kind: 'container' } as WorkspaceSpec)).not.toThrow();
  });
});
