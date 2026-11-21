// Unit tests for the manifest-env → vault migration.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: {} }));

const { manifestEnvOnWrite, migrateEnvToVault } = await import('./migration.js');

const ws = (id: string, plain: Record<string, string>, secretKeys: string[]) =>
  ({ id, env: { plain, secretKeys } }) as never;

it('migrates then clears manifest env', async () => {
  const written: unknown[] = [];
  const migrate = vi.fn(async () => true);
  await migrateEnvToVault({
    list: async () => [ws('01HW1', { P: '1' }, ['S']), ws('01HW2', {}, [])],
    write: async (m) => {
      written.push(m);
    },
    migrate,
    available: async () => true
  });
  expect(migrate).toHaveBeenCalledWith([
    { id: '01HW1', plain: { P: '1' }, secretKeys: ['S'] },
    { id: '01HW2', plain: {}, secretKeys: [] }
  ]);
  expect(written).toEqual([expect.objectContaining({ id: '01HW1', env: { plain: {}, secretKeys: [] } })]);
});

it('does nothing when the vault is unavailable', async () => {
  const migrate = vi.fn();
  await migrateEnvToVault({
    list: async () => [ws('01HW1', { P: '1' }, [])],
    write: vi.fn(),
    migrate,
    available: async () => false
  });
  expect(migrate).not.toHaveBeenCalled();
});

it('still clears manifests on a re-run (crash between migrate and write)', async () => {
  const written: unknown[] = [];
  await migrateEnvToVault({
    list: async () => [ws('01HW1', { P: '1' }, [])],
    write: async (m) => {
      written.push(m);
    },
    migrate: async () => false,
    available: async () => true
  });
  expect(written).toHaveLength(1);
});

it('leaves manifests intact when the vault migrate fails', async () => {
  const write = vi.fn();
  await expect(
    migrateEnvToVault({
      list: async () => [ws('01HW1', { P: '1' }, ['S'])],
      write,
      migrate: async () => {
        throw new Error("Vault file can't be decrypted; refusing to overwrite it.");
      },
      available: async () => true
    })
  ).rejects.toThrow(/can't be decrypted/);
  expect(write).not.toHaveBeenCalled();
});

describe('manifestEnvOnWrite', () => {
  const existing = { plain: { P: '1' }, secretKeys: ['S'] };
  it('keeps the on-disk env until the vault is migrated', () => {
    expect(manifestEnvOnWrite(false, existing)).toEqual(existing);
    expect(manifestEnvOnWrite(false, undefined)).toEqual({ plain: {}, secretKeys: [] });
  });
  it('forces env empty once migrated', () => {
    expect(manifestEnvOnWrite(true, existing)).toEqual({ plain: {}, secretKeys: [] });
  });
});
