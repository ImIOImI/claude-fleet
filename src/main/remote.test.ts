import { afterEach, describe, expect, it, vi } from 'vitest';
import { person, TOKEN } from '../host/testFakes.js';
import { startTestHost, TEST_WORKSPACE_ID as ID } from '../host/testHost.js';
import { CHECKING_STATUS, createRemoteBackend, HEALTH_POLL_MS, MANAGED_MSG, TIER_REFRESH_MS, type RemoteBackend } from './remote.js';
import { RemoteClient, RemoteError } from './remoteClient.js';
import type { RemoteBookmark, WorkspaceSpec } from './workspaces.js';

const realWhoami = RemoteClient.prototype.whoami;
const OTHER_ID = '01JC0000000000000000000009';
let close: (() => Promise<void>) | null = null;
let live: RemoteBackend | null = null;
afterEach(async () => {
  live?.stop();
  live = null;
  vi.restoreAllMocks();
  await close?.();
  close = null;
});

async function rig(tier: 'read' | 'session', o: { cached?: RemoteBookmark['tier']; extra?: WorkspaceSpec[] } = {}) {
  const h = await startTestHost({ tokens: { [TOKEN]: person('alice', 1) }, grants: [{ login: 'alice', tier }] });
  close = h.close;
  let manifests: WorkspaceSpec[] = [
    { id: ID, name: 'review-bot', kind: 'remote', remote: { url: h.url, tier: o.cached ?? null, login: null, checkedAt: 0 } } as WorkspaceSpec,
    { id: 'gone', name: 'gone', kind: 'remote', remote: { url: 'http://127.0.0.1:1', tier: 'read', login: 'alice', checkedAt: 0 } } as WorkspaceSpec,
    ...(o.extra ?? [])
  ];
  const deleted: string[] = [];
  let t = 1_000_000;
  let whoamiCalls = 0;
  let login: string | null = 'alice';
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const backend = createRemoteBackend({
    schedule: (fn, ms) => {
      const e = { fn, ms, cancelled: false };
      timers.push(e);
      return () => void (e.cancelled = true);
    },
    token: async () => TOKEN,
    login: async () => login,
    listManifests: async () => manifests,
    writeManifest: async (s) => void (manifests = manifests.map((m) => (m.id === s.id ? s : m))),
    deleteState: async (id) => void deleted.push(id),
    now: () => t
  });
  vi.spyOn(RemoteClient.prototype, 'whoami').mockImplementation(function (this: RemoteClient) {
    whoamiCalls++;
    return realWhoami.call(this);
  });
  live = backend;
  return {
    timers,
    ...h,
    backend,
    manifests: () => manifests,
    setManifests: (m: WorkspaceSpec[]) => void (manifests = m),
    deleted,
    advance: (ms: number) => void (t += ms),
    setLogin: (l: string | null) => void (login = l),
    whoamiCalls: () => whoamiCalls
  };
}

