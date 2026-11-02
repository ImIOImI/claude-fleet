// Vault scope naming for host-only secrets (#444). Pure — no electron — so it
// unit-tests in isolation and ipc.ts can guard the generic vault:* surface.
//
// Loadout-source tokens live in the same secrets.enc as workspace env and
// endpoint keys, under `loadout-source:<normalised base>` / `TOKEN`. The
// renderer may WRITE one (loadouts:addSource / loadouts:setSourceCredential)
// but must never read one back, so the generic vault:* IPC refuses the prefix.

export const SOURCE_VAULT_PREFIX = 'loadout-source:';
export const SOURCE_VAULT_KEY = 'TOKEN';

export function sourceVaultScope(normalisedBase: string): string {
  return `${SOURCE_VAULT_PREFIX}${normalisedBase}`;
}

/** Throw when a renderer-supplied vault scope names a host-only bag. */
export function assertRendererVaultScope(scope: unknown): void {
  if (typeof scope === 'string' && scope.startsWith(SOURCE_VAULT_PREFIX)) {
    throw new Error('vault scope is host-only');
  }
}
