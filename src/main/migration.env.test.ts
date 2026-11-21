// Unit tests for the manifest-env → vault migration (Task 6).
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: {} }));

const { migrateEnvToVault } = await import('./migration.js');

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
