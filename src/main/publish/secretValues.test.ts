import { describe, expect, it } from 'vitest';
import { publishSecretValues } from './secretValues.js';

const vault = (bag: Record<string, string>) => ({
  listKeys: async () => Object.keys(bag),
  getSecret: async (_id: string, k: string) => bag[k] ?? null
});

describe('publishSecretValues', () => {
  it('returns the vault bag and the GitHub token', async () => {
    expect(await publishSecretValues({ id: 'W', env: { secretKeys: ['API_TOKEN'] } }, vault({ API_TOKEN: 'v1v1v1v1' }), async () => 'gho_tok'))
      .toEqual([{ key: 'API_TOKEN', value: 'v1v1v1v1' }, { key: 'GITHUB_TOKEN', value: 'gho_tok' }]);
  });

  it('includes stored values that are not declared', async () => {
    expect(await publishSecretValues({ id: 'W', env: { secretKeys: [] } }, vault({ OLD: 'old-value-1' }), async () => null))
      .toEqual([{ key: 'OLD', value: 'old-value-1' }]);
  });

  it('fails closed when a declared secret can’t be read', async () => {
    await expect(publishSecretValues({ id: 'W', env: { secretKeys: ['API_TOKEN'] } }, vault({}), async () => null))
      .rejects.toThrow('secret API_TOKEN can’t be read from the vault');
  });

  it('fails closed when the vault throws', async () => {
    const broken = { listKeys: async () => { throw new Error('locked'); }, getSecret: async () => null };
    await expect(publishSecretValues({ id: 'W', env: { secretKeys: [] } }, broken, async () => null)).rejects.toThrow('locked');
  });
});
