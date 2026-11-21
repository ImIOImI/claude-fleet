import { describe, expect, it, vi } from 'vitest';
import { ENDPOINT_VAULT_KEY, endpointVaultScope } from '../endpoints.js';
import { publishSecretValues } from './secretValues.js';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));

const vault = (pairs: { key: string; value: string }[]) => ({
  workspaceSecretValues: async () => pairs,
  getSecret: async () => null
});

describe('publishSecretValues', () => {
  it('returns the vault bag and the GitHub token', async () => {
    expect(await publishSecretValues({ id: 'W' }, vault([{ key: 'A', value: 'inherited' }]), async () => 'gho_tok'))
      .toEqual([{ key: 'A', value: 'inherited' }, { key: 'GITHUB_TOKEN', value: 'gho_tok' }]);
  });

  it('a workspaceSecretValues rejection propagates (nothing is sent)', async () => {
    const broken = { workspaceSecretValues: async () => { throw new Error('locked'); }, getSecret: async () => null };
    await expect(publishSecretValues({ id: 'W' }, broken, async () => null)).rejects.toThrow('locked');
  });

  describe('model endpoint key', () => {
    const scoped = (bags: Record<string, Record<string, string>>) => ({
      workspaceSecretValues: async (id: string) => Object.entries(bags[id] ?? {}).map(([key, value]) => ({ key, value })),
      getSecret: async (id: string, k: string) => bags[id]?.[k] ?? null
    });
    const spec = { id: 'W', authMode: 'endpoint', endpointId: 'ep1' };

    it('includes the API key of the endpoint the workspace uses', async () => {
      const v = scoped({ [endpointVaultScope('ep1')]: { [ENDPOINT_VAULT_KEY]: 'sk-endpoint-key-1' } });
      expect(await publishSecretValues(spec, v, async () => null, async () => ({ hasApiKey: true })))
        .toEqual([{ key: ENDPOINT_VAULT_KEY, value: 'sk-endpoint-key-1' }]);
    });

    it('fails closed when the endpoint has a key that can’t be read', async () => {
      await expect(publishSecretValues(spec, scoped({}), async () => null, async () => ({ hasApiKey: true })))
        .rejects.toThrow('the model endpoint’s API key can’t be read from the vault');
    });

    it('a leftover endpointId with authMode not endpoint is scrubbed when readable and never blocks publishing', async () => {
      const left = { id: 'W', authMode: 'oauth', endpointId: 'ep1' };
      expect(await publishSecretValues(left, scoped({}), async () => null, async () => ({ hasApiKey: true }))).toEqual([]);
      expect(await publishSecretValues({ ...left, authMode: undefined }, scoped({}), async () => null, async () => ({ hasApiKey: true }))).toEqual([]);
      const v = scoped({ [endpointVaultScope('ep1')]: { [ENDPOINT_VAULT_KEY]: 'sk-endpoint-key-1' } });
      expect(await publishSecretValues(left, v, async () => null, async () => ({ hasApiKey: true })))
        .toEqual([{ key: ENDPOINT_VAULT_KEY, value: 'sk-endpoint-key-1' }]);
    });

    it('needs nothing from an endpoint without a key, an unknown one, or a workspace that uses none', async () => {
      expect(await publishSecretValues(spec, scoped({}), async () => null, async () => ({ hasApiKey: false }))).toEqual([]);
      expect(await publishSecretValues(spec, scoped({}), async () => null, async () => null)).toEqual([]);
      const other = scoped({ [endpointVaultScope('ep2')]: { [ENDPOINT_VAULT_KEY]: 'sk-other-key-22' } });
      expect(await publishSecretValues({ id: 'W' }, other, async () => null, async () => ({ hasApiKey: true }))).toEqual([]);
    });
  });
});
