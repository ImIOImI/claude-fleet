// Unit tests for resolveKind — the per-workspace backend routing decision (#16).
// Mocks `electron` so `app.getPath('userData')` resolves to a temp dir (same
// pattern as claudeJsonSeed.test.ts / migration.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));

const { resolveKind, resolveRemoveKind } = await import('./backendRouter.js');
const { workspaceManifestPath } = await import('./paths.js');

async function writeManifest(id: string, kind: 'container' | 'local'): Promise<void> {
  await mkdir(join(userDataDir, 'state', id), { recursive: true });
  await writeFile(
    workspaceManifestPath(id),
    JSON.stringify({
      id,
      name: id,
      workspaceRoot: '/tmp/' + id,
      workspaceSubdir: '',
      kind,
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      mirror: { default: 'on', cleanup: 'delete' },
      createdAt: 1,
      lastUsedAt: 1
    }),
    'utf8'
  );
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'claude-fleet-router-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('resolveKind', () => {
  it("returns 'local' for a workspace whose manifest is kind:'local'", async () => {
    await writeManifest('01LOCAL00000000000000000WS', 'local');
    expect(await resolveKind('01LOCAL00000000000000000WS')).toBe('local');
  });

  it("returns 'container' for a workspace whose manifest is kind:'container'", async () => {
    await writeManifest('01CONT000000000000000000WS', 'container');
    expect(await resolveKind('01CONT000000000000000000WS')).toBe('container');
  });

  it("defaults to 'container' for an unknown id (e.g. a real Docker container id)", async () => {
    // A 64-hex docker container id has no manifest at its path → must fall
    // through to the Docker backend, never the local one.
    const dockerId = 'a'.repeat(64);
    expect(await resolveKind(dockerId)).toBe('container');
  });
});

describe('resolveRemoveKind', () => {
  const REMOTE = '01REMQTE000000000000000000';
  async function writeRemote(id: string): Promise<void> {
    await mkdir(join(userDataDir, 'state', id), { recursive: true });
    await writeFile(
      workspaceManifestPath(id),
      JSON.stringify({
        id, name: id, workspaceRoot: '', workspaceSubdir: '', kind: 'remote', authMode: 'oauth',
        env: { plain: {}, secretKeys: [] }, remote: { url: 'https://h', tier: null, login: null, checkedAt: 0 }, createdAt: 1, lastUsedAt: 1
      }),
      'utf8'
    );
  }

  it('routes a live container, a saved workspace and a bookmark as before', async () => {
    await writeManifest('01CONT000000000000000000WS', 'container');
    await writeManifest('01LOCAL00000000000000000WS', 'local');
    await writeRemote(REMOTE);
    expect(await resolveRemoveKind('a'.repeat(64), '01CONT000000000000000000WS')).toBe('container');
    expect(await resolveRemoveKind('', '01LOCAL00000000000000000WS')).toBe('local');
    expect(await resolveRemoveKind('01LOCAL00000000000000000WS', '01LOCAL00000000000000000WS')).toBe('local');
    expect(await resolveRemoveKind(REMOTE, REMOTE)).toBe('remote');
    expect(await resolveRemoveKind(REMOTE)).toBe('remote');
  });

  it('refuses an opts.id whose kind differs from the id the backend would act on', async () => {
    await writeManifest('01LOCAL00000000000000000WS', 'local');
    await writeRemote(REMOTE);
    await expect(resolveRemoveKind('01LOCAL00000000000000000WS', REMOTE)).rejects.toThrow(/different workspace/);
    await expect(resolveRemoveKind(REMOTE, '01LOCAL00000000000000000WS')).rejects.toThrow(/different workspace/);
  });
});
