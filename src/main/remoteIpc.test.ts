import { describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../preload/identityTypes.js';
import type { RemoteBackend } from './remote.js';
import { RemoteError, type WhoAmI } from './remoteClient.js';
import { APPROVAL_MS, assertNotRemoteSpec, DIALOG_GAP_MS, confirmText, REMOTE_CHANNELS, registerRemoteIpc, type RemoteConfirm, type RemoteIpcDeps } from './remoteIpc.js';
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

interface HarnessOpts {
  manifests?: WorkspaceSpec[];
  sso?: AccountStatus['sso'];
  rpc?: (...a: unknown[]) => Promise<unknown>;
  confirm?: (r: RemoteConfirm) => Promise<boolean>;
  healthz?: () => Promise<unknown>;
}

function harness(whoami: () => Promise<WhoAmI>, opts: HarnessOpts = {}) {
  let t = 5;
  const store = new Map((opts.manifests ?? []).map((m) => [m.id, m]));
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const urls: string[] = [];
  const whoamiSpy = vi.fn(whoami);
  const client = {
    whoami: whoamiSpy,
    healthz: opts.healthz ?? (async () => ({ status: 'ok', lease: 'holder' })),
    rpc: opts.rpc ?? (async () => []),
    redact: async (t: string) => t.split(TOKEN).join('[redacted]')
  };
  const deps: RemoteIpcDeps = {
    backend: { clientFor: (u: string) => (urls.push(u), client) } as unknown as RemoteBackend,
    accountStatus: async () => ({ sso: opts.sso ?? null }) as AccountStatus,
    readManifest: async (id) => store.get(id) ?? null,
    listManifests: async () => [...store.values()],
    writeManifest: vi.fn(async (s: WorkspaceSpec) => void store.set(s.id, s)),
    findByName: async (n) => [...store.values()].find((m) => m.name === n) ?? null,
    invalidate: vi.fn(),
    confirm: vi.fn(opts.confirm ?? (async () => true)),
    now: () => t
  };
  registerRemoteIpc({ handle: (ch, fn) => void handlers.set(ch, fn as (...a: unknown[]) => unknown) }, deps);
  const call = (ch: string, ...a: unknown[]) => Promise.resolve(handlers.get(ch)!({}, ...a));
  return { call, store, handlers, deps, urls, whoami: whoamiSpy, advance: (ms: number) => void (t += ms) };
}

describe('remote:* IPC', () => {
  it('registers exactly the remote channels', () => {
    expect([...harness(async () => WHO).handlers.keys()].sort()).toEqual([...REMOTE_CHANNELS].sort());
  });

  it('probe normalizes the URL, reports tier and the plain-http warning, and returns only the probe fields', async () => {
    const h = harness(async () => ({ ...WHO, user: { ...WHO.user, token: TOKEN } as never, extra: TOKEN }) as WhoAmI);
    const r = await h.call('remote:probe', ' http://fleet-agent-svc:8080/ ');
    expect([...new Set(h.urls)]).toEqual(['http://fleet-agent-svc:8080']);
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

  it("liveSessions asks the bookmark's host over sessions:live and returns only id/alive/mine", async () => {
    const rpc = vi.fn(async () => [{ id: 's1', alive: true, owner: TOKEN }, { id: 5 }, 'junk', { id: 's2', alive: 'yes' }]);
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://h')], rpc });
    expect(await h.call('remote:liveSessions', ID)).toEqual([{ id: 's1', alive: true, mine: false }]);
    expect(rpc).toHaveBeenCalledWith('sessions:live', []);
    expect([...new Set(h.urls)]).toEqual(['https://h']);
    await expect(h.call('remote:liveSessions', 'nope')).rejects.toThrow(/Not a remote/);
    await expect(h.call('remote:liveSessions', ['x'])).rejects.toThrow();
  });

  it('liveSessions passes mine through only as a boolean', async () => {
    const rpc = vi.fn(async () => [
      { id: 'a', alive: true, mine: true },
      { id: 'b', alive: true, mine: false },
      { id: 'c', alive: true },
      { id: 'd', alive: true, mine: 'yes' },
      { id: 'e', alive: true, mine: 1 }
    ]);
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://h')], rpc });
    expect(await h.call('remote:liveSessions', ID)).toEqual([
      { id: 'a', alive: true, mine: true },
      { id: 'b', alive: true, mine: false },
      { id: 'c', alive: true, mine: false }
    ]);
  });

  it("liveSessions drops ids the host's validSessionId would refuse", async () => {
    const rpc = vi.fn(async () => [
      { id: 'ok_1-A', alive: true },
      { id: '', alive: true },
      { id: 'x'.repeat(129), alive: true },
      { id: 'x'.repeat(128), alive: true },
      { id: '../etc', alive: true },
      { id: 'a b', alive: true },
      { id: 'a\nb', alive: true }
    ]);
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://h')], rpc });
    expect(((await h.call('remote:liveSessions', ID)) as Array<{ id: string }>).map((r) => r.id)).toEqual(['ok_1-A', 'x'.repeat(128)]);
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

describe('remote:* token consent (main-process confirm)', () => {
  it('a probe to an unbookmarked origin asks main first; declining sends no token-bearing request', async () => {
    const h = harness(async () => WHO, { confirm: async () => false });
    expect(await h.call('remote:probe', 'https://h/x/')).toEqual({ ok: false, kind: 'declined', message: expect.any(String) });
    expect(h.deps.confirm).toHaveBeenCalledWith({ kind: 'send-token', origin: 'https://h' });
    expect(h.whoami).not.toHaveBeenCalled();
    expect(await h.call('remote:add', 'https://h')).toMatchObject({ ok: false, kind: 'declined' });
    expect(h.whoami).not.toHaveBeenCalled();
    expect(h.deps.writeManifest).not.toHaveBeenCalled();
  });

  it('a host that is not a fleet-host by /healthz never gets the token or a dialog', async () => {
    const h = harness(async () => WHO, { healthz: async () => { throw new RemoteError('protocol', 'not a fleet-host'); } });
    expect(await h.call('remote:probe', 'https://h')).toMatchObject({ ok: false, kind: 'protocol' });
    expect(h.deps.confirm).not.toHaveBeenCalled();
    expect(h.whoami).not.toHaveBeenCalled();
  });

  it('approval is per origin and expires', async () => {
    const h = harness(async () => WHO);
    await h.call('remote:probe', 'https://h');
    await h.call('remote:add', 'https://h/sub');
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);
    h.advance(DIALOG_GAP_MS);
    await h.call('remote:probe', 'https://h:8443');
    expect(h.deps.confirm).toHaveBeenLastCalledWith({ kind: 'send-token', origin: 'https://h:8443' });
    expect(h.deps.confirm).toHaveBeenCalledTimes(2);
    h.advance(APPROVAL_MS);
    await h.call('remote:probe', 'https://h:8443');
    expect(h.deps.confirm).toHaveBeenCalledTimes(3);
  });

  it('a bookmarked origin needs no dialog', async () => {
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://h')] });
    expect(await h.call('remote:probe', 'https://h')).toMatchObject({ ok: true });
    expect(h.deps.confirm).not.toHaveBeenCalled();
  });

  it('a bookmark on a local or container spec grants no trust', async () => {
    const h = harness(async () => WHO, { manifests: [{ id: 'L', name: 'l', kind: 'local', remote: { url: 'https://h' } } as unknown as WorkspaceSpec] });
    await h.call('remote:probe', 'https://h');
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);
  });

  it('concurrent probes to one origin share one dialog', async () => {
    let answer!: (v: boolean) => void;
    const h = harness(async () => WHO, { confirm: () => new Promise((r) => (answer = r)) });
    const a = h.call('remote:probe', 'https://h');
    const b = h.call('remote:probe', 'https://h');
    await new Promise((r) => setTimeout(r, 10));
    answer(true);
    expect(await a).toMatchObject({ ok: true });
    expect(await b).toMatchObject({ ok: true });
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);
  });

  it('the renderer flag alone cannot re-point a bookmark: main confirms with both URLs', async () => {
    const prior = bookmarkAt('https://old');
    const answers: Record<string, boolean> = { 'send-token': true, 're-point': false };
    const h = harness(async () => WHO, { manifests: [prior], confirm: async (r) => answers[r.kind] });
    expect(await h.call('remote:add', 'https://new', { sameHostNewAddress: true })).toMatchObject({ ok: false, kind: 'declined' });
    expect(h.deps.confirm).toHaveBeenCalledWith({ kind: 're-point', from: 'https://old', to: 'https://new' });
    expect(h.store.get(ID)).toBe(prior);
    expect(h.deps.writeManifest).not.toHaveBeenCalled();
  });

  it('a declined origin is remembered: no second dialog, still declined', async () => {
    const h = harness(async () => WHO, { confirm: async () => false });
    await h.call('remote:probe', 'https://h');
    h.advance(APPROVAL_MS * 10);
    expect(await h.call('remote:probe', 'https://h/other')).toMatchObject({ ok: false, kind: 'declined', message: expect.stringMatching(/earlier/) });
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);
    expect(h.whoami).not.toHaveBeenCalled();
  });

  it('a failed dialog is not remembered as a decline', async () => {
    let fail = true;
    const h = harness(async () => WHO, { confirm: async () => { if (fail) throw new Error('no window'); return true; } });
    expect(await h.call('remote:probe', 'https://h')).toMatchObject({ ok: false, kind: 'declined' });
    fail = false;
    h.advance(DIALOG_GAP_MS);
    expect(await h.call('remote:probe', 'https://h')).toMatchObject({ ok: true });
  });

  it('at most one send-token dialog per gap across origins; a rate-limited ask is not remembered', async () => {
    const h = harness(async () => WHO);
    await h.call('remote:probe', 'https://a');
    h.advance(DIALOG_GAP_MS - 1);
    expect(await h.call('remote:probe', 'https://b')).toMatchObject({ ok: false, kind: 'declined', message: expect.stringMatching(/few seconds/) });
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);
    expect(h.whoami).toHaveBeenCalledTimes(1);
    h.advance(1);
    expect(await h.call('remote:probe', 'https://b')).toMatchObject({ ok: true });
    expect(h.deps.confirm).toHaveBeenCalledTimes(2);
  });

  it('the gap counts from when the last dialog closed', async () => {
    let answer!: (v: boolean) => void;
    const h = harness(async () => WHO, { confirm: () => new Promise((r) => (answer = r)) });
    const a = h.call('remote:probe', 'https://a');
    await new Promise((r) => setTimeout(r, 10));
    h.advance(DIALOG_GAP_MS * 3);
    expect(await h.call('remote:probe', 'https://b')).toMatchObject({ ok: false, kind: 'declined' });
    answer(true);
    await a;
    h.advance(DIALOG_GAP_MS - 1);
    expect(await h.call('remote:probe', 'https://b')).toMatchObject({ ok: false, kind: 'declined' });
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);
  });

  it('the send-token dialog carries the plain-http warning for a non-loopback http origin', async () => {
    const h = harness(async () => WHO);
    await h.call('remote:probe', 'http://fleet-agent-svc:8080');
    expect(h.deps.confirm).toHaveBeenLastCalledWith({ kind: 'send-token', origin: 'http://fleet-agent-svc:8080', warning: expect.stringMatching(/unencrypted/) });
    h.advance(DIALOG_GAP_MS);
    await h.call('remote:probe', 'http://localhost:8080');
    expect(h.deps.confirm).toHaveBeenLastCalledWith({ kind: 'send-token', origin: 'http://localhost:8080' });
    expect(confirmText({ kind: 'send-token', origin: 'http://x', warning: 'Plain http: W' }).detail).toMatch(/Plain http: W$/);
    expect(confirmText({ kind: 'send-token', origin: 'https://x' }).detail).not.toMatch(/Plain http/);
  });

  it('a declined re-point is remembered per (from, to)', async () => {
    const answers: Record<string, boolean> = { 'send-token': true, 're-point': false };
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://old')], confirm: async (r) => answers[r.kind] });
    await h.call('remote:add', 'https://new', { sameHostNewAddress: true });
    h.advance(DIALOG_GAP_MS);
    expect(await h.call('remote:add', 'https://new', { sameHostNewAddress: true })).toMatchObject({ ok: false, kind: 'declined', message: expect.stringMatching(/earlier/) });
    expect(h.deps.confirm).toHaveBeenCalledTimes(2);
    h.advance(DIALOG_GAP_MS);
    answers['re-point'] = true;
    expect(await h.call('remote:add', 'https://other', { sameHostNewAddress: true })).toMatchObject({ ok: true });
    expect(h.deps.confirm).toHaveBeenLastCalledWith({ kind: 're-point', from: 'https://old', to: 'https://other' });
  });

  it('the re-point dialog shares the dialog gap, except right after approving its own destination', async () => {
    const other = { ...bookmarkAt('https://new'), id: '01JC0000000000000000000001', name: 'other' } as WorkspaceSpec;
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://old'), other] });
    await h.call('remote:probe', 'https://a');
    expect(await h.call('remote:add', 'https://new', { sameHostNewAddress: true })).toMatchObject({ ok: false, kind: 'declined', message: expect.stringMatching(/few seconds/) });
    expect(h.deps.confirm).toHaveBeenCalledTimes(1);
    expect(h.deps.writeManifest).not.toHaveBeenCalled();
    h.advance(DIALOG_GAP_MS);
    expect(await h.call('remote:add', 'https://new', { sameHostNewAddress: true })).toMatchObject({ ok: true });
    expect(h.deps.confirm).toHaveBeenCalledTimes(2);
  });

  it('a send-token dialog right after a re-point dialog waits the gap', async () => {
    const h = harness(async () => WHO, { manifests: [bookmarkAt('https://old')] });
    await h.call('remote:probe', 'https://new');
    h.advance(DIALOG_GAP_MS);
    await h.call('remote:add', 'https://new', { sameHostNewAddress: true });
    h.advance(DIALOG_GAP_MS - 1);
    expect(await h.call('remote:probe', 'https://third')).toMatchObject({ ok: false, kind: 'declined', message: expect.stringMatching(/few seconds/) });
  });

  it('confirmText names the origin, or both URLs', () => {
    expect(confirmText({ kind: 'send-token', origin: 'https://xn--e1afmkfd.example' }).message).toBe('Send your GitHub sign-in to https://xn--e1afmkfd.example?');
    const t = confirmText({ kind: 're-point', from: 'https://old', to: 'https://new' });
    expect(`${t.message} ${t.detail}`).toMatch(/https:\/\/old[\s\S]*https:\/\/new/);
  });

  it('caps and strips host display text in the probe reply', async () => {
    const h = harness(async () => ({ ...WHO, workspace: { ...WHO.workspace, name: 'a\u001b[31m' + 'n'.repeat(100), description: 'd\r\n' + 'x'.repeat(600) } }));
    const r = (await h.call('remote:probe', 'https://h')) as { workspace: { name: string; description: string } };
    expect(r.workspace.name).toHaveLength(64);
    expect(r.workspace.name).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(r.workspace.description.length).toBeLessThanOrEqual(500);
    expect(r.workspace.description).not.toMatch(/[\x00-\x1f\x7f]/);
  });
});
