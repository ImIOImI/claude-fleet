// Unit tests for AuthMode 'endpoint' + manifest endpointId round-trip (#250).
// electron is mocked so app.getPath('userData') resolves to a per-test temp dir;
// the rest is plain fs against workspace.json.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

const ID = '01ENDPOINTTEST0000000000WS';

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-wsendpoint-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

it('round-trips authMode endpoint + endpointId through the manifest (no oauth coercion)', async () => {
  // Build a minimal spec with authMode='endpoint' and an endpointId.
  // Cast as unknown to bypass the type-level restriction (the type
  // will expand in the implementing step; the test is written first).
  const spec = {
    id: ID,
    name: 'ep-test',
    labels: [],
    workspaceRoot: tmpdir(),
    workspaceSubdir: '',
    kind: 'container',
    authMode: 'endpoint',
    endpointId: 'ep-uuid-1',
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on', cleanup: 'delete' },
    createdAt: 1,
    lastUsedAt: 1
  } as unknown as Parameters<typeof writeWorkspaceManifest>[0];

  await writeWorkspaceManifest(spec);
  const back = await readWorkspaceManifest(ID);
  expect(back?.authMode).toBe('endpoint'); // NOT 'oauth'
  expect(back?.endpointId).toBe('ep-uuid-1');
});

it('still coerces garbage authMode to oauth', async () => {
  // Write a manifest with an unknown authMode directly (bypassing the type-safe
  // writer) and verify that readWorkspaceManifest sanitises it to 'oauth'.
  const dir = join(userDataDir, 'state', ID);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'workspace.json'),
    JSON.stringify({
      id: ID,
      name: 'garbage-auth',
      workspaceRoot: '/tmp/x',
      authMode: 'bogus',
      workspaceSubdir: '',
      labels: [],
      env: { plain: {}, secretKeys: [] },
      mirror: FACTORY_MIRROR,
      createdAt: 1,
      lastUsedAt: 1
    }),
    'utf8'
  );
  const back = await readWorkspaceManifest(ID);
  expect(back?.authMode).toBe('oauth');
});
