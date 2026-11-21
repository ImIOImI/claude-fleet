import { expect, it } from 'vitest';
import { assertNotReservedVaultScope, assertRendererWorkspaceId, MANAGED_STORE_SCOPE, RESERVED_VAULT_PREFIXES } from './vaultScopes.js';

it('the store bag is reserved', () => {
  expect(MANAGED_STORE_SCOPE).toBe('store:managed');
  expect(RESERVED_VAULT_PREFIXES).toContain('store:');
  expect(() => assertNotReservedVaultScope(MANAGED_STORE_SCOPE)).toThrow(/reserved/);
  expect(() => assertRendererWorkspaceId('store:managed')).toThrow();
});
