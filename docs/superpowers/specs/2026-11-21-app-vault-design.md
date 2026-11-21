# App vault: root env + per-workspace inherit/override

Date: 2026-11-21
Status: approved (Troy, 2026-11-21)

## Goal

One vault for every env var and credential the user keeps in claude-fleet:

- **Root values** are the app's own settings. They live on this machine and reach no workspace unless the user publishes them. Example: a personal GitHub PAT used for Settings → Account sign-in, never inherited by any workspace.
- **Workspace lines** publish a key into a workspace. Each line either *inherits* the root value or *overrides* it.
- **Arbitrary keys** are allowed (Twingate, Doppler, AWS…). Keys claude-fleet itself consumes are called out in a pinned **Fleet** group.
- **Tags** filter a large vault.
- The workspace create/edit form's env section becomes a **view of the vault** filtered to that workspace.

Out of scope: non-env workspace settings (image, resources, mounts stay in the manifest); pushing env to remote (`fleet-host`) workspaces; per-line tags.

## 1. Data model

All in `<userData>/secrets.enc`, under the existing safeStorage envelope and write lock (`vault.ts`).

| Scope | Shape | Meaning |
|---|---|---|
| `app:env` | `KEY → value` | Root values. |
| `app:index` | `KEY → JSON {"secret":bool,"inherit":[wsId…],"tags":[tag…]}` | Per-key metadata and the only record of inherit links. |
| `<workspaceId>` | `KEY → value` | Existing per-workspace bag; now holds **override** values for plain and secret keys alike. |

`app:` joins `RESERVED_VAULT_PREFIXES` and the host-only prefixes: the generic `vault:*` IPC refuses it and no workspace id may start with it.

Every key that appears anywhere (root, any bag) has an index entry. A key is valid when it matches `^[A-Za-z_][A-Za-z0-9_]*$`.

### Line states

For key `K` and workspace `W`, exactly one holds:

- **inherit**: `W ∈ index[K].inherit` and `K ∉ bag[W]`.
- **override**: `K ∈ bag[W]` (and `W ∉ index[K].inherit`).
- **unpublished**: neither.

Setting an override removes `W` from `inherit`; reset-to-root deletes `bag[W][K]` and adds `W` to `inherit`. A key with override lines and no root value is **workspace-only**.

### Secret flag

Per key, applies to root and all lines. Secret ⇒ masked in UI, values fetched one at a time via reveal, always scrubbed from published transcripts. Plain ⇒ shown in clear, still encrypted at rest. New keys default to secret.

### Resolution

`resolveWorkspaceEnv(W)`: for each `K` with `W ∈ index[K].inherit` → root value (`''` if unset); then every `bag[W]` entry. Replaces `resolveEnv(id, plain, secretKeys)` at both call sites (`docker.ts`, `local.ts`) and in `claims/captureExec.ts`. `assertNotReservedVaultScope(W)` still applies.

`workspaceSecretValues(W)`: the resolved values of every secret key published to `W`. Used by publish scrubbing (`publish/secretValues.ts`) and the automation runner's script-secret lookup (`automationIpc.ts`), which today read the bag directly and would miss inherited values.

`workspaceKeys(W)`: `{ key, secret }[]` for every key published to `W` (inherit or override). Replaces manifest `env.plain`/`env.secretKeys` reads in loadout-automation missing-secret checks, `captureExec`, and the renderer.

### When changes apply

Env is fixed when the container or process is created. Local workspaces pick changes up at their next spawn; containers only on **recreate** (stop/start keeps the old env). Main records, per workspace, a hash of the resolved env at create/spawn time (`<userData>/state/<id>/env-applied.json`, `{ hash, at }` — a SHA-256 of the sorted resolved env, no values). A line whose workspace's current resolved hash differs shows **"recreate to apply"** (container) or **"restart to apply"** (local, running).

### Mutations

All run in one locked read-modify-write:

