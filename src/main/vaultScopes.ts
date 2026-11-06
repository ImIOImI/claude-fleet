// Vault scope naming for host-only secrets (#444). Pure — no electron — so it
// unit-tests in isolation and ipc.ts can guard the generic vault:* surface.
//
// Loadout-source tokens live in the same secrets.enc as workspace env and
// endpoint keys, under `loadout-source:<normalised base>` / `TOKEN`. The
// renderer may WRITE one (loadouts:addSource / loadouts:setSourceCredential)
// but must never read one back, so the generic vault:* IPC refuses the prefix.

export const SOURCE_VAULT_PREFIX = 'loadout-source:';
export const SOURCE_VAULT_KEY = 'TOKEN';
/** Scope prefix of a model endpoint's API key (endpoints.ts). */
export const ENDPOINT_VAULT_PREFIX = 'endpoint:';
/** Scope prefix of a signed-in identity's bag (identity/identityService.ts).
 *  Host-only: the renderer sees AccountStatus via identity:* IPC instead. */
export const IDENTITY_VAULT_PREFIX = 'identity:';
/** The GitHub sign-in bag: keys TOKEN (OAuth token) and PROFILE (JSON). */
export const GITHUB_IDENTITY_SCOPE = `${IDENTITY_VAULT_PREFIX}github`;
/** Scope prefix of the store's own credentials. Host-only. */
export const STORE_VAULT_PREFIX = 'store:';
/** The managed Postgres container's bag: key APP_PASSWORD (the fleet_app role's password). */
export const MANAGED_STORE_SCOPE = `${STORE_VAULT_PREFIX}managed`;
export const MANAGED_STORE_PASSWORD_KEY = 'APP_PASSWORD';

/**
 * Every vault scope prefix that names a non-workspace bag. A workspace's id is
 * its vault scope (resolveEnv injects that bag into the workspace's env), so a
 * workspace may never be created under one of these.
 */
export const RESERVED_VAULT_PREFIXES: readonly string[] = [SOURCE_VAULT_PREFIX, ENDPOINT_VAULT_PREFIX, IDENTITY_VAULT_PREFIX, STORE_VAULT_PREFIX];

/** Reserved prefixes the renderer may not read or write through vault:*. */
const HOST_ONLY_PREFIXES: readonly string[] = [SOURCE_VAULT_PREFIX, IDENTITY_VAULT_PREFIX, STORE_VAULT_PREFIX];

export function sourceVaultScope(normalisedBase: string): string {
  return `${SOURCE_VAULT_PREFIX}${normalisedBase}`;
}

/**
 * Throw when a renderer-supplied vault scope names a host-only bag. Fails
 * closed: anything that isn't a primitive string is refused, because an array
 * or String object survives structured clone and is coerced to the real scope
 * string when vault.ts indexes its store.
 */
export function assertRendererVaultScope(scope: unknown): asserts scope is string {
  if (typeof scope !== 'string') throw new Error('vault scope must be a string');
  if (HOST_ONLY_PREFIXES.some((p) => scope.startsWith(p))) throw new Error('vault scope is host-only');
}

/**
 * Throw unless a renderer-supplied workspace id is safe to use as a vault
 * scope: a non-empty primitive string with no `:` (so it can never collide
 * with a reserved `<kind>:` scope) and no reserved prefix. ULID format is not
 * required — tests, mock mode and e2e use other ids.
 */
export function assertRendererWorkspaceId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id) throw new Error('workspace id must be a non-empty string');
  if (id.includes(':') || RESERVED_VAULT_PREFIXES.some((p) => id.startsWith(p))) {
    throw new Error('workspace id may not contain ":" or use a reserved vault prefix');
  }
}

/**
 * Throw when a vault scope used to read/write a secret is one of the reserved
 * (non-workspace) bags — `loadout-source:`, `endpoint:`, `identity:` or `store:` — rather than an
 * actual workspace id. `vault.resolveEnv` applies this before injecting a
 * vault bag into a workspace's env; any other main-process call site that
 * takes a caller-influenced scope and hands its secrets somewhere (a script
 * step, a log, a response) should apply the same backstop (#444 final review
 * M6: the automation runner's script-secret lookup did not).
 */
export function assertNotReservedVaultScope(scope: string): void {
  if (RESERVED_VAULT_PREFIXES.some((p) => scope.startsWith(p))) {
    throw new Error('refusing to resolve a reserved vault scope');
  }
}
