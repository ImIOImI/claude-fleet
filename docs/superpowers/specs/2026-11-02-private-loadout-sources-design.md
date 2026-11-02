# Private loadout sources (#444)

## Goal

Let a loadout source be a **private** OCI registry (e.g. an organisation's private
`ghcr.io/<org>/claude-fleet-loadouts`), so org loadouts that carry internal policy or config can
be listed and installed from the Library like public ones. Today `src/main/ociClient.ts` does
only the anonymous token flow, so a private source's index and artifacts return 401/403 and the
source can't even be added.

## Non-goals

- Registry *push* or publishing from the app.
- Per-loadout credentials (credentials are per **source**).
- Registries that need anything beyond the Docker/OCI token flow with basic credentials or a
  static bearer token. That covers GHCR, Docker Hub, GitLab and Harbor; ECR and GCR, whose token
  exchange is cloud-specific, are out for now.

## Decided: where a source's credential comes from (option C)

1. **A per-source vault secret** works for any registry and overrides everything else.
2. **For `ghcr.io` sources with no secret, the signed-in GitHub token** (`read:packages`) is used
   automatically once GitHub sign-in exists (remote-workspaces sub-project (b)). **Until then,
   the per-source secret is the only path.**
3. **Otherwise, anonymous** (today's behaviour).

## Data model

- **`sources.json`:** `sources` keeps its `string[]` shape. A new optional map,
  `credentials: Record<base, { username?: string }>`, records that a source has a credential (plus a
  non-secret username for registries that need one). **The secret itself is never in
  `sources.json`.**
- **Vault:** scope `loadout-source:<normalised base>`, key `TOKEN`. It uses the same `secrets.enc`,
  safeStorage envelope and lock as workspace env and endpoint keys (SPEC §7 *Vault layout*).
  Removing a source purges its scope, as `deleteEndpoint` does.

## OCI client

- `anonToken` becomes `registryToken(repository, manifestUrl, cred?)`. It follows the same
  401 → `WWW-Authenticate` → realm flow, and when `cred` is present it sends
  `Authorization: Basic base64(<username or "token">:<TOKEN>)` to the realm. The returned bearer is
  used for the manifest and blob fetches, unchanged from today.
- A registry that answers the probe with 401 and **no** `WWW-Authenticate` realm, or rejects the
  token exchange, gets the credential as a direct `Bearer <TOKEN>` on the manifest request
  (static-token registries).
- **Credential resolution** (`loadoutSources.credentialFor(base)`): the vault secret, then
  (`ghcr.io` only) the signed-in GitHub token, then none. It runs in the main process only. Tokens
  never reach the renderer or any container, and they're never logged (errors name the source,
  not the token).

## Flows

- **Add source:** a 401/403 on the index now yields a typed error,
  `{ kind: 'needs-credential', base }`, instead of a generic failure. The Add-source dialog then
  shows "This source is private. Add a token:" with a password field (and an optional username),
  and saves it to the vault. Then it retries validation. A wrong token shows "credential
  rejected (HTTP 401/403)".
- **Sources list:** each source shows a 🔒 badge when it has a credential, with **Change token…**
  and **Remove token** actions.
- **Install, browse and update** use the resolved credential transparently. The catalog cache is
  unchanged.
- **Headless/remote hosts:** a host's pinned loadouts (`FLEET_LOADOUTS`) resolve credentials from
  the host's env: `FLEET_LOADOUT_TOKEN_<SANITISED_BASE>`, or a single `FLEET_LOADOUT_TOKEN` for one
  private source. A GitHub App installation token works for GHCR.

## IPC

- `loadouts:addSource(base, cred?: { token: string; username?: string })` stores `cred` in the vault
  before validating. On 401/403 it rejects with the typed `needs-credential` error.
- `loadouts:setSourceCredential(base, cred | null)` sets, replaces or removes the token, then
  refreshes the source.
- `loadouts:listSources()` returns `{ base, hasCredential, username? }[]`, never the token.

## Security

- Tokens live only in the vault and in main-process memory during a request.
- The renderer can write a token (add/change) but never read one back. Unlike workspace env
  secrets, there is no `getSecret` path for this scope.
- A source's credential is sent only to that source's registry host and its advertised token
  realm. **A realm on a different host than the registry isn't sent basic credentials unless it's a
  known pairing** (e.g. `ghcr.io` → `ghcr.io/token`). That prevents a malicious index from
  redirecting credentials.

## Testing

- `ociClient.test.ts` with a local fake registry (an HTTP server):
  - anonymous public pull still works;
  - a 401 with a realm, plus basic credentials, gives a bearer and a successful pull;
  - a wrong token gives `credential rejected`;
  - the static-bearer fallback;
  - a cross-host realm doesn't receive credentials.
- `loadoutSources.test.ts`:
  - credential resolution order;
  - `sources.json` never contains a token;
  - remove-source purges the vault scope;
  - `needs-credential` on a private index.
- e2e: the Add-source dialog shows the credential prompt on a 401 source (against a fake
  registry).

## SPEC.md changes (with the implementation)

- §6 *Loadouts*: the new IPC shapes.
- §7 *Loadout library v2 Phase 2*: `credentials` in `sources.json`, and the vault scope.
- §9: the credential flow and the cross-host realm rule.
