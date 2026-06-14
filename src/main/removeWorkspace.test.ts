// Unit tests for the mock backend's removeWorkspace, covering the
// saved-workspace delete bug: a workspace with no live container (its only
// trace is the on-disk manifest) must still have its state dir wiped when
// deleteState is set, keyed off the ULID. Mirrors the real docker.ts path.
//
// electron is mocked so paths.ts resolves to a temp userData dir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

const { removeWorkspace } = await import('./mock.js');
const { workspaceStateDir } = await import('./paths.js');

async function seedSavedWorkspace(id: string): Promise<string> {
  const dir = workspaceStateDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ id, name: id }), 'utf8');
  return dir;
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'claude-fleet-remove-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('removeWorkspace (saved workspace, no container)', () => {
  it('wipes the state dir when deleteState + id are given', async () => {
    const id = '01KSAVED00000000000000000A';
    const dir = await seedSavedWorkspace(id);
    await expect(stat(dir)).resolves.toBeTruthy();

    // No containerId — exactly the saved-workspace case that used to be skipped.
    await removeWorkspace('', { deleteState: true, id });

    await expect(stat(dir)).rejects.toThrow();
  });

  it('leaves the state dir alone when deleteState is not set', async () => {
    const id = '01KSAVED00000000000000000B';
    const dir = await seedSavedWorkspace(id);

    await removeWorkspace('', { deleteState: false, id });

    await expect(stat(dir)).resolves.toBeTruthy();
  });

  it('is a no-op without throwing when the state dir is already gone', async () => {
    const id = '01KSAVED00000000000000000C';
    // Never created on disk.
    await expect(removeWorkspace('', { deleteState: true, id })).resolves.toBeUndefined();
  });
});
