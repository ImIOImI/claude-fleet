// An unreadable workspace.json (e.g. read mid-write) drops that workspace from
// listWorkspaceManifests for the call; it must be logged, while a missing
// manifest or a stray file in the state root stays silent.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData' || which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));
const logged: Array<{ type: string; level: string; workspaceId?: string }> = [];
vi.mock('./errorLog.js', () => ({ logError: (p: { type: string; level: string; workspaceId?: string }) => { logged.push(p); } }));

const { listWorkspaceManifests, readWorkspaceManifest, writeWorkspaceManifest } = await import('./workspaces.js');
const { stateRoot, workspaceManifestPath } = await import('./paths.js');

const spec = (id: string) => ({
  id, name: id, labels: [], workspaceRoot: '/w', workspaceSubdir: '', kind: 'container' as const, authMode: 'oauth' as const,
  env: { plain: {}, secretKeys: [] }, mirror: { default: 'on' as const, cleanup: 'delete' as const }, createdAt: 1, lastUsedAt: 1
});

async function writeRaw(id: string, body: object): Promise<void> {
  await mkdir(join(stateRoot(), id), { recursive: true });
  await writeFile(workspaceManifestPath(id), JSON.stringify(body), 'utf8');
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-manifest-read-'));
  logged.length = 0;
});
afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

it('logs a truncated manifest that drops its workspace from the list', async () => {
  await writeWorkspaceManifest(spec('A'));
  await writeWorkspaceManifest(spec('B'));
  await writeFile(workspaceManifestPath('B'), '{"id": "B", "na', 'utf8'); // mid-write
  expect((await listWorkspaceManifests()).map((s) => s.id)).toEqual(['A']);
  expect(logged).toEqual([expect.objectContaining({ type: 'manifest-unreadable', level: 'warn', workspaceId: 'B' })]);
});

it('stays quiet for a state dir without a manifest and a stray file in the state root', async () => {
  await writeWorkspaceManifest(spec('A'));
  await mkdir(join(stateRoot(), 'no-manifest'), { recursive: true });
  await writeFile(join(stateRoot(), 'stray.txt'), 'x', 'utf8');
  expect((await listWorkspaceManifests()).map((s) => s.id)).toEqual(['A']);
  expect(logged).toEqual([]);
});

it('keeps well-formed mounts on a container manifest', async () => {
  await writeRaw('C', { ...spec('C'), mounts: [
    { hostPath: '/data', containerPath: '/mnt/data', readOnly: true },
    { hostPath: 7 }
  ] });
  expect((await readWorkspaceManifest('C'))?.mounts).toEqual([
    { hostPath: '/data', containerPath: '/mnt/data', readOnly: true }
  ]);
});

it('drops mounts on a local manifest', async () => {
  await writeRaw('D', { ...spec('D'), kind: 'local', mounts: [
    { hostPath: '/data', containerPath: '/mnt/data', readOnly: false }
  ] });
  expect((await readWorkspaceManifest('D'))?.mounts).toBeUndefined();
});

it('keeps a sanitized publish block on a local manifest', async () => {
  const R = '01JC00000000000000000000R1';
  await writeRaw('E', { ...spec('E'), kind: 'local', publish: { to: [R, 'junk'], since: { [R]: 5 } } });
  expect((await readWorkspaceManifest('E'))?.publish).toEqual({ to: [R], since: { [R]: 5 } });
});
