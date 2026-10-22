// Readers never see a partial manifest while it's being rewritten (a partial
// read used to drop the workspace from listWorkspaceManifests for that call).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';
vi.mock('electron', () => ({
  app: { getPath: (which: string) => { if (which === 'userData' || which === 'home') return userDataDir; throw new Error(`unexpected getPath: ${which}`); } }
}));

const { readWorkspaceManifest, writeWorkspaceManifest } = await import('./workspaces.js');

beforeEach(async () => { userDataDir = await mkdtemp(join(tmpdir(), 'cf-ws-atomic-')); });
afterEach(async () => { await rm(userDataDir, { recursive: true, force: true }); });

it('a manifest read concurrently with rewrites always parses', async () => {
  const base = {
    id: 'A', name: 'A', labels: [], workspaceRoot: '/w', workspaceSubdir: '', kind: 'container' as const, authMode: 'oauth' as const,
    env: { plain: {}, secretKeys: [] }, mirror: { default: 'on' as const, cleanup: 'delete' as const }, createdAt: 1, lastUsedAt: 1,
    // Pad the file so a non-atomic write has a real window to be caught mid-way.
    description: 'x'.repeat(200_000)
  };
  await writeWorkspaceManifest(base);
  let missed = 0;
  let writing = true;
  const reader = (async () => {
    while (writing) if ((await readWorkspaceManifest('A')) === null) missed++;
  })();
  for (let i = 0; i < 100; i++) await writeWorkspaceManifest({ ...base, lastUsedAt: i });
  writing = false;
  await reader;
  expect(missed).toBe(0);
  expect((await readWorkspaceManifest('A'))?.lastUsedAt).toBe(99);
});
