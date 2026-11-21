// vault.ts wires vaultModel's pure root/inherit/override model into the
// safeStorage envelope + write lock. Reserved-scope refusal (resolveWorkspaceEnv
// must never inject a loadout-source/endpoint/identity/store/app bag into a
// workspace env, #444) is covered below alongside the model-backed API.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
const encState = vi.hoisted(() => ({ available: true }));
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => encState.available,
    setUsePlainTextEncryption: () => undefined,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));

const vault = await import('./vault.js');

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vault-'));
  encState.available = true;
  vault._resetVaultCacheForTests();
});
afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('workspace env via the model', () => {
  it('resolves inherit + override and persists across a cache reset', async () => {
    await vault.putKey({ key: 'A', secret: true, tags: [], rootValue: 'r' });
    await vault.setLine('A', '01HW1', { mode: 'inherit' });
    vault._resetVaultCacheForTests();
    expect(await vault.resolveWorkspaceEnv('01HW1')).toEqual({ A: 'r' });
  });

  it('refuses reserved scopes', async () => {
    await expect(vault.resolveWorkspaceEnv('loadout-source:ghcr.io/acme/private')).rejects.toThrow(/reserved/);
    await expect(vault.resolveWorkspaceEnv('app:env')).rejects.toThrow(/reserved/);
  });

  it('deleteAllForWorkspace cascades inherit links', async () => {
    await vault.putKey({ key: 'A', secret: true, tags: [], rootValue: 'r' });
    await vault.setLine('A', '01HW1', { mode: 'inherit' });
    await vault.deleteAllForWorkspace('01HW1');
    expect((await vault.listModelEntries())[0].lines).toEqual([]);
  });

  it('deleteAllForWorkspace on a reserved scope drops only that bag', async () => {
    await vault.setSecret('endpoint:x', 'ANTHROPIC_AUTH_TOKEN', 'k');
    await vault.putKey({ key: 'A', secret: true, tags: [], rootValue: 'r' });
    await vault.deleteAllForWorkspace('endpoint:x');
    expect(await vault.getSecret('endpoint:x', 'ANTHROPIC_AUTH_TOKEN')).toBeNull();
    expect(await vault.getRootValue('A')).toBe('r');
  });

  it('revealValue reads root or the resolved line value', async () => {
    await vault.putKey({ key: 'A', secret: true, tags: [], rootValue: 'r' });
    await vault.setLine('A', '01HW1', { mode: 'override', value: 'o' });
    expect(await vault.revealValue('A', null)).toBe('r');
    expect(await vault.revealValue('A', '01HW1')).toBe('o');
    expect(await vault.revealValue('A', '01HW2')).toBeNull();
  });

  it('writes throw when encryption is unavailable', async () => {
    encState.available = false;
    vault._resetVaultCacheForTests();
    await expect(vault.putKey({ key: 'A', secret: true, tags: [], rootValue: 'r' })).rejects.toThrow(/Vault unavailable/);
  });

  it('migrateManifestEnv runs once', async () => {
    expect(await vault.migrateManifestEnv([{ id: '01HW1', plain: { P: '1' }, secretKeys: [] }])).toBe(true);
    expect(await vault.migrateManifestEnv([{ id: '01HW1', plain: { P: '2' }, secretKeys: [] }])).toBe(false);
    expect(await vault.resolveWorkspaceEnv('01HW1')).toEqual({ P: '1' });
  });
});
