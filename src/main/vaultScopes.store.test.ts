import { expect, it } from 'vitest';
import { assertNotReservedVaultScope, assertRendererVaultScope, assertRendererWorkspaceId, MANAGED_STORE_SCOPE, RESERVED_VAULT_PREFIXES } from './vaultScopes.js';

it('the store bag is reserved and host-only', () => {
  expect(MANAGED_STORE_SCOPE).toBe('store:managed');
  expect(RESERVED_VAULT_PREFIXES).toContain('store:');
  expect(() => assertRendererVaultScope(MANAGED_STORE_SCOPE)).toThrow(/host-only/);
  expect(() => assertNotReservedVaultScope(MANAGED_STORE_SCOPE)).toThrow(/reserved/);
  expect(() => assertRendererWorkspaceId('store:managed')).toThrow();
});
