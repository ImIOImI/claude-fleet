import { describe, expect, it } from 'vitest';
import { SOURCE_VAULT_KEY, SOURCE_VAULT_PREFIX, sourceVaultScope, assertRendererVaultScope } from './vaultScopes.js';

describe('vaultScopes (#444)', () => {
  it('names a source scope by its normalised base', () => {
    expect(SOURCE_VAULT_PREFIX).toBe('loadout-source:');
    expect(SOURCE_VAULT_KEY).toBe('TOKEN');
    expect(sourceVaultScope('ghcr.io/acme/loadouts')).toBe('loadout-source:ghcr.io/acme/loadouts');
  });

  it('refuses loadout-source scopes on the renderer vault surface', () => {
    expect(() => assertRendererVaultScope('loadout-source:ghcr.io/acme/loadouts')).toThrow(/host-only/);
  });

  it('allows workspace and endpoint scopes', () => {
    expect(() => assertRendererVaultScope('01HZXYWORKSPACEULID0000000')).not.toThrow();
    expect(() => assertRendererVaultScope('endpoint:3f0c')).not.toThrow();
  });
});
