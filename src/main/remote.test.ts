import { afterEach, describe, expect, it, vi } from 'vitest';
import { person, TOKEN } from '../host/testFakes.js';
import { startTestHost, TEST_WORKSPACE_ID as ID } from '../host/testHost.js';
import { createRemoteBackend, MANAGED_MSG, TIER_REFRESH_MS } from './remote.js';
import { RemoteClient } from './remoteClient.js';
import type { RemoteBookmark, WorkspaceSpec } from './workspaces.js';

const realWhoami = RemoteClient.prototype.whoami;
const OTHER_ID = '01JC0000000000000000000009';
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
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
  const backend = createRemoteBackend({
    token: async () => TOKEN,
    listManifests: async () => manifests,
    writeManifest: async (s) => void (manifests = manifests.map((m) => (m.id === s.id ? s : m))),
    deleteState: async (id) => void deleted.push(id),
    now: () => t
  });
  vi.spyOn(RemoteClient.prototype, 'whoami').mockImplementation(function (this: RemoteClient) {
    whoamiCalls++;
    return realWhoami.call(this);
  });
  return {
    ...h,
    backend,
    manifests: () => manifests,
    setManifests: (m: WorkspaceSpec[]) => void (manifests = m),
    deleted,
    advance: (ms: number) => void (t += ms),
    whoamiCalls: () => whoamiCalls
  };
}

describe('remote backend', () => {
  it('lists every bookmark as running or unreachable and persists the reported tier', async () => {
    const r = await rig('read');
    const rows = await r.backend.listLiveWorkspaces();
    expect(rows.map((w) => [w.id, w.state, w.containerId])).toEqual([[ID, 'running', ID], ['gone', 'unreachable', 'gone']]);
    expect(rows[0].remote).toMatchObject({ tier: 'read', login: 'alice' });
    expect(r.manifests()[0].remote).toMatchObject({ tier: 'read', login: 'alice', url: r.url });
  });

  it('a standby host is shown unreachable', async () => {
    const r = await rig('read');
    r.setLease('standby');
    expect((await r.backend.listLiveWorkspaces())[0].state).toBe('unreachable');
  });

  it('a host now serving a different workspace id is unreachable for this bookmark, and nothing is written', async () => {
    const r = await rig('session');
    const wrong = { id: OTHER_ID, name: 'x', kind: 'remote', remote: { url: r.url, tier: 'read', login: 'alice', checkedAt: 0 } } as WorkspaceSpec;
    r.setManifests([wrong]);
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

  it('re-asks /whoami at most once a minute while listing', async () => {
    const r = await rig('read');
    await r.backend.listLiveWorkspaces();
    await r.backend.listLiveWorkspaces();
    expect(r.whoamiCalls()).toBe(1);
    r.advance(TIER_REFRESH_MS);
    await r.backend.listLiveWorkspaces();
    expect(r.whoamiCalls()).toBe(2);
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
