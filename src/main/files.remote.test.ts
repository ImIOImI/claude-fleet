import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));

const files = await import('./files.js');
const { writeWorkspaceManifest } = await import('./workspaces.js');
const { fleetPrivateDir } = await import('./config.js');

const ID = '01REMQTE000000000000000000';

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-drop-remote-'));
  process.env.CLAUDE_FLEET_ROOT = join(userDataDir, 'fleet');
  await writeWorkspaceManifest({
    id: ID, name: 'r', labels: [], workspaceRoot: '', workspaceSubdir: '', kind: 'remote', authMode: 'oauth',
    env: { plain: {}, secretKeys: [] }, mirror: { default: 'on', cleanup: 'delete' },
    remote: { url: 'https://h', tier: 'session', login: 'a', checkedAt: 0 }, createdAt: 1, lastUsedAt: 1
  });
});
afterEach(async () => {
  delete process.env.CLAUDE_FLEET_ROOT;
  await rm(userDataDir, { recursive: true, force: true });
});

it('refuses every drop into a remote workspace and creates no dropbox', async () => {
  await expect(files.dropText(ID, { mime: 'text/plain', text: 'x' })).rejects.toThrow(/remote workspace/);
  await expect(files.dropBytes(ID, { bytes: new Uint8Array([1]) })).rejects.toThrow(/remote workspace/);
  await expect(files.dropOsFiles(ID, [__filename])).rejects.toThrow(/remote workspace/);
  await expect(files.dropUrl(ID, 'https://127.0.0.1:1/x')).rejects.toThrow(/remote workspace/);
  await expect(stat(await fleetPrivateDir(ID))).rejects.toThrow();
});
