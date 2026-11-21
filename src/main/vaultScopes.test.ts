import { describe, expect, it } from 'vitest';
import {
  SOURCE_VAULT_KEY,
  SOURCE_VAULT_PREFIX,
  IDENTITY_VAULT_PREFIX,
  GITHUB_IDENTITY_SCOPE,
  RESERVED_VAULT_PREFIXES,
  sourceVaultScope,
  assertRendererWorkspaceId,
  assertNotReservedVaultScope
} from './vaultScopes.js';

describe('vaultScopes (#444)', () => {
  it('names a source scope by its normalised base', () => {
    expect(SOURCE_VAULT_PREFIX).toBe('loadout-source:');
    expect(SOURCE_VAULT_KEY).toBe('TOKEN');
    expect(sourceVaultScope('ghcr.io/acme/loadouts')).toBe('loadout-source:ghcr.io/acme/loadouts');
  });
});

describe('assertRendererWorkspaceId (#444 security review)', () => {
  it('exports the reserved vault prefixes', () => {
    expect(RESERVED_VAULT_PREFIXES).toEqual(['loadout-source:', 'endpoint:', 'identity:', 'store:', 'app:']);
  });
  it.each([
    ['a loadout-source scope', 'loadout-source:ghcr.io/acme/private'],
    ['an endpoint scope', 'endpoint:3f0c'],
    ['an id with a colon', 'ws:1'],
    ['a non-string', ['01HZXY']],
    ['an empty string', ''],
    ['undefined', undefined],
    ['__proto__', '__proto__']
  ])('refuses %s', (_label, id) => {
    expect(() => assertRendererWorkspaceId(id)).toThrow(/workspace id/);
  });
  it.each(['01HZXYWORKSPACEULID0000000', 'ws-1', 'expert-security', 'aaa'])('allows %s', (id) => {
    expect(() => assertRendererWorkspaceId(id)).not.toThrow();
  });
});

describe('assertNotReservedVaultScope (#444 final review M6)', () => {
  it.each([
    ['a loadout-source scope', 'loadout-source:ghcr.io/acme/private'],
    ['an endpoint scope', 'endpoint:3f0c']
  ])('refuses %s', (_label, scope) => {
    expect(() => assertNotReservedVaultScope(scope)).toThrow(/reserved/);
  });
  it.each(['01HZXYWORKSPACEULID0000000', 'ws-1', ''])('allows %s', (scope) => {
    expect(() => assertNotReservedVaultScope(scope)).not.toThrow();
  });
});

describe('identity scope', () => {
  it('names the GitHub identity scope', () => {
    expect(IDENTITY_VAULT_PREFIX).toBe('identity:');
    expect(GITHUB_IDENTITY_SCOPE).toBe('identity:github');
  });
  it('is reserved as a workspace id and refused by resolveWorkspaceEnv', () => {
    expect(() => assertRendererWorkspaceId('identity:github')).toThrow(/workspace id/);
    expect(() => assertNotReservedVaultScope('identity:github')).toThrow(/reserved/);
  });
});

describe('app: scope', () => {
  it('is reserved for workspace ids', () => {
    expect(() => assertRendererWorkspaceId('app:env')).toThrow();
    expect(RESERVED_VAULT_PREFIXES).toContain('app:');
  });
  it('is never resolved into a workspace env', () => {
    expect(() => assertNotReservedVaultScope('app:env')).toThrow(/reserved/);
  });
});
