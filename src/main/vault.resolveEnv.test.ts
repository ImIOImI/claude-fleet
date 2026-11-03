// resolveEnv injects a vault bag into a workspace's env, so it must never
// resolve a reserved (non-workspace) scope — a defence in depth behind the
// workspace-id guard on workspace:create / writeManifest (#444 security review).
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    setUsePlainTextEncryption: () => undefined,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));

const vault = await import('./vault.js');

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vault-'));
  vault._resetVaultCacheForTests();
});
afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('resolveEnv reserved scopes', () => {
  it('refuses to inject a loadout-source token into a workspace env', async () => {
    await vault.setSecret('loadout-source:ghcr.io/acme/private', 'TOKEN', 'ghp_secret');
    await expect(vault.resolveEnv('loadout-source:ghcr.io/acme/private', {}, ['TOKEN'])).rejects.toThrow(/reserved/);
  });

  it('refuses an endpoint scope', async () => {
    await vault.setSecret('endpoint:3f0c', 'API_KEY', 'sk-x');
    await expect(vault.resolveEnv('endpoint:3f0c', {}, ['API_KEY'])).rejects.toThrow(/reserved/);
  });

  it('resolves an ordinary workspace bag', async () => {
    await vault.setSecret('01HZXYWS', 'K', 'v');
    expect(await vault.resolveEnv('01HZXYWS', { P: '1' }, ['K', 'MISSING'])).toEqual({ P: '1', K: 'v', MISSING: '' });
  });
});
