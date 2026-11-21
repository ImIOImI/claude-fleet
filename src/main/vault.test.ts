// vault.ts wires vaultModel's pure root/inherit/override model into the
// safeStorage envelope + write lock. Reserved-scope refusal (resolveWorkspaceEnv
// must never inject a loadout-source/endpoint/identity/store/app bag into a
// workspace env) is covered below alongside the model-backed API.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
const encState = vi.hoisted(() => ({ available: true }));
const fsSpies = vi.hoisted(() => ({ writeFile: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => encState.available,
    setUsePlainTextEncryption: () => undefined,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));
// Spy on the real writeFile (kept functional) so a test can assert vault.ts's
// `mutate` skipped the write entirely, not just that content didn't change.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      fsSpies.writeFile(...args);
      return actual.writeFile(...args);
    }
  };
});

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

  it('a key named like an Object prototype member reads as absent until actually set, then round-trips', async () => {
    expect(await vault.getRootValue('constructor')).toBeNull();
    expect(await vault.revealValue('constructor', null)).toBeNull();
    expect(await vault.getSecret('01HW1', 'constructor')).toBeNull();
    await vault.putKey({ key: 'constructor', secret: true, tags: [], rootValue: 'v' });
    expect(await vault.getRootValue('constructor')).toBe('v');
    expect(await vault.revealValue('constructor', null)).toBe('v');
    await vault.setLine('constructor', '01HW1', { mode: 'inherit' });
    expect(await vault.revealValue('constructor', '01HW1')).toBe('v');
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

  it('migrateManifestEnv does not rewrite secrets.enc once already migrated', async () => {
    await vault.migrateManifestEnv([{ id: '01HW1', plain: { P: '1' }, secretKeys: [] }]);
    fsSpies.writeFile.mockClear();
    await vault.migrateManifestEnv([{ id: '01HW1', plain: { P: '2' }, secretKeys: [] }]);
    expect(fsSpies.writeFile).not.toHaveBeenCalled();
  });
});

describe('undecryptable vault file', () => {
  async function corrupt(): Promise<Buffer> {
    const bytes = Buffer.from('not-json-at-all').toString('base64');
    await writeFile(join(userDataDir, 'secrets.enc'), bytes, 'utf8');
    vault._resetVaultCacheForTests();
    return readFile(join(userDataDir, 'secrets.enc'));
  }

  it('refuses every write and leaves the file bytes unchanged', async () => {
    const before = await corrupt();
    await expect(vault.putKey({ key: 'A', secret: true, tags: [], rootValue: 'r' })).rejects.toThrow(/can't be decrypted/);
    await expect(vault.setSecret('endpoint:x', 'K', 'v')).rejects.toThrow(/can't be decrypted/);
    await expect(vault.deleteSecret('endpoint:x', 'K')).rejects.toThrow(/can't be decrypted/);
    await expect(vault.deleteAllForWorkspace('01HW1')).rejects.toThrow(/can't be decrypted/);
    await expect(vault.deleteAllForWorkspace('endpoint:x')).rejects.toThrow(/can't be decrypted/);
    await expect(vault.migrateManifestEnv([{ id: '01HW1', plain: { P: '1' }, secretKeys: [] }])).rejects.toThrow(/can't be decrypted/);
    expect(await readFile(join(userDataDir, 'secrets.enc'))).toEqual(before);
  });

  it('a non-object payload is also treated as undecryptable', async () => {
    await writeFile(join(userDataDir, 'secrets.enc'), Buffer.from('[1,2]').toString('base64'), 'utf8');
    vault._resetVaultCacheForTests();
    await expect(vault.putKey({ key: 'A', secret: true, tags: [], rootValue: 'r' })).rejects.toThrow(/can't be decrypted/);
  });

  it('reads still answer (empty) while writes are refused', async () => {
    await corrupt();
    expect(await vault.isMigrated()).toBe(false);
    expect(await vault.listModelEntries()).toEqual([]);
  });

  it('a missing or empty file is a fresh, writable vault', async () => {
    await writeFile(join(userDataDir, 'secrets.enc'), '  ', 'utf8');
    vault._resetVaultCacheForTests();
    await vault.putKey({ key: 'A', secret: true, tags: [], rootValue: 'r' });
    expect(await vault.getRootValue('A')).toBe('r');
  });
});