describe('remote backend', () => {
  it('lists every bookmark as running or unreachable and persists the reported tier', async () => {
    const r = await rig('read');
    await r.backend.refresh();
    const rows = await r.backend.listLiveWorkspaces();
    expect(rows.map((w) => [w.id, w.state, w.containerId, w.status])).toEqual([[ID, 'running', ID, undefined], ['gone', 'unreachable', 'gone', undefined]]);
    expect(rows[0].remote).toMatchObject({ tier: 'read', login: 'alice' });
    expect(r.manifests()[0].remote).toMatchObject({ tier: 'read', login: 'alice', url: r.url });
  });

  it('a standby host is shown unreachable', async () => {
    const r = await rig('read');
    r.setLease('standby');
    await r.backend.refresh();
    expect((await r.backend.listLiveWorkspaces())[0].state).toBe('unreachable');
  });

  it('a host now serving a different workspace id is unreachable for this bookmark, and nothing is written', async () => {
    const r = await rig('session');
    const wrong = { id: OTHER_ID, name: 'x', kind: 'remote', remote: { url: r.url, tier: 'read', login: 'alice', checkedAt: 0 } } as WorkspaceSpec;
    r.setManifests([wrong]);
    await r.backend.refresh();
    expect((await r.backend.listLiveWorkspaces())[0].state).toBe('unreachable');
    expect(r.manifests()[0].remote?.tier).toBe('read');
    await expect(r.backend.attachPty(OTHER_ID, 'tab1', 80, 24)).rejects.toThrow(/different workspace/);
    expect(r.broker.created).toEqual([]);
  });

  it('a refresh against a stale URL never writes onto a bookmark that moved', async () => {
    const r = await rig('session');
    const stale = r.manifests()[0];
    const moved = { ...stale, remote: { url: 'https://elsewhere', tier: 'read' as const, login: 'alice', checkedAt: 0 } };
    r.setManifests([moved]);
    await r.backend.refreshTier(stale);
    expect(r.manifests()[0].remote).toEqual(moved.remote);
  });

  it('re-asks /whoami at most once a minute across probes', async () => {
    const r = await rig('read');
    await r.backend.refresh();
    await r.backend.refresh();
    expect(r.whoamiCalls()).toBe(1);
    r.advance(TIER_REFRESH_MS);
    await r.backend.refresh();
    expect(r.whoamiCalls()).toBe(2);
  });

  it('a sign-in change re-asks /whoami inside the minute', async () => {
    const r = await rig('read');
    await r.backend.refresh(ID);
    r.setLogin(null);
    await r.backend.refresh(ID);
    expect(r.whoamiCalls()).toBe(2);
    r.setLogin('alice');
    await r.backend.refresh(ID);
    expect(r.whoamiCalls()).toBe(3);
    await r.backend.refresh(ID);
    expect(r.whoamiCalls()).toBe(3);
  });

  it.each([
    [60_000, 60_000],
    [1_000, HEALTH_POLL_MS]
  ])('the health poll waits max(HEALTH_POLL_MS, Retry-After %i)', async (retryAfterMs, wait) => {
    const r = await rig('read');
    vi.spyOn(RemoteClient.prototype, 'healthz').mockRejectedValue(new RemoteError('unreachable', 'busy', 429, retryAfterMs));
    await r.backend.refresh(ID);
    expect(r.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toContain(wait);
    expect(r.timers.filter((t) => !t.cancelled).every((t) => t.ms >= HEALTH_POLL_MS)).toBe(true);
  });

  it('a throttled /whoami also stretches the health poll', async () => {
    const r = await rig('read');
    vi.spyOn(RemoteClient.prototype, 'whoami').mockRejectedValue(new RemoteError('unreachable', 'busy', 429, 90_000));
    await r.backend.refresh(ID);
    expect((await r.backend.listLiveWorkspaces())[0].state).toBe('running');
    expect(r.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toContain(90_000);
  });

  it('listing never waits on the network: a hanging /healthz still lists at once, as checking', async () => {
    const r = await rig('read');
    let healthz = 0;
    vi.spyOn(RemoteClient.prototype, 'healthz').mockImplementation(() => (healthz++, new Promise(() => undefined)));
    const rows = await Promise.race([
      r.backend.listLiveWorkspaces(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('listLiveWorkspaces waited on the network')), 200))
    ]);
    expect(rows.map((w) => [w.state, w.status])).toEqual([['unreachable', CHECKING_STATUS], ['unreachable', CHECKING_STATUS]]);
    await r.backend.listLiveWorkspaces();
    expect(healthz).toBe(2);
  });

  it('keeps the last-known state between probes and re-probes every HEALTH_POLL_MS', async () => {
    const r = await rig('read');
    await r.backend.refresh();
    r.setLease('standby');
    expect((await r.backend.listLiveWorkspaces())[0].state).toBe('running');
    const next = r.timers.filter((t) => !t.cancelled);
    expect(next.map((t) => t.ms)).toEqual([HEALTH_POLL_MS, HEALTH_POLL_MS]);
    for (const t of next) t.fn();
    await r.backend.refresh(ID);
    expect((await r.backend.listLiveWorkspaces())[0].state).toBe('unreachable');
  });

  it('stop cancels every probe and starts no new ones', async () => {
    const r = await rig('read');
    await r.backend.refresh();
    let healthz = 0;
    vi.spyOn(RemoteClient.prototype, 'healthz').mockImplementation(async () => (healthz++, { status: 'ok', lease: 'holder' }));
    r.backend.stop();
    expect(r.timers.every((t) => t.cancelled)).toBe(true);
    await r.backend.listLiveWorkspaces();
    await r.backend.refresh();
    expect(healthz).toBe(0);
  });

  it('a probe that lands after its bookmark was forgotten records nothing and schedules nothing', async () => {
    const r = await rig('read');
    const pending: Array<() => void> = [];
    vi.spyOn(RemoteClient.prototype, 'healthz').mockImplementation(
      () => new Promise((res) => pending.push(() => res({ status: 'ok', lease: 'standby' })))
    );
    await r.backend.listLiveWorkspaces();
    await r.backend.removeWorkspace(ID);
    pending.forEach((f) => f());
    await new Promise((res) => setTimeout(res, 20));
    expect(r.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it('forget stops that bookmark\'s probe', async () => {
    const r = await rig('read');
    await r.backend.refresh();
    const before = r.timers.length;
    await r.backend.removeWorkspace(ID);
    expect(r.timers.slice(0, before).filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it('attach starts a missing session only for the session tier', async () => {
    const reader = await rig('read');
    await expect(reader.backend.attachPty(ID, 'tab1', 80, 24)).rejects.toThrow(/cannot start one/);
    await reader.close();
    const owner = await rig('session');
    const h = await owner.backend.attachPty(ID, 'tab1', 80, 24);
    expect(owner.broker.created.map((c) => c.id)).toEqual(['tab1']);
    h.detach();
  });

  it('a stale cached session tier grants nothing: attach asks the host first', async () => {
    const r = await rig('read', { cached: 'session' });
    await expect(r.backend.attachPty(ID, 'tab1', 80, 24)).rejects.toThrow(/cannot start one/);
    expect(r.broker.created).toEqual([]);
    expect(r.manifests()[0].remote?.tier).toBe('read');
  });

  it('lifecycle calls throw "managed by its deployment"; forget deletes local state only', async () => {
    const r = await rig('read');
    await expect(r.backend.startWorkspace(ID)).rejects.toThrow(MANAGED_MSG);
    await expect(r.backend.stopWorkspace(ID)).rejects.toThrow(MANAGED_MSG);
    await expect(r.backend.pauseWorkspace(ID)).rejects.toThrow(MANAGED_MSG);
    await expect(r.backend.ensureImage(() => undefined)).rejects.toThrow(MANAGED_MSG);
    await expect(r.backend.createWorkspace({} as never)).rejects.toThrow(MANAGED_MSG);
    await r.backend.removeWorkspace(ID);
    expect(r.deleted).toEqual([ID]);
  });

  it('forget refuses anything that is not a remote bookmark', async () => {
    const local = { id: '01JC0000000000000000000005', name: 'mine', kind: 'local' } as WorkspaceSpec;
    const r = await rig('read', { extra: [local] });
    await expect(r.backend.removeWorkspace(local.id)).rejects.toThrow(/no remote workspace/);
    await expect(r.backend.removeWorkspace('../../x')).rejects.toThrow(/no remote workspace/);
    expect(r.deleted).toEqual([]);
  });

  it('attach refuses a non-remote id without contacting any host', async () => {
    const local = { id: '01JC0000000000000000000005', name: 'mine', kind: 'local' } as WorkspaceSpec;
    const r = await rig('session', { extra: [local] });
    await expect(r.backend.attachPty(local.id, 'tab1', 80, 24)).rejects.toThrow(/no remote workspace/);
    expect(r.whoamiCalls()).toBe(0);
  });
});
