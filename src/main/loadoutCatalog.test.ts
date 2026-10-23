// Catalog I/O glue: versions from the local library and the workspace's
// installed records reach assembleCatalog, so Update ↑ can fire.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('./loadouts.js', () => ({
  listLoadouts: vi.fn(async () => [{ id: 'gh-triage', title: 'GitHub Notification Triage', description: 'd', tags: [], version: '1.0.0' }])
}));
vi.mock('./config.js', () => ({ getFavorites: vi.fn(async () => []) }));
vi.mock('./workspaces.js', () => ({
  readWorkspaceManifest: vi.fn(async () => ({ installedLoadouts: [{ id: 'gh-triage', title: 'T', version: '1.0.0', files: [], installedAt: 1 }] }))
}));
vi.mock('./loadoutSources.js', () => ({
  allRemote: vi.fn(async () => [{ source: 'ghcr.io/o/r', loadouts: [{ id: 'gh-triage', title: 'T', description: 'd', tags: [], version: '1.1.0' }] }])
}));

const { buildLoadoutCatalog } = await import('./loadoutCatalog.js');

describe('buildLoadoutCatalog', () => {
  it('flags an update when the source has a newer version than the installed one', async () => {
    const [e] = await buildLoadoutCatalog('ws1');
    expect(e).toMatchObject({ id: 'gh-triage', version: '1.0.0', installedVersion: '1.0.0', remoteVersion: '1.1.0', updateAvailable: true });
  });

  it('uses the local library version when no workspace is targeted', async () => {
    const [e] = await buildLoadoutCatalog();
    expect(e).toMatchObject({ installed: false, version: '1.0.0', updateAvailable: true });
  });
});