- **Rename** `K → K2`: moves root, index entry and every bag entry. Refused if `K2` exists.
- **Delete root value**: drops `app:env[K]` and `index[K].inherit`. Override lines remain (key becomes workspace-only). The UI confirms when inherit lines exist.
- **Delete key**: drops root, index entry and every bag entry.
- **Delete workspace** (`deleteAllForWorkspace`): also removes `W` from every `inherit` list; drops index entries left with no root and no lines.
- **Copy workspace** (duplicate / clone in `App.tsx`): copies `W`'s inherit links and overrides to the new id.

## 2. Tags

User tags are per key, stored in `index[K].tags`, lowercase `[a-z0-9-]{1,32}`, at most 16 per key, autocompleted from tags in use.

Derived tags are computed at list time, never stored:

- `root` (has a root value),
- one per published workspace (its current display name, keyed by ULID so renames follow),
- `fleet` (recognized key),
- `secret` / `plain`.

Filter = chip bar (AND across chips) + text search over key names and tags. Derived chips render outlined, user tags filled.

## 3. Fleet-recognized keys

A static registry in `src/preload/fleetKeys.ts` (shared by main and renderer): `{ key, label, description, secret }[]`. The Fleet group always shows every registry entry, set or not. v1 registry:

| Key | Used for |
|---|---|
| `GITHUB_TOKEN` | GitHub sign-in with a personal access token instead of the device flow. |

Entries are only added when main has a consumer. Fleet keys can be published to workspaces like any key; nothing is published by default.

