// Mirror-defaulting for the workspace manifest (#10). electron is mocked so
// app.getPath('userData') resolves to a per-test temp dir; the rest is plain
// fs against workspace.json.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir;
      if (which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));

const { readWorkspaceManifest, writeWorkspaceManifest, FACTORY_MIRROR } = await import(
  './workspaces.js'
);

const ID = '01WSMIRRORAAAAAAAAAAAAAAAAA';

async function writeRawManifest(body: object): Promise<void> {
  const dir = join(userDataDir, 'state', ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'workspace.json'), JSON.stringify(body), 'utf8');
}

const baseManifest = {
  id: ID,
  name: 'mirror-test',
  workspaceRoot: '/tmp/x',
  authMode: 'oauth' as const
};

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-wsmirror-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('readWorkspaceManifest mirror defaulting', () => {
  it('applies factory mirror to a legacy manifest with no mirror block', async () => {
    await writeRawManifest(baseManifest);
    const spec = await readWorkspaceManifest(ID);
    expect(spec?.mirror).toEqual(FACTORY_MIRROR);
    expect(FACTORY_MIRROR).toEqual({ default: 'on', cleanup: 'delete' });
  });

  it('reads explicit mirror settings', async () => {
    await writeRawManifest({ ...baseManifest, mirror: { default: 'off', cleanup: 'preserve' } });
    const spec = await readWorkspaceManifest(ID);
    expect(spec?.mirror).toEqual({ default: 'off', cleanup: 'preserve' });
  });

  it('falls back per-field on a partial/garbage mirror block', async () => {
    await writeRawManifest({ ...baseManifest, mirror: { default: 'nonsense' } });
    const spec = await readWorkspaceManifest(ID);
    expect(spec?.mirror).toEqual({ default: 'on', cleanup: 'delete' });
  });

  it('round-trips through writeWorkspaceManifest', async () => {
    await mkdir(join(userDataDir, 'state', ID), { recursive: true });
    await writeWorkspaceManifest({
      id: ID,
      name: 'mirror-test',
      labels: [],
      workspaceRoot: '/tmp/x',
      workspaceSubdir: '',
      kind: 'container',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      mirror: { default: 'off', cleanup: 'preserve' },
      createdAt: 1,
      lastUsedAt: 1
    });
    const reread = await readWorkspaceManifest(ID);
    expect(reread?.mirror).toEqual({ default: 'off', cleanup: 'preserve' });
  });
});