Main reads recognized root values directly from `app:env`. Root values are **never** copied into `process.env` (local workspaces spawn from main's env).

### PAT sign-in

`IdentityService.load()` prefers a root `GITHUB_TOKEN` over the device-flow token in `identity:github`:

- On first use (or when the PAT changes), it verifies the PAT with the same profile probe as device-flow sign-in (`GET /user`, `/user/teams`, scopes from `X-OAuth-Scopes`) and caches the profile in `identity:github` `PROFILE` with `source: "pat"` plus a SHA-256 of the token (not the token).
- `AccountStatus` gains `source: 'device' | 'pat' | null`. Settings → Account shows "Signed in with a personal access token (Vault)". Sign out is replaced by "Manage in Vault", which opens the Vault tab on `GITHUB_TOKEN`.
- A PAT that fails verification (401) is not cleared (the user owns it); status shows `notice` and `signedIn: false`, and the device flow stays available.
- Fine-grained PATs send no `X-OAuth-Scopes`; scopes resolve to `[]`, so `packagesAccess` is false and team-based grants need `read:org`. The Account notice says so.
- `bearerToken()` and `packagesToken()` return the PAT when it is the active source.

## 4. IPC

New `vault:*` channels (`vaultIpc.ts`), all main-side validated, failing closed on non-primitive arguments like the existing surface:

- `vault:list()` → `VaultEntry[]`: `{ key, secret, tags, fleet, root: { set, value? }, lines: { workspaceId, mode: 'inherit' | 'override', value?, pending: 'recreate' | 'restart' | null }[] }`. `value` is present only for **plain** keys. Secret values never appear.
- `vault:reveal(key, workspaceId | null)` → `string | null`: one value (root when `workspaceId` is null). Replaces the renderer's `vault:getSecret` use in `secretReveal.ts`.
- `vault:putKey({ key, secret, tags, rootValue? })` → `void`: create or update a key's metadata and root value. `rootValue: null` deletes the root value; absent leaves it.
- `vault:renameKey(key, newKey)` → `void`.
- `vault:deleteKey(key)` → `void`.
- `vault:setLine(key, workspaceId, { mode: 'inherit' } | { mode: 'override', value })` → `void`.
- `vault:removeLine(key, workspaceId)` → `void`.
- `vault:copyWorkspace(fromId, toId)` → `void`.

Workspace ids are checked with `assertRendererWorkspaceId`; keys with the key regex. `vault:listKeys`, `vault:getSecret`, `vault:setSecret`, `vault:deleteSecret` remain for endpoint scopes only; they now refuse workspace scopes (workspace env goes through the channels above).

## 5. UI

### Settings → Vault tab

New `ActiveTab` value `'vault'` in `SettingsModal`, component `VaultSettings.tsx`, pure view logic in `vaultView.ts` (filtering, derived tags, grouping, sort).

- Header: search box, tag chips, **+ Add key**.
- **Fleet** group pinned on top (registry order), then **Keys** sorted by name.
- Key row: name, root value (masked + reveal for secret, clear for plain, "— not set —", or "workspace-only"), tag chips, collapsed line count, secret toggle, edit, delete.
- Expanded: one line per published workspace — *inherited from root* with **Override**; or *override* with its value, **Reset to root** (disabled without a root value) and pending badge; ✕ unpublishes. **Publish to workspace** picker lists local and container workspaces not yet on the key (remote excluded).
- Add key: name, value, tags, secret (default on). A recognized name lands in its Fleet slot.
- Degraded vault (`vault:available` false): tab is read-only with the existing degraded notice.
- `SettingsModal` accepts `initialTab: 'vault'` plus an optional `focusKey` so Account's "Manage in Vault" opens on `GITHUB_TOKEN`.

### Workspace form env section

The env editor in `WorkspaceForm.tsx` becomes a vault view for the workspace:

- Lists keys published to this workspace (inherit / override, same controls as the tab), with the same search and chips; the workspace's derived tag is pre-selected.
- **Add from vault** picker publishes an existing key (inherit by default).
- **New key** creates a key with an override value only (workspace-only); "also set as root" checkbox writes the root value and makes the line inherit.
- In create mode (no workspace yet), edits are staged in the form and applied with `vault:setLine` / `vault:putKey` against the minted ULID before `workspace:create`, replacing `persistSecrets`.
- `WorkspaceFormSubmit` drops `plainEnv`, `secretKeys`, `secrets`; the manifest stops carrying env (see §6).

## 6. Migration

One-time, at startup in `migration.ts`, guarded by `app:index` key `__migrated__` (excluded from listings):

1. For each manifest with `env.plain` or `env.secretKeys`: plain values → `bag[W][K]`; secret keys already have values in `bag[W]`.
2. Index entries created for every migrated key; `secret: true` if any workspace had it secret (so a key plain in one workspace and secret in another becomes secret).
3. All migrated lines are **overrides**; no root values are invented.
4. Manifests are rewritten with `env: { plain: {}, secretKeys: [] }` (field kept so older builds still parse). A downgrade after migration starts workspaces without their env; accepted.

`workspaces.ts` keeps reading `env` (migration source); every manifest writer stops populating it.

## 7. Errors

- Vault unavailable: list returns what it can; writes throw the existing "Vault unavailable" error; UI read-only.
- Inherited key with no root value resolves to `''` and the line shows a warning.
- Rename onto an existing key, invalid key/tag, publish to a remote or unknown workspace: rejected in main with a message.

## 8. Testing

- `vault.test.ts` / new `vaultModel.test.ts` (pure model: line states, resolution, rename, delete cascades, copy, migration merge incl. the plain/secret collision).
- `vaultIpc.test.ts`: argument validation, secret values absent from `vault:list`, workspace scopes refused on legacy channels, `app:` refused.
- `vaultScopes.test.ts`: `app:` reserved.
- `vaultView.test.ts`: filtering, derived tags, Fleet pinning.
- `identityService.test.ts`: PAT precedence, verify-once caching by token hash, 401 handling, `source` field, bearer/packages tokens.
- `secretValues.test.ts`: inherited secret values are scrubbed.
- e2e: update `tests/vault.spec.ts` for the Vault tab (add key, publish, override, reset) in mock mode.
- UI is verified on host (no display in container).

## 9. SPEC.md

Same PR updates §5 (Settings modal, workspace form), §6 IPC (`vault:*`), §7 *Vault layout* and manifest `env`, §9 security (root values never in `process.env`; `app:` host-only), §*Account* (PAT source).
