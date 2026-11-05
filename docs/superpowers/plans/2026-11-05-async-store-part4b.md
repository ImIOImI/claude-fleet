# Async store layer, part 4b: the managed Postgres store, Settings → Storage, the first-switch copy, the degraded state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user picks Postgres in Settings → *Storage*. The app then:
- runs a pinned pgvector container with its credentials in the vault;
- copies the user's SQLite inbox and history into it on the first start;
- keeps working while that store is starting, copying or unreachable, behind a banner.

This completes remote-workspaces sub-project (a). SQLite behaviour is unchanged.

**Architecture:**
- **Startup:** config.json `{ kind: 'postgres', managed: true }` starts a `StoreSupervisor` instead of blocking the launch.
- **Supervisor:** it brings the store up:
  1. `ensureManagedPostgres`: the container on a named volume and a fixed loopback port, bootstrapped over `docker exec` with a SCRAM verifier.
  2. `openPgStores`.
  3. The first-switch copy (`importSqlite`): chunked, resumable, ids kept.
  4. Then it starts the store-backed services that today start inline on SQLite.
- **Health:** a 5 s ping turns an outage into a `down` status, and recovery re-reads transcripts from their offsets.
- **UI:** the renderer gets a `store:*` IPC surface, a radio group under Settings → *Storage*, and a store banner beside the daemon banner.

**Tech Stack:** TypeScript, Electron main + React renderer, dockerode, `pg` 8.23, better-sqlite3 13, kysely 0.28, `pgvector/pgvector:0.8.7-pg16` (pinned by digest), vitest 4, Playwright.

**Spec and inputs:**
- `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §7: "**Postgres** (`store: { kind: 'postgres', managed: true }`): an app-managed Postgres + pgvector container (a pinned image started through `dockerode`, data in a named volume) … It needs Docker running: while the daemon is down, history and inbox are unavailable, and the setup step says so." Also §11 (a).
- The *Part 4 outline* in `docs/superpowers/plans/2026-11-04-async-store-part3.md`.
- **`docs/superpowers/plans/2026-11-05-async-store-part4a.md` must be merged first.** This plan starts from its end state: `ReadSource`, `setReadSource`, `openPgMcpReadSource`, `PgStores.poolConfig`, `scram.ts` and `testPgAppSchema`.

**Ships:** users pick Postgres locally in Settings; the app runs, copies into and watches the managed container; SQLite users see no change. This completes (a).

## Global Constraints

Everything in part 4a's *Global Constraints* still binds. In addition:

- "**The local DB is the user's choice at setup** (`config.json` `store`): **SQLite** (default) … **Postgres** (`store: { kind: 'postgres', managed: true }`) … It needs Docker running: while the daemon is down, history and inbox are unavailable, and the setup step says so." (spec §7, verbatim)
- **SQLite users see no behaviour change.** The SQLite boot order is kept statement for statement: Task 4 moves code into functions, and SQLite calls them in the original order. No SQLite file, table or IPC result changes. **Never run `vitest -u`.**
- **Desktop config refuses plaintext secrets.** config.json gets only `{ kind: 'postgres', managed: true, poolMax? }`. The password lives in the vault scope `store:managed`, which is host-only.
- **Never lose data on failure.**
  - The copy only reads the SQLite files.
  - It commits progress with each chunk, and verifies row counts before marking a table done.
  - It renames `inbox.db` only after the inbox copy has finished.
  - It never writes a target that already holds data it didn't write.
- **No silent SQLite fallback** while Postgres is configured. That would split the data.
- **TLS:** the managed connection is loopback-only with `ssl: 'disable'` (D46), matching part 3's loopback default.
- **Local workspaces' env stays scrubbed:** `storeSecretEnvNames({ kind: 'managed' })` is the libpq list. The managed password is never in an env var the app sets.
- **Docker isn't available in this container.** `managedDocker.ts` is typechecked here; `managedPostgres.ts`'s logic runs against a fake. Troy eyeballs the real container on the host. Say so in the PR.
- The rest of part 4a's constraints apply unchanged: comment rules, typecheck all three configs, commit trailer, SPEC.md in the same PR, CI as the gate.

## Decisions (D45–D52, recorded in SPEC.md by Task 6)

- **D45 — The managed container** (`store/managedPostgres.ts`, with Docker injected as `ManagedDocker`).
  - **Image:** `pgvector/pgvector:0.8.7-pg16@sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f`, the multi-arch index digest, read from Docker Hub while writing this plan. It is the CI service's PG 16 + pgvector 0.8.7.
  - **Names and labels:** container `claude-fleet-postgres`, volume `claude-fleet-postgres-data`.
    - Both are labelled `com.claude-fleet.store=postgres` and `com.claude-fleet.store.pg-major=16`.
    - They are **never** labelled `com.claude-fleet.managed`: `listLiveWorkspaces` would list the container as a workspace.
  - **Port:** `127.0.0.1:<port>`, where `<port>` is picked free once (`freeLoopbackPort`) and fixed in the container's `PortBindings`. A restart therefore keeps the pool's address, and `repair` can restart a container under a live pool.
  - **Database:** `initdb --locale=C.UTF-8 --encoding=UTF8`, database `fleet`, `RestartPolicy: no`.
  - **Bootstrap** runs as the superuser over the container's own socket, using the image's local trust: `docker exec sh -c 'printf %s "$FLEET_PG_SQL" | psql -v ON_ERROR_STOP=1 -X -q -U postgres -d fleet -f -'`.
    - It creates role `fleet_app` (LOGIN, CREATEROLE), whose password is set as a SCRAM verifier.
    - It creates schema `fleet`, owned by `fleet_app`.
    - It creates `vector` in `public`, then runs `ALTER EXTENSION vector UPDATE`.
    - It runs `ALTER ROLE postgres PASSWORD NULL`.
    - The app connects as `fleet_app`. That is D23's shape: the store never creates its schema or extension. `CREATEROLE` is what 4a's `query` isolation needs.
  - **Why exec and not a superuser login:** no superuser password is stored or usable over TCP. A lost vault only means a new `fleet_app` password at the next start; the data is untouched.
  - **Health:** the app checks `pg_isready -h 127.0.0.1` inside the container, for up to 90 s. TCP, because during initdb the entrypoint's temporary server listens on the socket only and then stops. The container also has a Docker healthcheck.
  - **Upgrades:**
    - A container from another digest is stopped, removed and recreated on the same volume and port. The bootstrap's `ALTER EXTENSION vector UPDATE` then upgrades pgvector.
    - A volume with another major label, or none, is refused. `pg_upgrade` is out of scope; a future major bump plans its own migration.
  - **Stop:** best effort at quit (`docker stop -t 10`). Postgres's WAL makes an unclean stop safe.
- **D46 — TLS on the managed connection is `disable`.**
  - The port is bound to `127.0.0.1`, which is part 3's loopback default.
  - `verify-full` would need a CA and a server certificate minted per install and mounted into the container, with no network exposure to protect.
  - Other local users reaching the port still need `fleet_app`'s password.
- **D47 — Credentials.**
  - The vault scope `store:managed`, key `APP_PASSWORD`, is minted on first start.
  - `store:` joins `RESERVED_VAULT_PREFIXES` and the host-only prefixes, so the renderer's `vault:*` refuses it and no workspace id can take it.
  - `ensureManagedPostgres` returns a `PostgresStoreConfig` with `password: { kind: 'static' }`, built in main, never parsed from config.json. So part 3's refusal of static secrets in config.json is untouched.
  - The plaintext reaches Postgres only as a verifier inside an exec env var. A bootstrap error is redacted of verifiers before logging.
- **D48 — Settings → *Storage*.**
  - **The choice:** a radio group, *SQLite (built in)* or *Postgres, managed by claude-fleet*. `store:setChoice` writes config.json, and it applies at restart (*Restart now* = `app:relaunch`).
  - **External Postgres** stays hand-edited, and the section says so. The outline's UI for it was dropped: its connection forms and credentials are D31's, and a password field would need a vault-backed password kind. YAGNI until someone asks.
  - **Mock mode** ignores `store`: it has no Docker.
- **D49 — The first-switch copy (`store/storeImport.ts`, `store/firstSwitch.ts`).**
  - **What is copied:** the inbox (authoritative) is copied, and so is state.db. state.db is **copied, not re-ingested**, because:
    - renames (`sessions.user_set_name`), tab↔session mappings (`broker_sessions`) and usage signals (`usage_events`) aren't in the transcripts;
    - summaries and embeddings reference event ids, which a re-ingest would renumber;
    - re-embedding a long history costs CPU-hours.
  - **Mechanism:**
    - Keyset by `rowid`, in chunks of at most 30 000 bind parameters; vectors are converted BLOB → `vector`.
    - Each chunk commits with its progress row (`store_import`, track `import`). At a table's end, PG and SQLite row counts must match, then every identity sequence is `setval` to its max id.
    - The copy restarts (truncating the source's tables) when the file's fingerprint changed since the run began.
    - It refuses a target holding rows it didn't write (`skipped-nonempty`, shown as a Settings notice), and a SQLite file at another schema version.
  - **After the copy:**
    - `inbox.db` is renamed `inbox.db.migrated-<ms>` with its WAL and SHM.
    - `state.db` stays as the cache a switch back to SQLite resumes from.
    - Nothing is copied back; Settings says so.
  - **Found in validation:**
    - A read-only open of a WAL database creates an empty `-wal`. A fingerprint over size + mtime therefore changed on every attempt, so every resume silently restarted. The fingerprint now treats an empty WAL as none, and a test pins that.
    - `openDbPostgres` must run **after** the copy: it rehydrates `pendingClaudeIds` from `broker_sessions`.
- **D50 — The degraded and importing states** (`store/storeSupervisor.ts`).
  - **The phases:** `starting`, `importing`, `ready` and `down`. They are pushed as `store:status`.
  - **Bring-up:** `open` then `prepare` (the copy) then `ready`. A failure closes what opened, goes `down` with the reason, and retries after 1 s, doubling to 30 s.
  - **`ready` runs once.** It opens `db.ts` and starts the error sink and perf telemetry, the MCP read source, the watcher, the embedding backfill, the inbox/notify/automation IPC and presence. Then it broadcasts `inbox:changed`.
  - **Watching:** a ping every 5 s (3 s timeout). A failure goes `down` and runs `repair` (managed: `ensureManagedPostgres`). The next good ping goes `ready` and runs `recovered`, which calls `jsonlWatcher.requeueAll()` and broadcasts `inbox:changed`.
  - **Why these suffice:**
    - A batch that failed while the store was down never advanced its offset (`readAndIngest` throws before `state.offset` is set), so the requeue catches up.
    - pg's pool reconnects on its own, because the port is fixed.
  - **While not ready:**
    - Store-backed IPC either isn't registered yet (inbox) or rejects (`db not opened`). Today's mock mode and `inbox-open-failed` paths already behave this way, and the renderer tolerates them.
    - MCP history tools answer `unavailable while the history store is not open` (4a).
- **D51 — The Postgres perf gate: absolute budgets, not a ratio to SQLite.**
  - **What was measured:** in this container on the socket server, under load, ingest was about 18× SQLite's per line (1.7 ms) and single writes about 6 ms. That is a round trip and a commit per statement. Reads stayed far inside one 16 ms frame (summary 13.7 ms, events page 6 ms, list 4.6 ms, search 6.6 ms at 5k rows).
  - **The budgets:** reads ≤ 16 ms; ingest ≤ 3 ms/line (a 200-line watcher batch ≤ 0.6 s, off the UI path); writes ≤ 10 ms; lookups ≤ 1 ms; search ≤ 50 ms; stall max ≤ 50 ms.
  - **Who measures where:** Troy re-runs the bench against the managed container on the host, over loopback TCP. The container numbers are recorded in Task 6.
- **D52 — The boot restructure.**
  - `index.ts`'s inline store block becomes five functions called in the original order on SQLite: `startStateWrites`, `startIngest`, `startEmbedBackfill`, `startInboxServices` and `startPresenceServices`.
  - On Postgres they run from the supervisor's `ready`.
  - The `StoreSupervisor` is built before IPC registration (`setActiveStore`) and run after the window exists.

## Validation done while writing this plan

Every task below was applied, by its own scripts and files, to a scratch tree at origin/main `0f9366e` plus part 4a's tasks replayed from that plan. Both scratch worktrees were removed afterwards. The results:
- All three typechecks pass.
- The whole SQLite unit suite passes, 2535 tests. The one failure was the known `jsonlWatcher.ordering` flake, which passed on re-run.
- The whole Postgres suite passes: 39 files, 331 tests.

- **The copy (`storeImport.test.ts`):** 8/8 on PG 16.15. Each mutation below was run alone:

  | Mutation | Failing test |
  |---|---|
  | S1: no `setval` | *copies both stores…*, which fails with a duplicate key on `todo_events_pkey` |
  | S2: no fingerprint restart | *a source changed between attempts…* |
  | S3: no non-empty check | *leaves a store that already holds data untouched* |
  | S4: progress not committed with the chunk | *resumes after a failure…* |
  | S5: an empty WAL counts | *a read-only open does not change the fingerprint* and *resumes…* |
  | S6: no count check | *a row written by anything else during the copy fails it* |

- **The bootstrap SQL:** runs twice cleanly on PG 16. The store then opens as the bootstrapped role, and `isolationBlocker` returns null (`managedPostgres.pg.test.ts`).
- **The supervisor, the managed-container logic and the watcher requeue:** unit-tested with fakes.

## Verification environment (once, before Task 1)

```bash
git -C /workspace/claude-fleet fetch -q origin
WT=/workspace/claude-fleet/.claude/worktrees/async-store-p4b
git -C /workspace/claude-fleet worktree add -b feat/async-store-p4b "$WT" origin/main   # part 4a merged
cd "$WT"
npm ci --ignore-scripts
printf 'electron-stub' > node_modules/electron/path.txt
eval "$(scripts/pg-test-server.sh start)"
```

The gates, known flakes and `grep -a` note are part 4a's. Task 2's suite helper `/tmp/p4b_suite.py` adds files to `vitest.pg.config.ts`:

```python
"""Add test files to vitest.pg.config.ts's include list. Usage: python3 /tmp/p4b_suite.py <file>... (from the worktree root)."""
import re
import sys

p = 'vitest.pg.config.ts'
s = open(p).read()
m = re.search(r'(    include: \[\n)(.*?)(\n    \],)', s, flags=re.S)
have = set(re.findall(r"'([^']+)'", m.group(2))) | set(sys.argv[1:])
body = '\n'.join(f"      '{f}'," for f in sorted(have))
open(p, 'w').write(s[:m.start()] + m.group(1) + body + m.group(3) + s[m.end():])
print('ok')
```

## File structure

| File | Responsibility |
|---|---|
| `src/main/store/storeConfig.ts` | `ManagedStoreConfig`; `{ kind: 'postgres', managed: true }`; `allowManaged`. |
| `src/main/vaultScopes.ts` | `STORE_VAULT_PREFIX`, `MANAGED_STORE_SCOPE`, `MANAGED_STORE_PASSWORD_KEY`. |
| `src/main/store/managedPostgres.ts` (new) | `ensureManagedPostgres`, `stopManagedPostgres`, `bootstrapSql`, the constants, `ManagedDocker`. |
| `src/main/store/managedDocker.ts` (new) | dockerode behind `ManagedDocker`. |
| `src/preload/storeTypes.ts` (new) | `StoreChoice`, `StorePhase`, `ImportProgress`, `StoreStatus`, `StoreSettings`. |
| `src/main/store/storeImport.ts` (new) | `IMPORT_PG_TRACK`, `IMPORT_TABLES`, `importSqlite`, `sourceFingerprint`. |
| `src/main/store/firstSwitch.ts` (new) | `firstSwitchCopy`, `retireSqliteFile`. |
| `src/main/store/storeSupervisor.ts` (new) | `StoreSupervisor` (D50). |
| `src/main/store/storeIpc.ts` (new) | `store:*` + `app:relaunch`, `setActiveStore`, `broadcastStoreStatus`, `storeChoiceOf`. |
| `src/main/store/pgStores.ts` | `pingStore`. |
| `src/main/jsonlWatcher.ts` | `requeueAll()`. |
| `src/main/config.ts` | `setStoreChoice`; `getStoreConfig` allows managed. |
| `src/main/index.ts` | The boot restructure (D52); supervisor; quit stops the container. |
| `src/preload/index.ts` | `api.store`, `api.app.relaunch`. |
| `src/renderer/src/storeView.ts` (new), `components/StorageSettings.tsx` (new), `App.tsx`, `SettingsModal.tsx`, `styles.css`, `tsconfig.web.json` | Settings → Storage, the store banner. |
| `src/main/state/stateBench.test.ts` | Runs on Postgres; `PG_GATE`. |
| Tests | `storeConfig.managed.test.ts`, `vaultScopes.store.test.ts`, `managedPostgres.test.ts`, `managedPostgres.pg.test.ts`, `storeImport.test.ts`, `firstSwitch.test.ts`, `storeSupervisor.test.ts`, `jsonlWatcher.requeue.test.ts`, `storeView.test.ts`, `tests/storage-settings.spec.ts`. |
| `docs/SPEC.md` | Task 6. |

---

### Task 1: The managed store form and its vault scope

**Files:**
- Modify: `src/main/store/storeConfig.ts`, `src/main/config.ts` (`allowManaged`), `src/main/vaultScopes.ts`, `src/main/vaultScopes.test.ts`, `src/main/index.ts` (an interim guard)
- Create: `src/main/store/storeConfig.managed.test.ts`, `src/main/vaultScopes.store.test.ts`

**Interfaces:**
- Produces:
  - `ManagedStoreConfig { kind: 'managed'; poolMax }` and `StoreConfig = { kind: 'sqlite' } | PostgresStoreConfig | ManagedStoreConfig`.
  - `ParseOptions.allowManaged?`.
  - From the vault scopes: `STORE_VAULT_PREFIX = 'store:'`, `MANAGED_STORE_SCOPE = 'store:managed'` and `MANAGED_STORE_PASSWORD_KEY = 'APP_PASSWORD'`.

- [ ] **Step 1: Write the tests**

`src/main/store/storeConfig.managed.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseStoreConfig, storeSecretEnvNames } from './storeConfig.js';

const DESKTOP = { allowStaticSecrets: false, allowManaged: true, fileExists: () => false };

describe('the managed store form', () => {
  it('parses { kind: postgres, managed: true } with the poolMax default', () => {
    expect(parseStoreConfig({ kind: 'postgres', managed: true }, DESKTOP)).toEqual({ kind: 'managed', poolMax: 4 });
    expect(parseStoreConfig({ kind: 'postgres', managed: true, poolMax: 8 }, DESKTOP)).toEqual({ kind: 'managed', poolMax: 8 });
  });

  it('refuses connection keys, a non-true managed, and use outside the desktop', () => {
    expect(() => parseStoreConfig({ kind: 'postgres', managed: true, host: 'h' }, DESKTOP)).toThrow(/unknown key "host"/);
    expect(() => parseStoreConfig({ kind: 'postgres', managed: false }, DESKTOP)).toThrow(/managed must be true/);
    expect(() => parseStoreConfig({ kind: 'postgres', managed: true }, { allowStaticSecrets: true })).toThrow(/managed is not allowed here/);
  });

  it('holds no env secret: only the libpq credential vars are stripped from local workspaces', () => {
    expect(storeSecretEnvNames({ kind: 'managed', poolMax: 4 })).toEqual(['PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGSSLKEY', 'PGSSLCERT']);
  });
});
```

`src/main/vaultScopes.store.test.ts`:

```ts
import { expect, it } from 'vitest';
import { assertNotReservedVaultScope, assertRendererVaultScope, assertRendererWorkspaceId, MANAGED_STORE_SCOPE, RESERVED_VAULT_PREFIXES } from './vaultScopes.js';

it('the store bag is reserved and host-only', () => {
  expect(MANAGED_STORE_SCOPE).toBe('store:managed');
  expect(RESERVED_VAULT_PREFIXES).toContain('store:');
  expect(() => assertRendererVaultScope(MANAGED_STORE_SCOPE)).toThrow(/host-only/);
  expect(() => assertNotReservedVaultScope(MANAGED_STORE_SCOPE)).toThrow(/reserved/);
  expect(() => assertRendererWorkspaceId('store:managed')).toThrow();
});
```

Run `npx vitest run src/main/store/storeConfig.managed.test.ts src/main/vaultScopes.store.test.ts`. Expected: FAIL (`kind: 'managed'` isn't parsed, and `MANAGED_STORE_SCOPE` doesn't exist).

- [ ] **Step 2: Apply the changes**

Save as `/tmp/p4b_t1.py` and run `python3 /tmp/p4b_t1.py` from `$WT`. Two parts need a word:
- `storeSecretEnvNames` narrows on `kind === 'postgres'`, because a managed config has no `connection`.
- Until Task 4 starts the container, a managed choice stops the launch through the existing Quit-only dialog. It never falls back to SQLite.

```python
"""Part 4b Task 1: the managed store form, its vault scope, the host refusal. Run from the worktree root."""


def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected one {old[:70]!r}, found {s.count(old)}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


edit('src/main/store/storeConfig.ts', [
    ("""export type StoreConfig = { kind: 'sqlite' } | PostgresStoreConfig;""",
     """/** config.json `{ kind: 'postgres', managed: true }`: the app-managed container (managedPostgres.ts). */
export interface ManagedStoreConfig {
  kind: 'managed';
  poolMax: number;
}

export type StoreConfig = { kind: 'sqlite' } | PostgresStoreConfig | ManagedStoreConfig;"""),
    ("""  allowStaticSecrets: boolean;
  fileExists?: (path: string) => boolean;""", """  allowStaticSecrets: boolean;
  /** The desktop only: fleet-host has no Docker to manage a container with. */
  allowManaged?: boolean;
  fileExists?: (path: string) => boolean;"""),
    ("""  if (v.kind !== 'postgres') return fail('kind must be "sqlite" or "postgres"');
  const schema""", """  if (v.kind !== 'postgres') return fail('kind must be "sqlite" or "postgres"');
  if (v.managed !== undefined) {
    if (v.managed !== true) fail('managed must be true');
    if (!opts.allowManaged) fail('managed is not allowed here');
    onlyKeys(v, ['kind', 'managed', 'poolMax']);
    return { kind: 'managed', poolMax: parsePoolMax(v) };
  }
  const schema"""),
    ("""  const poolMax = v.poolMax === undefined ? 4 : v.poolMax;
  if (typeof poolMax !== 'number' || !Number.isInteger(poolMax) || poolMax < 1 || poolMax > 32) fail('poolMax must be an integer 1-32');
  return { kind: 'postgres', connection: parseConnection(v, opts), schema, poolMax: poolMax as number };
}""", """  return { kind: 'postgres', connection: parseConnection(v, opts), schema, poolMax: parsePoolMax(v) };
}

function parsePoolMax(v: Obj): number {
  const poolMax = v.poolMax === undefined ? 4 : v.poolMax;
  if (typeof poolMax !== 'number' || !Number.isInteger(poolMax) || poolMax < 1 || poolMax > 32) fail('poolMax must be an integer 1-32');
  return poolMax as number;
}"""),
    ("""  if (cfg?.kind === 'sqlite') return [];
  const c = cfg?.connection;""", """  if (cfg?.kind === 'sqlite') return [];
  const c = cfg?.kind === 'postgres' ? cfg.connection : undefined;"""),
])

edit('src/main/config.ts', [
    ("""  return parseStoreConfig(cfg.store, { allowStaticSecrets: false });""",
     """  return parseStoreConfig(cfg.store, { allowStaticSecrets: false, allowManaged: true });"""),
])

edit('src/main/vaultScopes.ts', [
    ("""/** The GitHub sign-in bag: keys TOKEN (OAuth token) and PROFILE (JSON). */
export const GITHUB_IDENTITY_SCOPE = `${IDENTITY_VAULT_PREFIX}github`;""",
     """/** The GitHub sign-in bag: keys TOKEN (OAuth token) and PROFILE (JSON). */
export const GITHUB_IDENTITY_SCOPE = `${IDENTITY_VAULT_PREFIX}github`;
/** Scope prefix of the store's own credentials. Host-only. */
export const STORE_VAULT_PREFIX = 'store:';
/** The managed Postgres container's bag: key APP_PASSWORD (the fleet_app role's password). */
export const MANAGED_STORE_SCOPE = `${STORE_VAULT_PREFIX}managed`;
export const MANAGED_STORE_PASSWORD_KEY = 'APP_PASSWORD';"""),
    ("""export const RESERVED_VAULT_PREFIXES: readonly string[] = [SOURCE_VAULT_PREFIX, ENDPOINT_VAULT_PREFIX, IDENTITY_VAULT_PREFIX];""",
     """export const RESERVED_VAULT_PREFIXES: readonly string[] = [SOURCE_VAULT_PREFIX, ENDPOINT_VAULT_PREFIX, IDENTITY_VAULT_PREFIX, STORE_VAULT_PREFIX];"""),
    ("""const HOST_ONLY_PREFIXES: readonly string[] = [SOURCE_VAULT_PREFIX, IDENTITY_VAULT_PREFIX];""",
     """const HOST_ONLY_PREFIXES: readonly string[] = [SOURCE_VAULT_PREFIX, IDENTITY_VAULT_PREFIX, STORE_VAULT_PREFIX];"""),
])
edit('src/main/vaultScopes.test.ts', [
    ("expect(RESERVED_VAULT_PREFIXES).toEqual(['loadout-source:', 'endpoint:', 'identity:']);",
     "expect(RESERVED_VAULT_PREFIXES).toEqual(['loadout-source:', 'endpoint:', 'identity:', 'store:']);"),
])

# Until Task 4 starts the container, a managed choice stops the launch rather than falling back to SQLite.
edit('src/main/index.ts', [
    ("    const storeCfg = await getStoreConfig();\n",
     "    const storeCfg = await getStoreConfig();\n    if (storeCfg.kind === 'managed') throw new Error('store: the managed Postgres store needs a newer build');\n"),
])
print('ok')
```

- [ ] **Step 3: Run and commit**

```bash
npx tsc --noEmit -p tsconfig.node.json && npm run typecheck:host
npx vitest run src/main/store/storeConfig.managed.test.ts src/main/vaultScopes.store.test.ts src/main/store/storeConfig.test.ts src/main/vaultScopes.test.ts
git -C "$WT" add src/main/store/storeConfig.ts src/main/config.ts src/main/vaultScopes.ts src/main/vaultScopes.test.ts src/main/index.ts src/main/store/storeConfig.managed.test.ts src/main/vaultScopes.store.test.ts
git -C "$WT" commit -m "feat(store): the managed Postgres store choice and its host-only vault scope

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: PASS. `fleet-host`'s `db:` refuses `managed` because `allowManaged` defaults to false.

---

### Task 2: The managed container

**Files:**
- Create: `src/main/store/managedPostgres.ts`, `src/main/store/managedDocker.ts`, `src/main/store/managedPostgres.test.ts`, `src/main/store/managedPostgres.pg.test.ts`
- Modify: `vitest.pg.config.ts`

**Interfaces:**
- Consumes: `scramVerifier` (4a), `PostgresStoreConfig`, `pullErrorFromEvent` (`imagePull.ts`).
- Produces:
  - `ensureManagedPostgres(deps: ManagedDeps, poolMax): Promise<PostgresStoreConfig>` and `stopManagedPostgres(docker)`.
  - `bootstrapSql({ user, schema, verifier })`, `freeLoopbackPort()` and `dockerodeManagedDocker(docker?): ManagedDocker`.
  - `ManagedPgError` with `reason: 'docker-down' | 'volume' | 'not-ready' | 'bootstrap'`.
  - The constants `MANAGED_PG_IMAGE`, `MANAGED_PG_CONTAINER`, `MANAGED_PG_VOLUME`, `STORE_LABEL` and `STORE_MAJOR_LABEL`.

- [ ] **Step 1: Write the unit test (a fake Docker) `src/main/store/managedPostgres.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  bootstrapSql, ensureManagedPostgres, ManagedPgError, MANAGED_PG_CONTAINER, MANAGED_PG_IMAGE, MANAGED_PG_VOLUME,
  STORE_LABEL, STORE_MAJOR_LABEL, stopManagedPostgres, type ManagedContainer, type ManagedContainerSpec, type ManagedDocker,
} from './managedPostgres.js';

class FakeDocker implements ManagedDocker {
  up = true;
  images = new Set<string>();
  volumes = new Map<string, Record<string, string>>();
  container: (ManagedContainer & { spec?: ManagedContainerSpec }) | null = null;
  calls: string[] = [];
  readyAfter = 0;
  execs: Array<{ cmd: string[]; env?: string[] }> = [];
  bootstrapExit = 0;
  async ping() { return this.up; }
  async hasImage(ref: string) { return this.images.has(ref); }
  async pull(ref: string) { this.calls.push(`pull ${ref}`); this.images.add(ref); }
  async inspectVolume(name: string) { const l = this.volumes.get(name); return l ? { labels: l } : null; }
  async createVolume(name: string, labels: Record<string, string>) { this.calls.push(`volume ${name}`); this.volumes.set(name, labels); }
  async inspectContainer() { return this.container ? { running: this.container.running, image: this.container.image, hostPort: this.container.hostPort } : null; }
  async createContainer(spec: ManagedContainerSpec) { this.calls.push(`create ${spec.hostPort}`); this.container = { running: false, image: spec.image, hostPort: spec.hostPort, spec }; }
  async start() { this.calls.push('start'); this.container!.running = true; }
  async stop() { this.calls.push('stop'); this.container!.running = false; }
  async remove() { this.calls.push('remove'); this.container = null; }
  async exec(_name: string, cmd: string[], env?: string[]) {
    this.execs.push({ cmd, env });
    if (cmd[0] === 'pg_isready') return { exitCode: this.readyAfter-- > 0 ? 2 : 0, output: '' };
    return { exitCode: this.bootstrapExit, output: this.bootstrapExit ? `ERROR: at ALTER ROLE fleet_app PASSWORD '${(env?.[0] ?? '').match(/SCRAM-SHA-256\$[^']+/)?.[0]}'` : '' };
  }
}

function deps(docker: FakeDocker, stored: { v: string | null } = { v: null }) {
  return {
    docker,
    password: { get: async () => stored.v, set: async (v: string) => { stored.v = v; } },
    sleep: async () => undefined,
    freePort: async () => 54321,
    readyTimeoutMs: 1_000,
  };
}

describe('ensureManagedPostgres', () => {
  it('first run: pulls, creates the volume and a loopback container, waits, bootstraps, returns the loopback config', async () => {
    const docker = new FakeDocker();
    docker.readyAfter = 2;
    const stored = { v: null as string | null };
    const cfg = await ensureManagedPostgres(deps(docker, stored), 4);
    expect(docker.calls).toEqual([`pull ${MANAGED_PG_IMAGE}`, `volume ${MANAGED_PG_VOLUME}`, 'create 54321', 'start']);
    expect(docker.volumes.get(MANAGED_PG_VOLUME)).toEqual({ [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '16' });
    expect(docker.container!.spec!.labels).toEqual({ [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '16' });
    expect(docker.container!.spec!.labels['com.claude-fleet.managed']).toBeUndefined();
    expect(docker.container!.spec!.env).toEqual(expect.arrayContaining(['POSTGRES_DB=fleet', 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8']));
    expect(docker.execs.filter((e) => e.cmd[0] === 'pg_isready').length).toBe(3);
    expect(docker.execs.find((e) => e.cmd[0] === 'pg_isready')!.cmd).toContain('127.0.0.1');
    expect(stored.v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cfg).toEqual({
      kind: 'postgres', schema: 'fleet', poolMax: 4,
      connection: { host: '127.0.0.1', port: 54321, database: 'fleet', user: 'fleet_app', password: { kind: 'static', value: stored.v }, ssl: 'disable' },
    });
  });

  it('the password never reaches an exec argument or the SQL: only its SCRAM verifier does', async () => {
    const docker = new FakeDocker();
    const stored = { v: 'vault-held-secret-value' };
    await ensureManagedPostgres(deps(docker, stored), 4);
    const boot = docker.execs.find((e) => e.cmd[0] === 'sh')!;
    expect(JSON.stringify(boot)).not.toContain('vault-held-secret-value');
    expect(boot.env![0]).toMatch(/^FLEET_PG_SQL=.*PASSWORD 'SCRAM-SHA-256\$4096:/s);
    expect(boot.env![0]).toContain('ALTER ROLE postgres PASSWORD NULL;');
  });

  it('a later start reuses the container, its port and the stored password', async () => {
    const docker = new FakeDocker();
    docker.images.add(MANAGED_PG_IMAGE);
    docker.volumes.set(MANAGED_PG_VOLUME, { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '16' });
    docker.container = { running: false, image: MANAGED_PG_IMAGE, hostPort: 40000 };
    const cfg = await ensureManagedPostgres(deps(docker, { v: 'kept' }), 4);
    expect(docker.calls).toEqual(['start']);
    expect(cfg.connection).toMatchObject({ port: 40000, password: { kind: 'static', value: 'kept' } });
  });

  it('a new pinned image recreates the container on the same volume and port', async () => {
    const docker = new FakeDocker();
    docker.images.add(MANAGED_PG_IMAGE);
    docker.volumes.set(MANAGED_PG_VOLUME, { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '16' });
    docker.container = { running: true, image: 'pgvector/pgvector:0.8.0-pg16@sha256:old', hostPort: 40000 };
    await ensureManagedPostgres(deps(docker), 4);
    expect(docker.calls).toEqual(['stop', 'remove', 'create 40000', 'start']);
    expect(docker.container!.spec!.volume).toBe(MANAGED_PG_VOLUME);
  });

  it('refuses a volume of another major or not ours, and Docker being down', async () => {
    const other = new FakeDocker();
    other.volumes.set(MANAGED_PG_VOLUME, { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '17' });
    await expect(ensureManagedPostgres(deps(other), 4)).rejects.toThrow(/holds Postgres 17 data/);
    const foreign = new FakeDocker();
    foreign.volumes.set(MANAGED_PG_VOLUME, {});
    await expect(ensureManagedPostgres(deps(foreign), 4)).rejects.toThrow(/wasn't created by claude-fleet/);
    const down = new FakeDocker();
    down.up = false;
    const e = await ensureManagedPostgres(deps(down), 4).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ManagedPgError);
    expect((e as ManagedPgError).reason).toBe('docker-down');
    expect(other.container).toBeNull();
  });

  it('gives up when Postgres never becomes ready, and redacts the verifier from a bootstrap error', async () => {
    const slow = new FakeDocker();
    slow.readyAfter = Number.POSITIVE_INFINITY;
    await expect(ensureManagedPostgres({ ...deps(slow), readyTimeoutMs: 0 }, 4)).rejects.toThrow(/did not become ready/);
    const bad = new FakeDocker();
    bad.bootstrapExit = 3;
    const e = (await ensureManagedPostgres(deps(bad), 4).catch((x: unknown) => x)) as Error;
    expect(e.message).toMatch(/bootstrap failed/);
    expect(e.message).not.toMatch(/SCRAM-SHA-256\$/);
  });

  it('stopManagedPostgres stops a running container only', async () => {
    const docker = new FakeDocker();
    await stopManagedPostgres(docker);
    docker.container = { running: true, image: MANAGED_PG_IMAGE, hostPort: 1 };
    await stopManagedPostgres(docker);
    expect(docker.calls).toEqual(['stop']);
    expect(MANAGED_PG_CONTAINER).toBe('claude-fleet-postgres');
  });
});

describe('bootstrapSql', () => {
  it('creates the role with CREATEROLE, the schema it owns, and pgvector; it is idempotent text', () => {
    const s = bootstrapSql({ user: 'fleet_app', schema: 'fleet', verifier: 'SCRAM-SHA-256$4096:x$y:z' });
    expect(s).toContain("ALTER ROLE fleet_app LOGIN CREATEROLE PASSWORD 'SCRAM-SHA-256$4096:x$y:z';");
    expect(s).toContain('CREATE SCHEMA IF NOT EXISTS fleet AUTHORIZATION fleet_app;');
    expect(s).toContain('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;');
  });
});
```

- [ ] **Step 2: Write the bootstrap test on a real server `src/main/store/managedPostgres.pg.test.ts`**

It runs the bootstrap as the superuser under per-test names, as the container's socket would. It skips `ALTER ROLE postgres PASSWORD NULL`, which `ensureManagedPostgres` appends: CI's server logs in as `postgres` with a password.

```ts
// The bootstrap SQL against a real server (as the superuser, like the
// container's local socket), under per-test names: the store then opens as
// the bootstrapped role, and MCP isolation can provision.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as db from '../db.js';
import { bootstrapSql } from './managedPostgres.js';
import { isolationBlocker, rolePoolConfig } from './pgQueryIsolation.js';
import { createPgPool } from './postgres.js';
import { scramVerifier } from './scram.js';
import { isPg, testPgSchema } from './testStore.js';

describe.skipIf(!isPg)('bootstrapSql on Postgres', () => {
  it('runs twice cleanly; the role owns the schema, has CREATEROLE, and the store opens as it', async () => {
    const t = await testPgSchema();
    const schema = `${t.schema}_m`;
    const user = `${t.schema}_app`;
    const password = randomBytes(24).toString('base64url');
    const sqlText = bootstrapSql({ user, schema, verifier: scramVerifier(password) });
    try {
      await t.pool.query(sqlText);
      await t.pool.query(sqlText);
      const { types: _t, max: _m, idleTimeoutMillis: _i, ...conn } = rolePoolConfig({ connectionString: process.env.PG_TEST_URL, schema }, user, password);
      const pool = createPgPool({ ...conn, schema, max: 2 });
      try {
        await db.openDbPostgres(pool);
        const k = db.stateKysely();
        expect(await isolationBlocker(k, schema)).toBeNull();
        const owner = await pool.query<{ o: string }>('SELECT nspowner::regrole::text AS o FROM pg_namespace WHERE nspname = $1', [schema]);
        expect(owner.rows[0].o).toBe(user);
      } finally {
        await db.closeDb();
        await pool.end();
      }
    } finally {
      await t.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await t.pool.query(`DROP OWNED BY ${user}`).catch(() => undefined);
      await t.pool.query(`DROP ROLE IF EXISTS ${user}`);
      await t.drop();
    }
  });
});
```

```bash
python3 /tmp/p4b_suite.py src/main/store/managedPostgres.pg.test.ts
npx vitest run src/main/store/managedPostgres.test.ts                                  # FAIL: no module
STORE_TEST_DIALECT=postgres npx vitest run src/main/store/managedPostgres.pg.test.ts     # FAIL: no module
```

- [ ] **Step 3: Write `src/main/store/managedPostgres.ts`**

```ts
// The app-managed local Postgres (remote-workspaces spec §7): a pinned
// pgvector image in a labelled container on a named volume, published on a
// loopback port. Docker access is injected (managedDocker.ts), so this file
// runs in unit tests without a daemon.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { scramVerifier } from './scram.js';
import type { PostgresStoreConfig } from './storeConfig.js';

/** Pinned by digest: a new image (a pgvector or PG minor bump) arrives only with an app release. */
export const MANAGED_PG_IMAGE =
  'pgvector/pgvector:0.8.7-pg16@sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f';
/** The data directory's major version. A different major needs pg_upgrade, which the app doesn't run. */
export const MANAGED_PG_MAJOR = '16';
export const MANAGED_PG_CONTAINER = 'claude-fleet-postgres';
export const MANAGED_PG_VOLUME = 'claude-fleet-postgres-data';
/** Not com.claude-fleet.managed: that label marks workspace containers (docker.ts listLiveWorkspaces). */
export const STORE_LABEL = 'com.claude-fleet.store';
export const STORE_MAJOR_LABEL = 'com.claude-fleet.store.pg-major';
export const MANAGED_DATABASE = 'fleet';
export const MANAGED_USER = 'fleet_app';
export const MANAGED_SCHEMA = 'fleet';

export interface ManagedContainer {
  running: boolean;
  /** The image reference the container was created from. */
  image: string;
  hostPort: number | null;
}

export interface ManagedContainerSpec {
  name: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  volume: string;
  hostPort: number;
}

export interface ManagedDocker {
  ping(): Promise<boolean>;
  hasImage(ref: string): Promise<boolean>;
  pull(ref: string, onProgress: (message: string) => void): Promise<void>;
  inspectVolume(name: string): Promise<{ labels: Record<string, string> } | null>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  inspectContainer(name: string): Promise<ManagedContainer | null>;
  createContainer(spec: ManagedContainerSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string, timeoutS: number): Promise<void>;
  remove(name: string): Promise<void>;
  /** Exit code and combined output; `env` is set on this exec only. */
  exec(name: string, cmd: string[], env?: string[]): Promise<{ exitCode: number; output: string }>;
}

export type ManagedPgFailure = 'docker-down' | 'volume' | 'not-ready' | 'bootstrap';

export class ManagedPgError extends Error {
  constructor(readonly reason: ManagedPgFailure, message: string) { super(message); }
}

export interface ManagedDeps {
  docker: ManagedDocker;
  /** The fleet_app password in the vault (`store:managed` / APP_PASSWORD). */
  password: { get(): Promise<string | null>; set(value: string): Promise<void> };
  onProgress?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  freePort?: () => Promise<number>;
  readyTimeoutMs?: number;
}

/** Idempotent bootstrap, run as the superuser over the container's own socket
 *  (local trust, the image's default). The password arrives as a SCRAM
 *  verifier, so the plaintext is never in an exec argument or a server log. */
export function bootstrapSql(o: { user: string; schema: string; verifier: string }): string {
  return `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${o.user}') THEN CREATE ROLE ${o.user} LOGIN; END IF;
END $$;
ALTER ROLE ${o.user} LOGIN CREATEROLE PASSWORD '${o.verifier}';
CREATE SCHEMA IF NOT EXISTS ${o.schema} AUTHORIZATION ${o.user};
ALTER SCHEMA ${o.schema} OWNER TO ${o.user};
CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;
ALTER EXTENSION vector UPDATE;
`;
}

/** Nothing logs in as the superuser over TCP: it has no password. */
const LOCK_SUPERUSER = 'ALTER ROLE postgres PASSWORD NULL;\n';

const redactVerifier = (s: string): string => s.replace(/SCRAM-SHA-256\$[^'\s]+/g, '[verifier]');

export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

function containerSpec(hostPort: number): ManagedContainerSpec {
  return {
    name: MANAGED_PG_CONTAINER,
    image: MANAGED_PG_IMAGE,
    // The image requires a superuser password at initdb; bootstrap nulls it.
    env: [
      `POSTGRES_PASSWORD=${randomBytes(24).toString('base64url')}`,
      `POSTGRES_DB=${MANAGED_DATABASE}`,
      'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8',
    ],
    labels: { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: MANAGED_PG_MAJOR },
    volume: MANAGED_PG_VOLUME,
    hostPort,
  };
}

/** Start (creating on first use) the managed container and return the store
 *  config that reaches it. Safe to call again at any time. */
export async function ensureManagedPostgres(d: ManagedDeps, poolMax: number): Promise<PostgresStoreConfig> {
  const progress = d.onProgress ?? (() => undefined);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const docker = d.docker;
  if (!(await docker.ping())) throw new ManagedPgError('docker-down', 'Docker is not running: the managed Postgres store needs it');

  if (!(await docker.hasImage(MANAGED_PG_IMAGE))) {
    progress('Pulling the Postgres image…');
    await docker.pull(MANAGED_PG_IMAGE, progress);
  }

  const vol = await docker.inspectVolume(MANAGED_PG_VOLUME);
  if (!vol) {
    await docker.createVolume(MANAGED_PG_VOLUME, { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: MANAGED_PG_MAJOR });
  } else if (vol.labels[STORE_LABEL] !== 'postgres') {
    throw new ManagedPgError('volume', `the Docker volume ${MANAGED_PG_VOLUME} exists but wasn't created by claude-fleet`);
  } else if (vol.labels[STORE_MAJOR_LABEL] !== MANAGED_PG_MAJOR) {
    throw new ManagedPgError('volume', `the volume ${MANAGED_PG_VOLUME} holds Postgres ${vol.labels[STORE_MAJOR_LABEL] ?? '?'} data; this build runs Postgres ${MANAGED_PG_MAJOR}`);
  }

  let c = await docker.inspectContainer(MANAGED_PG_CONTAINER);
  let port = c?.hostPort ?? null;
  if (c && c.image !== MANAGED_PG_IMAGE) {
    // A new pinned image: recreate on the same volume and port.
    progress('Updating the Postgres container…');
    if (c.running) await docker.stop(MANAGED_PG_CONTAINER, 30);
    await docker.remove(MANAGED_PG_CONTAINER);
    c = null;
  }
  if (!c) {
    port ??= await (d.freePort ?? freeLoopbackPort)();
    await docker.createContainer(containerSpec(port));
    c = { running: false, image: MANAGED_PG_IMAGE, hostPort: port };
  }
  if (!c.running) await docker.start(MANAGED_PG_CONTAINER);
  if (port === null) throw new ManagedPgError('not-ready', 'the Postgres container publishes no host port');

  // TCP, not the socket: during initdb the entrypoint's temporary server
  // listens on the socket only, and it stops before the real one starts.
  const deadline = Date.now() + (d.readyTimeoutMs ?? 90_000);
  progress('Starting Postgres…');
  for (;;) {
    const r = await docker.exec(MANAGED_PG_CONTAINER, ['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', MANAGED_DATABASE]);
    if (r.exitCode === 0) break;
    if (Date.now() >= deadline) throw new ManagedPgError('not-ready', 'Postgres did not become ready in time');
    await sleep(1000);
  }

  let password = await d.password.get();
  if (!password) {
    password = randomBytes(32).toString('base64url');
    await d.password.set(password);
  }
  const sqlText = bootstrapSql({ user: MANAGED_USER, schema: MANAGED_SCHEMA, verifier: scramVerifier(password) }) + LOCK_SUPERUSER;
  const boot = await docker.exec(
    MANAGED_PG_CONTAINER,
    ['sh', '-c', `printf '%s' "$FLEET_PG_SQL" | psql -v ON_ERROR_STOP=1 -X -q -U postgres -d ${MANAGED_DATABASE} -f -`],
    [`FLEET_PG_SQL=${sqlText}`],
  );
  if (boot.exitCode !== 0) throw new ManagedPgError('bootstrap', `Postgres bootstrap failed: ${redactVerifier(boot.output).slice(0, 500)}`);

  return {
    kind: 'postgres',
    connection: { host: '127.0.0.1', port, database: MANAGED_DATABASE, user: MANAGED_USER, password: { kind: 'static', value: password }, ssl: 'disable' },
    schema: MANAGED_SCHEMA,
    poolMax,
  };
}

/** Best effort at quit: Postgres's WAL makes an unclean stop safe. */
export async function stopManagedPostgres(docker: ManagedDocker): Promise<void> {
  const c = await docker.inspectContainer(MANAGED_PG_CONTAINER).catch(() => null);
  if (c?.running) await docker.stop(MANAGED_PG_CONTAINER, 10);
}
```

- [ ] **Step 4: Write `src/main/store/managedDocker.ts`**

`PortBindings` pins the host port. Docker keeps an explicit `HostPort` across restarts, which an ephemeral binding wouldn't.

```ts
// dockerode behind managedPostgres.ts's ManagedDocker.
import Docker from 'dockerode';
import { Writable } from 'node:stream';
import { pullErrorFromEvent } from '../imagePull.js';
import type { ManagedContainer, ManagedContainerSpec, ManagedDocker } from './managedPostgres.js';

const PG_PORT = '5432/tcp';

const notFound = (e: unknown): boolean => (e as { statusCode?: number }).statusCode === 404;

export function dockerodeManagedDocker(docker: Docker = new Docker()): ManagedDocker {
  return {
    async ping() {
      try { await docker.ping(); return true; } catch { return false; }
    },
    async hasImage(ref) {
      try { await docker.getImage(ref).inspect(); return true; } catch (e) { if (notFound(e)) return false; throw e; }
    },
    async pull(ref, onProgress) {
      const stream = (await docker.pull(ref)) as NodeJS.ReadableStream;
      await new Promise<void>((resolve, reject) => {
        // A failed pull is an in-stream error line on a cleanly ending stream (imagePull.ts).
        let streamError: string | null = null;
        docker.modem.followProgress(
          stream,
          (err: Error | null) => (err ? reject(err) : streamError ? reject(new Error(streamError)) : resolve()),
          (event: Record<string, unknown>) => {
            const err = pullErrorFromEvent(event);
            if (err) { streamError ??= err; return; }
            if (typeof event.status === 'string') onProgress(event.status);
          },
        );
      });
    },
    async inspectVolume(name) {
      try {
        const v = await docker.getVolume(name).inspect();
        return { labels: (v.Labels ?? {}) as Record<string, string> };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async createVolume(name, labels) {
      await docker.createVolume({ Name: name, Labels: labels });
    },
    async inspectContainer(name): Promise<ManagedContainer | null> {
      try {
        const info = await docker.getContainer(name).inspect();
        const binding = info.HostConfig?.PortBindings?.[PG_PORT]?.[0]?.HostPort;
        return { running: info.State.Running, image: info.Config.Image, hostPort: binding ? Number(binding) : null };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async createContainer(spec: ManagedContainerSpec) {
      await docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Env: spec.env,
        Labels: spec.labels,
        ExposedPorts: { [PG_PORT]: {} },
        Healthcheck: {
          Test: ['CMD', 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
          Interval: 5e9, Timeout: 3e9, Retries: 5, StartPeriod: 30e9,
        },
        HostConfig: {
          Mounts: [{ Type: 'volume', Source: spec.volume, Target: '/var/lib/postgresql/data' }],
          // A fixed host port, so the store pool's address survives a container restart.
          PortBindings: { [PG_PORT]: [{ HostIp: '127.0.0.1', HostPort: String(spec.hostPort) }] },
          RestartPolicy: { Name: 'no' },
        },
      });
    },
    async start(name) {
      await docker.getContainer(name).start();
    },
    async stop(name, timeoutS) {
      try {
        await docker.getContainer(name).stop({ t: timeoutS });
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode !== 304) throw e;
      }
    },
    async remove(name) {
      await docker.getContainer(name).remove();
    },
    async exec(name, cmd, env) {
      const container = docker.getContainer(name);
      const exec = await container.exec({ Cmd: cmd, Env: env, AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({ hijack: true, stdin: false });
      let output = '';
      await new Promise<void>((resolve, reject) => {
        const sink = new Writable({ write(chunk, _enc, cb) { if (output.length < 100_000) output += chunk.toString('utf8'); cb(); } });
        container.modem.demuxStream(stream, sink, sink);
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      const info = await exec.inspect();
      return { exitCode: info.ExitCode ?? -1, output };
    },
  };
}
```

- [ ] **Step 5: Run and commit**

```bash
npx tsc --noEmit -p tsconfig.node.json
npx vitest run src/main/store/managedPostgres.test.ts
STORE_TEST_DIALECT=postgres npx vitest run src/main/store/managedPostgres.pg.test.ts
git -C "$WT" add src/main/store/managedPostgres.ts src/main/store/managedDocker.ts src/main/store/managedPostgres.test.ts src/main/store/managedPostgres.pg.test.ts vitest.pg.config.ts
git -C "$WT" commit -m "feat(store): the app-managed pgvector container (pinned image, loopback port, exec bootstrap)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: 8/8 unit, 1/1 on Postgres.

---

### Task 3: The first-switch copy

**Files:**
- Create: `src/preload/storeTypes.ts`, `src/main/store/storeImport.ts`, `src/main/store/storeImport.test.ts`, `src/main/store/firstSwitch.ts`, `src/main/store/firstSwitch.test.ts`
- Modify: `vitest.pg.config.ts`

**Interfaces:**
- Consumes: `decodeVector`, `PgTrack`, `postgresKysely`, `INBOX_SCHEMA_VERSION` and `STATE_PG_TRACK`.
- Produces:
  - `IMPORT_PG_TRACK` (track `import`) and `IMPORT_TABLES`.
  - `importSqlite(o: ImportOptions): Promise<ImportOutcome>`, where the status is `'copied' | 'already' | 'absent' | 'skipped-nonempty'`, plus `sourceFingerprint(file)` and `ImportError`.
  - `firstSwitchCopy({ pool, userData, state, onProgress, now? }): Promise<string | null>` and `retireSqliteFile(file, now)`.
  - From the preload types: `StoreChoice`, `StorePhase`, `ImportProgress`, `StoreStatus` and `StoreSettings`.

- [ ] **Step 1: Write `src/preload/storeTypes.ts`** (shared with Tasks 4–5)

```ts
// The store choice and status (Settings → Storage, the store banner). Shared
// by main (type-only) and the renderer.

export type StoreChoice = 'sqlite' | 'managed' | 'external';
export type StorePhase = 'ready' | 'starting' | 'importing' | 'down';

export interface ImportProgress {
  source: 'inbox' | 'state';
  table: string;
  copied: number;
  total: number;
}

export interface StoreStatus {
  choice: StoreChoice;
  phase: StorePhase;
  /** Why the store is down (secret-free), or null. */
  detail: string | null;
  progress: ImportProgress | null;
  /** A one-off note from the first-switch copy (e.g. inbox.db not copied), or null. */
  notice: string | null;
}

export interface StoreSettings {
  /** What config.json names now. */
  configured: StoreChoice;
  /** What this run opened; differs from `configured` until a restart. */
  active: StoreChoice;
  restartRequired: boolean;
  status: StoreStatus;
}
```

- [ ] **Step 2: Write the copy test `src/main/store/storeImport.test.ts`**

The first two tests (fingerprint, table list) run on both dialects; the rest run on Postgres. `maxParamsPerChunk: 140` makes `events` (20 columns) copy in 7-row chunks, so a small fixture still has several chunks to fail between.

```ts
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../db.js';
import { InboxStore, INBOX_SCHEMA_VERSION } from '../inbox/inboxDb.js';
import { FIXTURE, S, WS } from '../state/ingestFixture.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from '../vectors.js';
import { INBOX_PG_BASELINE } from './migrations/inboxPg.js';
import { STATE_PG_BASELINE, STATE_PG_BASELINE_VERSION } from './migrations/statePg.js';
import { migratePostgres } from './pgMigrate.js';
import { postgresKysely, schemaOf } from './postgres.js';
import { IMPORT_PG_TRACK, IMPORT_TABLES, importSqlite, ImportError, sourceFingerprint, type ImportProgress } from './storeImport.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';

const tablesOf = (ddl: string): string[] => [...ddl.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]).sort();

it('a read-only open does not change the fingerprint; a write does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-fp-'));
  try {
    const f = join(dir, 'x.db');
    const w = new Database(f);
    w.pragma('journal_mode = WAL');
    w.exec('CREATE TABLE t (a)');
    w.close();
    const before = sourceFingerprint(f);
    const r = new Database(f, { readonly: true, fileMustExist: true });
    r.prepare('SELECT * FROM t').all();
    r.close();
    expect(sourceFingerprint(f)).toBe(before);
    const w2 = new Database(f);
    w2.prepare('INSERT INTO t VALUES (1)').run();
    expect(sourceFingerprint(f)).not.toBe(before);
    w2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('copies every table of both stores', () => {
  expect([...IMPORT_TABLES.state].sort()).toEqual(tablesOf(STATE_PG_BASELINE));
  expect([...IMPORT_TABLES.inbox].sort()).toEqual(tablesOf(INBOX_PG_BASELINE));
});

const vec = (i: number): Float32Array => { const v = new Float32Array(EMBED_DIM); v[i % EMBED_DIM] = 1; return v; };
const ME = { kind: 'user', id: 'me' } as const;

describe.skipIf(!isPg)('importSqlite into Postgres', () => {
  let dir: string;
  let t: TestPg;
  let k: Kysely<unknown>;
  let before: Awaited<ReturnType<typeof db.listSessions>>;
  let todoIds: string[];

  /** SQLite state.db + inbox.db in `dir`, the way a SQLite user leaves them. */
  async function seedSqlite(): Promise<void> {
    db.openDb(dir);
    await db.ingestBatch(WS, S, FIXTURE);
    await db.insertEmbeddings(Array.from({ length: 30 }, (_, i) => ({
      workspaceId: WS, sessionId: S, kind: 'turn' as const, refEventId: i + 1, ts: i, text: `t${i}`,
      modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(vec(i)), dedupKey: `d${i}`,
    })));
    await db.renameSession(S, 'renamed by the user');
    before = await db.listSessions();
    await db.closeDb();
    const inbox = InboxStore.open(dir);
    for (let i = 0; i < 25; i++) await inbox.post(ME, { title: `todo ${i}`, key: `k${i}` });
    todoIds = (await inbox.list({})).map((x) => x.id).sort();
    await inbox.close();
  }

  const opts = (source: 'state' | 'inbox', extra: Partial<Parameters<typeof importSqlite>[0]> = {}) => ({
    k, source,
    file: join(dir, source === 'state' ? 'state.db' : 'inbox.db'),
    expectedVersion: source === 'state' ? STATE_PG_BASELINE_VERSION : INBOX_SCHEMA_VERSION,
    maxParamsPerChunk: 140,
    ...extra,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-import-'));
    await seedSqlite();
    t = await testPgSchema();
    await db.openDbPostgres(t.pool);
    await InboxStore.openPostgres(t.pool).then((s) => s.close());
    k = postgresKysely<unknown>(t.pool);
    await migratePostgres(k, schemaOf(t.pool), IMPORT_PG_TRACK);
  });
  afterEach(async () => {
    await k.destroy();
    await db.closeDb();
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies both stores with their ids; reads match SQLite; new rows get fresh ids', async () => {
    const inboxOut = await importSqlite(opts('inbox'));
    const stateOut = await importSqlite(opts('state'));
    expect(inboxOut.status).toBe('copied');
    expect(stateOut).toMatchObject({ status: 'copied', counts: { embeddings: 30 } });
    // db.ts opened before the copy: reopen, as the supervisor opens it after.
    await db.closeDb();
    await db.openDbPostgres(t.pool, { migrate: false });
    expect(await db.listSessions()).toEqual(before);
    expect((await db.ingestBatch(WS, S, FIXTURE)).filter((r) => r.inserted)).toEqual([]);
    expect(await db.listSessions()).toEqual(before);
    expect((await db.searchEmbeddings(vec(3), [WS], { limit: 1 })).map((h) => h.text)).toEqual(['t3']);
    await db.insertEmbeddings([{ workspaceId: WS, sessionId: S, kind: 'turn', refEventId: 99, ts: 1, text: 'new', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(vec(5)), dedupKey: 'new' }]);
    const inbox = await InboxStore.openPostgres(t.pool, { migrate: false });
    try {
      expect((await inbox.list({})).map((x) => x.id).sort()).toEqual(todoIds);
      const { todo } = await inbox.post(ME, { title: 'after the copy', key: 'after' });
      expect((await inbox.events(todo.id)).length).toBeGreaterThan(0);
    } finally {
      await inbox.close();
    }
  });

  it('resumes after a failure and ends equal to a straight copy', async () => {
    let chunks = 0;
    const failing = opts('state', { onProgress: () => { if (++chunks === 3) throw new Error('injected'); } });
    await expect(importSqlite(failing)).rejects.toThrow('injected');
    const seen: ImportProgress[] = [];
    const out = await importSqlite(opts('state', { onProgress: (p) => seen.push(p) }));
    expect(out.status).toBe('copied');
    const n = (await sql<{ n: number }>`SELECT count(*) AS n FROM events`.execute(k)).rows[0].n;
    const src = new Database(join(dir, 'state.db'), { readonly: true });
    expect(n).toBe((src.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n);
    src.close();
    // Resumed, not restarted: the table finished before the failure isn't copied again.
    expect(seen.some((p) => p.table === 'sessions')).toBe(false);
    expect(seen.at(-1)).toMatchObject({ source: 'state' });
    expect(await importSqlite(opts('state'))).toMatchObject({ status: 'already' });
  });

  it('a source changed between attempts restarts the copy from scratch', async () => {
    let chunks = 0;
    await expect(importSqlite(opts('state', { onProgress: () => { if (++chunks === 2) throw new Error('injected'); } }))).rejects.toThrow('injected');
    const w = new Database(join(dir, 'state.db'));
    w.prepare('UPDATE sessions SET user_set_name = ? WHERE id = ?').run('renamed again', S);
    w.close();
    await importSqlite(opts('state'));
    const row = (await sql<{ n: string }>`SELECT user_set_name AS n FROM sessions WHERE id = ${S}`.execute(k)).rows[0];
    expect(row.n).toBe('renamed again');
  });

  it('a row written by anything else during the copy fails it', async () => {
    const racing = opts('state', {
      onProgress: (p) => {
        // Raw SQL takes the store's write lock, so this lands before the count check.
        if (p.table === 'sessions') void sql`INSERT INTO sessions (id, workspace_id) VALUES ('intruder', 'W')`.execute(k);
      },
    });
    await expect(importSqlite(racing)).rejects.toThrow(/copying sessions: Postgres has 2 rows/);
  });

  it('leaves a store that already holds data untouched', async () => {
    await sql`INSERT INTO notify_state (k, v) VALUES ('pre-existing', '1')`.execute(k);
    expect(await importSqlite(opts('inbox'))).toMatchObject({ status: 'skipped-nonempty' });
    expect((await sql<{ n: number }>`SELECT count(*) AS n FROM todos`.execute(k)).rows[0].n).toBe(0);
  });

  it('reports a missing file and refuses another schema version', async () => {
    expect(await importSqlite({ ...opts('inbox'), file: join(dir, 'nope.db') })).toMatchObject({ status: 'absent' });
    await expect(importSqlite({ ...opts('inbox'), expectedVersion: INBOX_SCHEMA_VERSION + 1 })).rejects.toThrow(ImportError);
  });
});
```

- [ ] **Step 3: Write `src/main/store/storeImport.ts`**

```ts
// The first-switch copy (remote-workspaces spec §7, part 4b D49): inbox.db and
// state.db rows into an empty Postgres store, ids kept. Chunks commit with
// their progress row, so a failed or interrupted copy resumes; a source file
// that changed since restarts it. The SQLite files are only read.
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { decodeVector } from '../vectors.js';
import type { PgTrack } from './pgMigrate.js';
import type { ImportProgress } from '../../preload/storeTypes.js';

export const IMPORT_PG_TRACK: PgTrack = {
  track: 'import',
  baselineVersion: 1,
  baseline: `
CREATE TABLE store_import_run (
  source TEXT COLLATE "C" PRIMARY KEY,
  fingerprint TEXT COLLATE "C" NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  counts TEXT COLLATE "C"
);
CREATE TABLE store_import (
  source TEXT COLLATE "C" NOT NULL,
  tbl TEXT COLLATE "C" NOT NULL,
  last_rowid BIGINT NOT NULL,
  copied BIGINT NOT NULL,
  done BOOLEAN NOT NULL,
  PRIMARY KEY (source, tbl)
);
`,
  steps: [],
};

export type ImportSource = 'inbox' | 'state';

/** Every table of each store, in copy order. storeImport.test.ts pins these to the baselines. */
export const IMPORT_TABLES: Record<ImportSource, readonly string[]> = {
  inbox: ['todos', 'tags', 'todo_events', 'notifications', 'notification_rules', 'downtimes', 'notify_state',
    'automations', 'automation_versions', 'automation_state', 'runs', 'step_runs', 'proposals'],
  state: ['sessions', 'events', 'broker_sessions', 'errors', 'embeddings', 'session_summaries', 'session_tags',
    'usage_events', 'usage_anchors', 'perf_events', 'session_costs', 'session_stats', 'session_tool_counts'],
};

export type { ImportProgress };

export type ImportStatus =
  | 'copied'            // this run finished the copy
  | 'already'           // a previous run finished it
  | 'absent'            // no SQLite file
  | 'skipped-nonempty'; // Postgres already held data no import wrote

export interface ImportOutcome { source: ImportSource; status: ImportStatus; counts: Record<string, number> }

export interface ImportOptions {
  /** A handle on the store pool; nothing else may write the store until this returns. */
  k: Kysely<unknown>;
  file: string;
  source: ImportSource;
  /** The SQLite user_version this build migrates to (refuses an older or newer file). */
  expectedVersion: number;
  onProgress?: (p: ImportProgress) => void;
  now?: () => number;
  /** Bounded by Postgres's 65,535 bind parameters per statement. */
  maxParamsPerChunk?: number;
}

export class ImportError extends Error {}

/** Size and mtime of the file and its WAL: a write between attempts changes
 *  it. An empty WAL counts as none: opening the file read-only creates one. */
export function sourceFingerprint(file: string): string {
  const part = (p: string): string => {
    if (!existsSync(p)) return '-';
    const s = statSync(p);
    return s.size === 0 ? '-' : `${s.size}:${Math.trunc(s.mtimeMs)}`;
  };
  return `${part(file)}|${part(`${file}-wal`)}`;
}

export async function importSqlite(o: ImportOptions): Promise<ImportOutcome> {
  const now = o.now ?? Date.now;
  const tables = IMPORT_TABLES[o.source];
  if (!existsSync(o.file)) return { source: o.source, status: 'absent', counts: {} };

  const fingerprint = sourceFingerprint(o.file);
  const src = new Database(o.file, { readonly: true, fileMustExist: true });
  try {
    const v = src.pragma('user_version', { simple: true }) as number;
    if (v !== o.expectedVersion) {
      throw new ImportError(`${o.file} is at schema version ${v}; this build copies version ${o.expectedVersion}. Open it once on SQLite with this build first.`);
    }
    const run = (await sql<{ fingerprint: string; finished_at: number | null }>`
      SELECT fingerprint, finished_at FROM store_import_run WHERE source = ${o.source}`.execute(o.k)).rows[0];
    if (run?.finished_at != null) return { source: o.source, status: 'already', counts: {} };
    if (run && run.fingerprint !== fingerprint) {
      // The file changed since the last attempt: rows already copied may be stale. Only
      // this import ever wrote these tables (the store isn't used until it finishes).
      await o.k.transaction().execute(async (trx) => {
        await sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY`).execute(trx);
        await sql`DELETE FROM store_import WHERE source = ${o.source}`.execute(trx);
        await sql`UPDATE store_import_run SET fingerprint = ${fingerprint}, started_at = ${now()} WHERE source = ${o.source}`.execute(trx);
      });
    } else if (!run) {
      for (const t of tables) {
        const any = await sql<{ x: number }>`SELECT 1 AS x FROM ${sql.table(t)} LIMIT 1`.execute(o.k);
        if (any.rows.length > 0) return { source: o.source, status: 'skipped-nonempty', counts: {} };
      }
      await sql`INSERT INTO store_import_run (source, fingerprint, started_at) VALUES (${o.source}, ${fingerprint}, ${now()})`.execute(o.k);
    }

    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = await copyTable(o, src, t);
    await sql`UPDATE store_import_run SET finished_at = ${now()}, counts = ${JSON.stringify(counts)} WHERE source = ${o.source}`.execute(o.k);
    return { source: o.source, status: 'copied', counts };
  } finally {
    src.close();
  }
}

async function copyTable(o: ImportOptions, src: Database.Database, table: string): Promise<number> {
  const exists = src.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  const total = exists ? (src.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n : 0;
  const prog = (await sql<{ last_rowid: number; copied: number; done: boolean }>`
    SELECT last_rowid, copied, done FROM store_import WHERE source = ${o.source} AND tbl = ${table}`.execute(o.k)).rows[0];
  if (prog?.done) return total;
  const pgCols = (await sql<{ c: string; u: string; identity: string }>`
    SELECT column_name AS c, udt_name AS u, is_identity AS identity FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} ORDER BY ordinal_position`.execute(o.k)).rows;
  const sqliteCols = exists ? new Set((src.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)) : new Set<string>();
  const cols = pgCols.filter((c) => sqliteCols.has(c.c));
  const vectors = new Set(cols.filter((c) => c.u === 'vector').map((c) => c.c));
  const chunk = Math.max(1, Math.min(1000, Math.floor((o.maxParamsPerChunk ?? 30_000) / Math.max(1, cols.length))));
  let last = prog?.last_rowid ?? 0;
  let copied = prog?.copied ?? 0;
  if (exists && cols.length > 0) {
    const select = src.prepare(`SELECT rowid AS __rowid, ${cols.map((c) => `"${c.c}"`).join(', ')} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
    for (;;) {
      const rows = select.all(last, chunk) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      const values = rows.map(({ __rowid: _r, ...row }) => {
        for (const v of vectors) row[v] = `[${Array.from(decodeVector(row[v] as Buffer)).join(',')}]`;
        return row;
      });
      last = rows[rows.length - 1].__rowid as number;
      copied += rows.length;
      await o.k.transaction().execute(async (trx) => {
        await trx.insertInto(table as never).values(values as never).execute();
        await sql`INSERT INTO store_import (source, tbl, last_rowid, copied, done) VALUES (${o.source}, ${table}, ${last}, ${copied}, false)
                  ON CONFLICT (source, tbl) DO UPDATE SET last_rowid = EXCLUDED.last_rowid, copied = EXCLUDED.copied`.execute(trx);
      });
      o.onProgress?.({ source: o.source, table, copied, total });
    }
  }
  await o.k.transaction().execute(async (trx) => {
    const n = (await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(trx)).rows[0].n;
    if (n !== total) throw new ImportError(`copying ${table}: Postgres has ${n} rows, ${o.file} has ${total}`);
    // Explicit ids leave an identity's sequence behind: the next insert would collide.
    for (const c of pgCols.filter((x) => x.identity === 'YES')) {
      await sql`SELECT setval(pg_get_serial_sequence(${table}, ${c.c}), COALESCE((SELECT max(${sql.ref(c.c)}) FROM ${sql.table(table)}), 1), (SELECT count(*) > 0 FROM ${sql.table(table)}))`.execute(trx);
    }
    await sql`INSERT INTO store_import (source, tbl, last_rowid, copied, done) VALUES (${o.source}, ${table}, ${last}, ${copied}, true)
              ON CONFLICT (source, tbl) DO UPDATE SET done = true`.execute(trx);
  });
  return total;
}
```

- [ ] **Step 4: Run the copy suite, then mutation-check it**

```bash
python3 /tmp/p4b_suite.py src/main/store/storeImport.test.ts
npx vitest run src/main/store/storeImport.test.ts
STORE_TEST_DIALECT=postgres npx vitest run src/main/store/storeImport.test.ts
```

Expected: 2/2 on SQLite (the rest skip) and 8/8 on Postgres. Apply each mutation alone to `storeImport.ts`, run the Postgres line, confirm the named test fails, then `git -C "$WT" checkout src/main/store/storeImport.ts`:

| # | Mutation | Fails (measured) |
|---|---|---|
| S1 | `x.identity === 'NEVER'` in the `setval` loop | *copies both stores…* (`todo_events_pkey` duplicate) |
| S2 | `&& false` on the fingerprint check | *a source changed between attempts…* |
| S3 | `any.rows.length > 99` | *leaves a store that already holds data untouched* |
| S4 | `last_rowid = 0` in the chunk's `ON CONFLICT` update | *resumes after a failure…* |
| S5 | `s.size === -1` in `sourceFingerprint` | *a read-only open does not change the fingerprint*, *resumes…* |
| S6 | `&& false` on the count check | *a row written by anything else during the copy fails it* |

- [ ] **Step 5: Write `src/main/store/firstSwitch.test.ts` and `src/main/store/firstSwitch.ts`**

```ts
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { firstSwitchCopy, retireSqliteFile } from './firstSwitch.js';
import { migratePgStores } from './pgStores.js';
import { IMPORT_PG_TRACK } from './storeImport.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';

it('retireSqliteFile renames the file with its WAL and shm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-retire-'));
  try {
    for (const f of ['inbox.db', 'inbox.db-wal', 'inbox.db-shm']) writeFileSync(join(dir, f), 'x');
    expect(retireSqliteFile(join(dir, 'inbox.db'), 7)).toBe(join(dir, 'inbox.db.migrated-7'));
    expect(readdirSync(dir).sort()).toEqual(['inbox.db.migrated-7', 'inbox.db.migrated-7-shm', 'inbox.db.migrated-7-wal']);
    expect(retireSqliteFile(join(dir, 'inbox.db'), 8)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!isPg)('firstSwitchCopy', () => {
  let dir: string;
  let t: TestPg;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-switch-'));
    const inbox = InboxStore.open(dir);
    await inbox.post({ kind: 'user', id: 'me' }, { title: 'carry me over' });
    await inbox.close();
    db.openDb(dir);
    await db.closeDb();
    t = await testPgSchema();
    await migratePgStores(t.pool, { state: true, extraTracks: [IMPORT_PG_TRACK] });
  });
  afterEach(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies the inbox, retires inbox.db, keeps state.db; a second run is a no-op', async () => {
    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: () => undefined, now: () => 42 })).toBeNull();
    expect(existsSync(join(dir, 'inbox.db'))).toBe(false);
    expect(existsSync(join(dir, 'inbox.db.migrated-42'))).toBe(true);
    expect(existsSync(join(dir, 'state.db'))).toBe(true);
    const inbox = await InboxStore.openPostgres(t.pool, { migrate: false });
    expect((await inbox.list({})).map((x) => x.title)).toEqual(['carry me over']);
    await inbox.close();
    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: () => undefined })).toBeNull();
  });

  it('says so when the store already had inbox data, and leaves inbox.db in place', async () => {
    await t.pool.query(`INSERT INTO ${t.schema}.notify_state (k, v) VALUES ('x', '1')`);
    const note = await firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => undefined });
    expect(note).toMatch(/inbox.db was not copied/);
    expect(existsSync(join(dir, 'inbox.db'))).toBe(true);
  });
});
```

```ts
// The first-switch copy into a Postgres store (part 4b D49): inbox.db first
// (authoritative, small), then state.db. inbox.db is retired once copied so it
// can't be copied twice or mistaken for the live inbox; state.db stays, as the
// cache a switch back to SQLite resumes from.
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { INBOX_SCHEMA_VERSION } from '../inbox/inboxDb.js';
import { STATE_PG_TRACK } from './migrations/statePg.js';
import type { PgTrack } from './pgMigrate.js';
import { postgresKysely } from './postgres.js';
import { importSqlite, type ImportProgress } from './storeImport.js';

const latest = (t: PgTrack): number => Math.max(t.baselineVersion, ...t.steps.map((s) => s.version));

/** Renames the file with its -wal/-shm, so the pair stays readable. */
export function retireSqliteFile(file: string, now: number): string | null {
  if (!existsSync(file)) return null;
  const dest = `${file}.migrated-${now}`;
  renameSync(file, dest);
  for (const ext of ['-wal', '-shm']) if (existsSync(file + ext)) renameSync(file + ext, dest + ext);
  return dest;
}

export interface FirstSwitchOptions {
  pool: pg.Pool;
  userData: string;
  /** false in mock mode (no state.db), as for openPgStores. */
  state: boolean;
  onProgress: (p: ImportProgress) => void;
  now?: () => number;
}

/** A notice for Settings when something wasn't copied, else null. */
export async function firstSwitchCopy(o: FirstSwitchOptions): Promise<string | null> {
  const now = o.now ?? Date.now;
  const k = postgresKysely<unknown>(o.pool);
  const notes: string[] = [];
  try {
    const inboxFile = join(o.userData, 'inbox.db');
    const inbox = await importSqlite({ k, file: inboxFile, source: 'inbox', expectedVersion: INBOX_SCHEMA_VERSION, onProgress: o.onProgress, now });
    if (inbox.status === 'copied' || inbox.status === 'already') retireSqliteFile(inboxFile, now());
    if (inbox.status === 'skipped-nonempty') {
      notes.push(`inbox.db was not copied: the Postgres store already had inbox data. The file is unchanged at ${inboxFile}.`);
    }
    if (o.state) {
      const state = await importSqlite({
        k, file: join(o.userData, 'state.db'), source: 'state', expectedVersion: latest(STATE_PG_TRACK), onProgress: o.onProgress, now,
      });
      if (state.status === 'skipped-nonempty') notes.push('History was not copied: the Postgres store already had history.');
    }
  } finally {
    await k.destroy();
  }
  return notes.length ? notes.join(' ') : null;
}
```

```bash
python3 /tmp/p4b_suite.py src/main/store/firstSwitch.test.ts
npx vitest run src/main/store/firstSwitch.test.ts
STORE_TEST_DIALECT=postgres npx vitest run src/main/store/firstSwitch.test.ts
```

Expected: 1/1 on SQLite and 3/3 on Postgres.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit -p tsconfig.node.json
git -C "$WT" add src/preload/storeTypes.ts src/main/store/storeImport.ts src/main/store/storeImport.test.ts src/main/store/firstSwitch.ts src/main/store/firstSwitch.test.ts vitest.pg.config.ts
git -C "$WT" commit -m "feat(store): resumable first-switch copy of inbox.db and state.db into Postgres

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The supervisor and the boot restructure

**Files:**
- Create: `src/main/store/storeSupervisor.ts`, `src/main/store/storeSupervisor.test.ts`, `src/main/store/storeIpc.ts`, `src/main/jsonlWatcher.requeue.test.ts`
- Modify: `src/main/store/pgStores.ts` (`pingStore`), `src/main/jsonlWatcher.ts` (`requeueAll`), `src/main/config.ts` (`setStoreChoice`), `src/preload/index.ts` (`api.store`, `api.app.relaunch`), `src/main/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3; from 4a, `setReadSource`, `openPgMcpReadSource` and `PgStores.poolConfig`.
- Produces:
  - `StoreSupervisor<S>` with `run()`, `stop()`, `status()`, `whenReady()` and a `'status'` event.
  - `pingStore(pool, timeoutMs?)` and `JsonlWatcher.requeueAll()`.
  - `setStoreChoice('sqlite' | 'managed')`.
  - `registerStoreIpc()`, `setActiveStore(choice, status?)`, `broadcastStoreStatus` and `storeChoiceOf`.
  - The IPC channels `store:getSettings`, `store:setChoice`, the `store:status` push and `app:relaunch`.

- [ ] **Step 1: Write the supervisor test `src/main/store/storeSupervisor.test.ts`**

Sleeps park until the test releases them, so retries and pings step deterministically.

```ts
import { describe, expect, it } from 'vitest';
import type { StoreStatus } from '../../preload/storeTypes.js';
import { StoreSupervisor, type SupervisorDeps } from './storeSupervisor.js';

/** sleep() parks until the test calls tick(). */
function clock() {
  const parked: Array<() => void> = [];
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => new Promise<void>((r) => { waits.push(ms); parked.push(r); }),
    /** Wait until the supervisor sleeps. */
    async parked() {
      for (let i = 0; i < 100 && parked.length === 0; i++) await new Promise((r) => setImmediate(r));
      if (parked.length === 0) throw new Error('the supervisor never slept');
    },
    /** End the current sleep, then wait for the next one. */
    async tick() {
      await this.parked();
      parked.shift()!();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

type Stores = { id: number };

function harness(over: Partial<SupervisorDeps<Stores>> = {}) {
  const c = clock();
  const calls: string[] = [];
  let opens = 0;
  const deps: SupervisorDeps<Stores> = {
    choice: 'managed',
    open: async () => { opens++; calls.push(`open ${opens}`); return { id: opens }; },
    prepare: async (_s, onProgress) => { onProgress({ source: 'state', table: 'events', copied: 5, total: 10 }); return null; },
    ready: async (s) => { calls.push(`ready ${s.id}`); },
    ping: async () => undefined,
    recovered: (s) => { calls.push(`recovered ${s.id}`); },
    close: async (s) => { calls.push(`close ${s.id}`); },
    log: (type) => { calls.push(`log ${type}`); },
    sleep: c.sleep,
    ...over,
  };
  const sup = new StoreSupervisor(deps);
  const seen: StoreStatus[] = [];
  sup.on('status', (s: StoreStatus) => seen.push(s));
  return { sup, c, calls, seen };
}

describe('StoreSupervisor', () => {
  it('starts in starting, reports import progress, then ready once', async () => {
    const { sup, calls, seen } = harness();
    expect(sup.status()).toMatchObject({ choice: 'managed', phase: 'starting' });
    void sup.run();
    const stores = await sup.whenReady();
    expect(stores).toEqual({ id: 1 });
    expect(seen.map((s) => s.phase)).toEqual(['importing', 'ready']);
    expect(seen[0].progress).toEqual({ source: 'state', table: 'events', copied: 5, total: 10 });
    expect(sup.status()).toMatchObject({ phase: 'ready', progress: null, detail: null });
    expect(calls).toEqual(['open 1', 'ready 1']);
    sup.stop();
  });

  it('an open failure is down with its reason and retries with doubling backoff', async () => {
    let n = 0;
    const { sup, c, seen, calls } = harness({ open: async () => { if (++n < 3) throw new Error(`Docker is not running (${n})`); return { id: n }; } });
    void sup.run();
    await c.parked();
    expect(sup.status()).toMatchObject({ phase: 'down', detail: 'Docker is not running (1)' });
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'down', detail: 'Docker is not running (2)' });
    await c.tick();
    await sup.whenReady();
    expect(c.waits.slice(0, 2)).toEqual([1000, 2000]);
    expect(seen.filter((s) => s.phase === 'down').length).toBe(2);
    expect(calls.filter((x) => x === 'log store-open-failed').length).toBe(2);
    sup.stop();
  });

  it('a failed copy closes the stores before retrying, and ready runs only once', async () => {
    let n = 0;
    const { sup, c, calls } = harness({ prepare: async () => { if (++n === 1) throw new Error('copy failed'); return 'inbox.db was not copied'; } });
    void sup.run();
    await c.tick();
    await sup.whenReady();
    expect(calls).toEqual(['open 1', 'close 1', 'log store-open-failed', 'open 2', 'ready 2']);
    expect(sup.status().notice).toBe('inbox.db was not copied');
    sup.stop();
  });

  it('a failed ping is down and repairs; the next good ping is ready and recovered', async () => {
    let up = true;
    let repairs = 0;
    const { sup, c, calls } = harness({ ping: async () => { if (!up) throw new Error('connect ECONNREFUSED'); }, repair: async () => { repairs++; } });
    void sup.run();
    await sup.whenReady();
    up = false;
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'down', detail: 'connect ECONNREFUSED' });
    expect(repairs).toBe(1);
    await c.tick();
    expect(calls.filter((x) => x === 'log store-unreachable').length).toBe(1);
    up = true;
    await c.tick();
    expect(sup.status()).toMatchObject({ phase: 'ready', detail: null });
    expect(calls.at(-1)).toBe('recovered 1');
    sup.stop();
  });
});
```

Run `npx vitest run src/main/store/storeSupervisor.test.ts`. Expected: FAIL (no module).

- [ ] **Step 2: Write `src/main/store/storeSupervisor.ts` and re-run**

```ts
// Brings a Postgres store up and keeps watching it (part 4b D50): the app
// boots without waiting, store-backed services start once it is ready, and a
// later outage shows as `down` until a ping succeeds again.
import { EventEmitter } from 'node:events';
import type { ImportProgress, StoreChoice, StoreStatus } from '../../preload/storeTypes.js';

export interface SupervisorDeps<S> {
  choice: Exclude<StoreChoice, 'sqlite'>;
  /** Start (managed) and open the store; a throw is retried with backoff. */
  open(): Promise<S>;
  /** The first-switch copy; returns a notice for Settings, or null. A throw closes the stores and retries. */
  prepare(stores: S, onProgress: (p: ImportProgress) => void): Promise<string | null>;
  /** Start the store-backed services. Runs once. */
  ready(stores: S): Promise<void>;
  /** Throws when the store is unreachable. */
  ping(stores: S): Promise<void>;
  /** Managed: start the container again if Docker stopped it. */
  repair?(): Promise<void>;
  /** After an outage: catch up (ingest re-reads, renderers refetch). */
  recovered(stores: S): void;
  close(stores: S): Promise<void>;
  log(type: string, message: string): void;
  sleep?(ms: number): Promise<void>;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class StoreSupervisor<S> extends EventEmitter {
  private st: StoreStatus;
  private stopped = false;
  private readonly readyP: Promise<S>;
  private resolveReady!: (s: S) => void;

  constructor(private readonly d: SupervisorDeps<S>) {
    super();
    this.st = { choice: d.choice, phase: 'starting', detail: null, progress: null, notice: null };
    this.readyP = new Promise((r) => { this.resolveReady = r; });
  }

  status(): StoreStatus {
    return this.st;
  }

  /** Resolves once, when the store first becomes ready. */
  whenReady(): Promise<S> {
    return this.readyP;
  }

  /** Runs until stop(); never rejects. */
  async run(): Promise<void> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let backoff = 1000;
    let stores: S | null = null;
    while (!this.stopped && !stores) {
      let opened: S | null = null;
      try {
        opened = await this.d.open();
        const notice = await this.d.prepare(opened, (p) => this.set({ phase: 'importing', progress: p, detail: null }));
        stores = opened;
        await this.d.ready(stores).catch((e: unknown) => this.d.log('store-ready-failed', message(e)));
        this.set({ phase: 'ready', detail: null, progress: null, notice });
        this.resolveReady(stores);
      } catch (e) {
        if (opened) await this.d.close(opened).catch(() => undefined);
        this.d.log('store-open-failed', message(e));
        this.set({ phase: 'down', detail: message(e), progress: null });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, this.d.maxBackoffMs ?? 30_000);
      }
    }
    let down = false;
    while (!this.stopped && stores) {
      await sleep(this.d.pingIntervalMs ?? 5000);
      if (this.stopped) break;
      try {
        await this.d.ping(stores);
        if (down) {
          down = false;
          this.set({ phase: 'ready', detail: null });
          this.d.recovered(stores);
        }
      } catch (e) {
        if (!down) this.d.log('store-unreachable', message(e));
        down = true;
        this.set({ phase: 'down', detail: message(e) });
        await this.d.repair?.().catch((r: unknown) => this.set({ detail: message(r) }));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private set(p: Partial<StoreStatus>): void {
    this.st = { ...this.st, ...p };
    this.emit('status', this.st);
  }
}
```

Expected: 4/4.

- [ ] **Step 3: Write the watcher requeue test `src/main/jsonlWatcher.requeue.test.ts`**

```ts
// A store outage: ingest throws, the offset stays put, and requeueAll() after
// recovery ingests what the failed batches carried.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';
vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData' || which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
}));

const h = vi.hoisted(() => ({ down: false, attempts: 0, ingested: [] as string[] }));
vi.mock('./db.js', () => ({
  ingestBatch: async (_ws: string, _session: string, raws: string[]) => {
    h.attempts++;
    if (h.down) throw new Error('connect ECONNREFUSED');
    return raws.map((raw) => { h.ingested.push((JSON.parse(raw) as { uuid: string }).uuid); return { inserted: true }; });
  },
}));

const { JsonlWatcher } = await import('./jsonlWatcher.js');
const SESSION = '11111111-2222-3333-4444-555555555555';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(25);
  }
}

let watcher: InstanceType<typeof JsonlWatcher>;
let dir: string;
beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-watch-requeue-'));
  h.down = false;
  h.attempts = 0;
  h.ingested.length = 0;
  dir = join(userDataDir, 'projects', '-home-x');
  mkdirSync(dir, { recursive: true });
  watcher = new JsonlWatcher();
  await watcher.start([]);
  watcher.registerLocalDirForTest('ws-requeue', dir);
});
afterEach(async () => {
  await watcher.stop();
  await rm(userDataDir, { recursive: true, force: true });
});

it('re-reads a file whose batch failed while the store was down', async () => {
  h.down = true;
  const file = join(dir, `${SESSION}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1' }) + '\n');
  (watcher as unknown as { enqueue(p: string): void }).enqueue(file);
  await waitUntil(() => h.attempts > 0);
  await sleep(50);
  expect(h.ingested).toEqual([]);
  h.down = false;
  watcher.requeueAll();
  await waitUntil(() => h.ingested.length === 1);
  expect(h.ingested).toEqual(['u1']);
});
```

Run it. Expected: FAIL (`watcher.requeueAll is not a function`).

- [ ] **Step 4: Write `src/main/store/storeIpc.ts`**

```ts
// Settings → Storage and the store banner (SPEC §6 *Store*).
import { app, ipcMain, type BrowserWindow } from 'electron';
import { getStoreConfig, setStoreChoice } from '../config.js';
import type { StoreChoice, StoreSettings, StoreStatus } from '../../preload/storeTypes.js';
import type { StoreConfig } from './storeConfig.js';

export function storeChoiceOf(cfg: StoreConfig): StoreChoice {
  return cfg.kind === 'sqlite' ? 'sqlite' : cfg.kind === 'managed' ? 'managed' : 'external';
}

const SQLITE_READY = (choice: StoreChoice): StoreStatus => ({ choice, phase: 'ready', detail: null, progress: null, notice: null });

let active: StoreChoice = 'sqlite';
let statusOf: () => StoreStatus = () => SQLITE_READY(active);

/** What this run opened, and (Postgres) the supervisor's live status. */
export function setActiveStore(choice: StoreChoice, status?: () => StoreStatus): void {
  active = choice;
  statusOf = status ?? (() => SQLITE_READY(choice));
}

async function settings(): Promise<StoreSettings> {
  const configured = storeChoiceOf(await getStoreConfig());
  return { configured, active, restartRequired: configured !== active, status: statusOf() };
}

export function registerStoreIpc(): void {
  ipcMain.handle('store:getSettings', () => settings());
  ipcMain.handle('store:setChoice', async (_e, choice: unknown) => {
    if (choice !== 'sqlite' && choice !== 'managed') throw new Error('store choice must be "sqlite" or "managed"');
    await setStoreChoice(choice);
    return settings();
  });
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });
}

export function broadcastStoreStatus(s: StoreStatus, windows: readonly BrowserWindow[]): void {
  for (const w of windows) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try {
      w.webContents.send('store:status', s);
    } catch {
      // a window mid-teardown can throw
    }
  }
}
```

- [ ] **Step 5: Apply `pingStore`, `requeueAll`, `setStoreChoice` and the preload API**

Save as `/tmp/p4b_t4_main.py` and run `python3 /tmp/p4b_t4_main.py` from `$WT`:

```python
"""Part 4b Task 4: the main-side store plumbing (ping, watcher requeue, the Settings write, preload). Run from the worktree root."""


def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected one {old[:70]!r}, found {s.count(old)}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


with open('src/main/store/pgStores.ts', 'a') as f:
    f.write('''
/** Throws when the store doesn't answer within `timeoutMs`. */
export async function pingStore(pool: pg.Pool, timeoutMs = 3000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
''')

edit('src/main/jsonlWatcher.ts', [
    ("""  private enqueue(path: string): void {""", """  /** Re-read every known transcript from its offset. A batch that failed
   *  (store down) left its offset behind, and nothing else re-reads it until
   *  the file changes again. */
  requeueAll(): void {
    for (const path of this.files.keys()) this.enqueue(path);
  }

  private enqueue(path: string): void {"""),
])

s = open('src/main/config.ts').read()
anchor = s.index('export async function getGithubClientIdConfig')
doc = s.rfind('/**', 0, anchor)
s = s[:doc] + '''/** Settings → Storage. An external Postgres stays hand-edited: its block
 *  names connections and credentials the UI doesn't. */
export async function setStoreChoice(choice: 'sqlite' | 'managed'): Promise<void> {
  const current = await getStoreConfig();
  if (current.kind === 'postgres') {
    throw new Error('config.json names an external Postgres store; edit its "store" key to change it');
  }
  const cfg = await read();
  await write({ ...cfg, store: choice === 'managed' ? { kind: 'postgres', managed: true } : undefined });
}

''' + s[doc:]
open('src/main/config.ts', 'w').write(s)

edit('src/preload/index.ts', [
    ("""import type { RemoteAddOptions, RemoteLiveSession, RemoteProbe } from './remoteTypes';""",
     """import type { RemoteAddOptions, RemoteLiveSession, RemoteProbe } from './remoteTypes';
import type { StoreChoice, StoreSettings, StoreStatus } from './storeTypes';
export type { ImportProgress, StoreChoice, StorePhase, StoreSettings, StoreStatus } from './storeTypes';"""),
    ("""    /** Open error.log in the OS default app — the MCP-unreachable toast's action. */
    openErrorLog: (): Promise<string> => ipcRenderer.invoke('app:openErrorLog'),""",
     """    /** Open error.log in the OS default app — the MCP-unreachable toast's action. */
    openErrorLog: (): Promise<string> => ipcRenderer.invoke('app:openErrorLog'),
    /** Quit and start again (Settings → Storage applies at restart). */
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),"""),
    ("""  remote: {
    /** /whoami a host URL""", """  store: {
    getSettings: (): Promise<StoreSettings> => ipcRenderer.invoke('store:getSettings'),
    /** Writes config.json; takes effect at the next start. */
    setChoice: (choice: Exclude<StoreChoice, 'external'>): Promise<StoreSettings> => ipcRenderer.invoke('store:setChoice', choice),
    /** Postgres store status changes (starting, importing, down, ready). Returns an unsubscribe function. */
    onStatus: (cb: (s: StoreStatus) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, s: StoreStatus): void => cb(s);
      ipcRenderer.on('store:status', handler);
      return () => ipcRenderer.removeListener('store:status', handler);
    }
  },
  remote: {
    /** /whoami a host URL"""),
])
print('ok')
```

Re-run `npx vitest run src/main/jsonlWatcher.requeue.test.ts`. Expected: PASS.

- [ ] **Step 6: Restructure the boot in `src/main/index.ts`**

Save the block below as `/tmp/p4b_boot_region.ts`. It replaces everything from `  // A configured Postgres store that cannot open stops the launch: silently` up to (not including) `  app.on('activate', …`.
- **SQLite** runs the same statements in the same order as today: inbox open, `openDb`, the error sink, the app-start row, perf, `startMcpServer`, the embedder, the ingest listeners, the MCP status listener, the sockets, the `.claude.json` reconcile, the mirror defaults, the watcher, the local dirs, peer status, the backfill, `registerIpc`, the inbox IPC, presence IPC, the window and presence.
- **Postgres** runs the store-backed steps from the supervisor's `ready`.

```ts
  // The store (§8 Startup). SQLite opens inline. A Postgres store (managed or
  // external) comes up under the supervisor without holding the launch, and the
  // services that read or write it start once it is ready. A config error stops
  // the launch: silently using SQLite would split the history and inbox in two.
  // Mock mode has no Docker and no transcripts, so it always uses SQLite.
  const userData = app.getPath('userData');
  let storeCfg: StoreConfig = { kind: 'sqlite' };
  if (!isMock) {
    try {
      storeCfg = await getStoreConfig();
    } catch (e) {
      logError({ source: 'main', type: 'store-open-failed', level: 'error', message: String(e) });
      const prompt = storeStartupPrompt(e, join(userData, 'config.json'));
      const { response } = await dialog.showMessageBox({ type: 'error', noLink: true, ...prompt });
      if (storeStartupOutcome(prompt, response) === 'quit') {
        app.exit(1);
        return;
      }
    }
  }
  const sqlite = storeCfg.kind === 'sqlite';

  if (sqlite) {
    // Authoritative inbox (#407): opens in mock AND real mode. state.db is a
    // droppable cache gated on the JSONL watcher; the inbox is neither.
    try {
      inboxStore = InboxStore.open(userData);
    } catch (e) {
      logError({ source: 'main', type: 'inbox-open-failed', level: 'error', message: String(e) });
    }
  }

  /** The error sink, the app-start row and perf telemetry: all write state.db. */
  const startStateWrites = async (): Promise<void> => {
    // Wire the crash-safe DB sink so every logError call is also persisted to
    // the errors table.
    // best-effort; a wedged DB must never break crash logging, so the async
    // write's rejection is swallowed here.
    setErrorSink((row) => {
      void recordError(row).catch(() => undefined);
    });
    // One line per app run identifying the build (#298): the error.log header
    // and an errors-table row that lets historical telemetry be partitioned by
    // build sha when two builds share a semver.
    logError({
      source: 'main',
      type: 'app-start',
      level: 'info',
      message: `claude-fleet ${appVersionString()} starting`,
      extra: { sha: appBuildSha() ?? null }
    });
    const perfStore = new PerfStore(stateKysely());
    initPerf(
      perfStore,
      resolvePerfConfig(
        { perfTelemetry: await getPerfTelemetry(), perfOtlp: await getPerfOtlp() },
        process.env
      )
    );
  };

  /** Start ingesting: the watcher plus every local workspace's host dir. */
  const startIngest = async (watcher: JsonlWatcher, manifests: WorkspaceSpec[]): Promise<void> => {
    // Seed each workspace's durable-mirror default from its manifest before the
    // watcher starts ingesting, so the very first lines are mirrored per the
    // saved setting — not dependent on the renderer's later workspace:list poll.
    for (const m of manifests) setWorkspaceDefault(m.id, m.mirror.default);
    await perfSpanAsync('claude_fleet.boot.jsonl_watcher_start', () => watcher.start(manifests.map((m) => m.id)));
    // Local-backend workspaces write to the host's real ~/.claude, not the
    // per-workspace state dir — register those host project dirs so their
    // (and their subagents') token spend is ingested (#plan-usage).
    for (const m of manifests) {
      // Sweep for states that should be impossible (#323). writeWorkspaceManifest
      // catches these as they're written, but a manifest already on disk in a bad
      // state is never re-written, so it would otherwise stay silent forever —
      // which is exactly what happened for ~6 days in #313.
      const violation = manifestInvariant(m);
      if (violation) {
        logError({
          source: 'main',
          type: 'manifest-invariant',
          level: 'error',
          message: `${violation} (found at startup)`,
          workspaceId: m.id,
          extra: { workspaceRoot: m.workspaceRoot, launcher: m.launcher, kind: m.kind }
        });
      }
      if (m.kind === 'local' && m.workspaceRoot) {
        if (m.launcher?.mode === 'wsl') {
          watcher.registerPolledLocalDir(
            m.id,
            wslLocalProjectsDir(
              m.launcher.distro, m.launcher.home, m.workspaceRoot, encodeClaudeProjectDir
            )
          );
        } else {
          watcher.registerLocalWorkspace(m.id, m.workspaceRoot);
        }
      }
    }
  };

  /** Backfill embeddings for sessions ingested before this feature / after a
   *  model change. Non-blocking; walks every known session once. */
  const startEmbedBackfill = (embed: EmbedFn): void => {
    void (async () => {
      try {
        // A model/dtype change re-keys EMBED_MODEL_ID; drop vectors under
        // retired keys so they don't accumulate as dead weight.
        // Spanned (#perf boot attribution): the post-launch stall storm overlaps
        // this backfill; boot.embed_backfill is wall time, the index.* / embed.*
        // child spans carry the synchronous parts that can block the loop.
        await perfSpanAsync('claude_fleet.boot.embed_backfill', async () => {
          await perfSpanAsync('claude_fleet.index.delete_stale_models', () => deleteEmbeddingsForOtherModels(EMBED_MODEL_ID));
          const sessionIds = await perfSpanAsync('claude_fleet.index.list_sessions', () => listSessionIds());
          for (const id of sessionIds) await indexSessionTurns(id, embed);
          await indexSessionSummaries(embed);
        });
      } catch (e) {
        logError({ source: 'main', level: 'warn', type: 'index-backfill', message: String(e) });
      }
    })();
  };

  /** Inbox, notification and automation IPC plus their timers. */
  const startInboxServices = (inbox: InboxStore): void => {
    notifySvc = registerNotifyIpc(inbox);
    auto = registerAutomationIpc(inbox, notifySvc);
    const inboxHost = registerInboxIpc(inbox, notifySvc ?? undefined, auto ? (r, c) => auto!.automations.attribution(r, c) : undefined);
    auto?.setInboxSink(inboxHost);
  };

  /** Desktop presence (#407 Phase 2b): tray, taskbar overlay, badge, attention. */
  const startPresenceServices = (win: BrowserWindow): void => {
    if (!inboxStore || !notifySvc) return;
    presence = startPresence(inboxStore, notifySvc, () => auto?.proposals.pendingCount() ?? 0);
    attachKeepRunning(win, () => presence?.hasTray() ?? false);
  };

  let embed: EmbedFn | null = null;
  if (jsonlWatcher) {
    if (sqlite) {
      openDb(userData);
      await startStateWrites();
    }
    // Read-only MCP server over <userData>/mcp.sock so in-container claude can
    // query the state DB (sessions/events/cost). On SQLite it opens its own
    // readonly conn; on Postgres the history tools wait for setReadSource.
    perfSpan('claude_fleet.boot.mcp_server', () => startMcpServer(userData, sqlite ? {} : { readSource: null }));
    // Local embedder for semantic transcript search (native onnxruntime-node, on-host).
    const embedFn = makeEmbedder(join(userData, 'models'));
    embed = embedFn;
    setQueryEmbedder(embedFn);

    // Index new turns/summaries as they land. Fire-and-forget: indexing must
    // never block ingest, and a failure degrades search silently (logged).
    jsonlWatcher.on('ingest', ({ sessionId }) => {
      indexSessionTurns(sessionId, embedFn).catch((e) =>
        logError({ source: 'main', level: 'warn', type: 'transcript-index', message: String(e) }));
    });
    jsonlWatcher.on('ingest', () => {
      indexSessionSummaries(embedFn).catch((e) =>
        logError({ source: 'main', level: 'warn', type: 'summary-index', message: String(e) }));
    });
    // Surface host MCP listener health to renderers as the "MCP unreachable"
    // sticky toast (#159 follow-up): fan the change-only status out to every
    // window. Wired before the listener can fail so the first event is caught.
    setMcpStatusListener((s) => broadcastMcpStatus(s, BrowserWindow.getAllWindows()));
    // Remote bookmarks have no local socket, transcripts or peer-status dir.
    const manifests = (await listWorkspaceManifests()).filter((m) => m.kind !== 'remote');
    // Re-establish a per-workspace MCP listener for every known workspace (#117)
    // so a paused container that survived the restart finds its socket again
    // (its bind points at <userData>/mcp/<id>/, whose listener must be rebuilt).
    perfSpan('claude_fleet.boot.workspace_sockets', () => { for (const m of manifests) ensureWorkspaceSocket(m.id); });
    // Reconcile the app-managed mcpServers entry in every container workspace's
    // bind-mounted ~/.claude.json at startup — not just at container create.
    // Without this, a bridge fix never reaches an existing workspace until its
    // container is recreated: the old socat entry kept eating the first MCP
    // request after every app restart (the first-call hang) indefinitely.
    // Live claude sessions still pick it up only when they (re)spawn the MCP
    // server process — a tab Refresh or a new session, not a container rebuild.
    for (const m of manifests) {
      if (m.kind !== 'container') continue;
      const workingDir = `/workspace/${m.workspaceSubdir}`.replace(/\/$/, '') || '/workspace';
      ensureWorkspaceClaudeJson(m.id, workingDir).catch((e) =>
        logError({
          source: 'main',
          type: 'claude-json-reconcile',
          level: 'warn',
          message: `startup reconcile of ~/.claude.json failed: ${String(e)}`,
          workspaceId: m.id
        })
      );
    }
    if (sqlite) await startIngest(jsonlWatcher, manifests);
    // Peer-status reconciler (#286): watch each workspace's claude
    // `sessions/<pid>.json` files and push an authoritative busy/idle/waiting
    // snapshot to every renderer, which merges it over the title glyph.
    if (peerStatusWatcher) {
      await perfSpanAsync('claude_fleet.boot.peer_status_start', () => peerStatusWatcher.start());
      registerPeerStatusDirs(peerStatusWatcher, manifests);
      peerStatusWatcher.on('change', (snapshot) => {
        broadcastSessionStatus(
          snapshot.map((s) => ({ claudeSessionId: s.sessionId, status: s.status, waitingFor: s.waitingFor })),
          BrowserWindow.getAllWindows()
        );
      });
    }
    if (sqlite) startEmbedBackfill(embedFn);
  }
  if (!sqlite) {
    const pgCfg = storeCfg as PostgresStoreConfig | ManagedStoreConfig;
    const docker = pgCfg.kind === 'managed' ? dockerodeManagedDocker() : null;
    managedDocker = docker;
    const resolveCfg = (): Promise<PostgresStoreConfig> =>
      pgCfg.kind === 'managed'
        ? ensureManagedPostgres({
          docker: docker!,
          password: {
            get: () => getSecret(MANAGED_STORE_SCOPE, MANAGED_STORE_PASSWORD_KEY),
            set: (v) => setSecret(MANAGED_STORE_SCOPE, MANAGED_STORE_PASSWORD_KEY, v),
          },
        }, pgCfg.poolMax)
        : Promise.resolve(pgCfg);
    const sup = new StoreSupervisor<PgStores>({
      choice: pgCfg.kind === 'managed' ? 'managed' : 'external',
      open: async () => openPgStores(await resolveCfg(), {
        state: false,
        onPoolError: (e) => logError({ source: 'main', type: 'store-pool-error', level: 'warn', message: String(e) }),
        migrate: (pool) => migratePgStores(pool, { state: jsonlWatcher !== null, extraTracks: [IMPORT_PG_TRACK] }),
      }),
      prepare: (stores, onProgress) => firstSwitchCopy({ pool: stores.pool, userData, state: jsonlWatcher !== null, onProgress }),
      ready: async (stores) => {
        pgStores = stores;
        inboxStore = stores.inbox;
        if (jsonlWatcher && embed) {
          // After the copy: openDbPostgres rehydrates pendingClaudeIds from the copied rows.
          await openDbPostgres(stores.pool, { migrate: false });
          await startStateWrites();
          setReadSource(await openPgMcpReadSource(schemaOf(stores.pool), stores.poolConfig, (message) =>
            logError({ source: 'main', type: 'mcp-query-isolation', level: 'warn', message })));
          await startIngest(jsonlWatcher, (await listWorkspaceManifests()).filter((m) => m.kind !== 'remote'));
          startEmbedBackfill(embed);
        }
        startInboxServices(stores.inbox);
        if (mainWindow) startPresenceServices(mainWindow);
        void stores.inbox.counts().then((c) => broadcastInboxChanged(c, BrowserWindow.getAllWindows())).catch(() => undefined);
      },
      ping: (stores) => pingStore(stores.pool),
      repair: docker ? async () => { await resolveCfg(); } : undefined,
      recovered: (stores) => {
        jsonlWatcher?.requeueAll();
        void stores.inbox.counts().then((c) => broadcastInboxChanged(c, BrowserWindow.getAllWindows())).catch(() => undefined);
      },
      close: async (stores) => {
        await stores.inbox.close();
        await stores.end();
      },
      log: (type, message) => logError({ source: 'main', type, level: 'warn', message }),
    });
    supervisor = sup;
    setActiveStore(storeChoiceOf(storeCfg), () => sup.status());
    sup.on('status', (s: StoreStatus) => broadcastStoreStatus(s, BrowserWindow.getAllWindows()));
  } else {
    setActiveStore('sqlite');
  }
  // Patch ipcMain.handle before ipc.ts registers anything, so every later-
  // registered handler runs inside a claude_fleet.ipc.<channel> span.
  // With recording off the tracer is a no-op — cost is one async frame/invoke.
  instrumentIpcHandle(ipcMain);
  perfSpan('claude_fleet.boot.register_ipc', () => registerIpc({ jsonlWatcher, peerStatusWatcher }));
  registerStoreIpc();
  if (inboxStore) startInboxServices(inboxStore);
  registerPresenceIpc(ipcMain, { get: getKeepRunningInTray, set: setKeepRunningInTray });
  const win = createWindow();
  mainWindow = win;
  startPresenceServices(win);
  void supervisor?.run();
```

Then save as `/tmp/p4b_t4_index.py` and run `python3 /tmp/p4b_t4_index.py` from `$WT`. It splices the block in, adds the imports and module state, and stops the supervisor and then the container at quit:

```python
"""Part 4b Task 4: index.ts boots store-backed services when the store is ready. Run from the worktree root after saving /tmp/p4b_boot_region.ts."""


def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected one {old[:70]!r}, found {s.count(old)}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


P = 'src/main/index.ts'
s = open(P).read()
start = s.index('  // A configured Postgres store that cannot open stops the launch: silently')
end = s.index("\n  app.on('activate', () => {")
s = s[:start] + open('/tmp/p4b_boot_region.ts').read() + s[end:]
open(P, 'w').write(s)

edit(P, [
    ("import { openDb, closeDb, deleteEmbeddingsForOtherModels, listSessionIds, recordError, stateKysely } from './db.js';",
     "import { openDb, openDbPostgres, closeDb, deleteEmbeddingsForOtherModels, listSessionIds, recordError, stateKysely } from './db.js';"),
    ("import { startMcpServer, stopMcpServer, ensureWorkspaceSocket, setMcpStatusListener, setQueryEmbedder } from './mcpServer.js';",
     "import { startMcpServer, stopMcpServer, ensureWorkspaceSocket, setMcpStatusListener, setQueryEmbedder, setReadSource } from './mcpServer.js';"),
    ("import { listWorkspaceManifests, manifestInvariant } from './workspaces.js';",
     "import { listWorkspaceManifests, manifestInvariant, type WorkspaceSpec } from './workspaces.js';"),
    ("import { openPgStores, type PgStores } from './store/pgStores.js';",
     """import { migratePgStores, openPgStores, pingStore, type PgStores } from './store/pgStores.js';
import type { ManagedStoreConfig, PostgresStoreConfig, StoreConfig } from './store/storeConfig.js';
import { StoreSupervisor } from './store/storeSupervisor.js';
import { broadcastStoreStatus, registerStoreIpc, setActiveStore, storeChoiceOf } from './store/storeIpc.js';
import { firstSwitchCopy } from './store/firstSwitch.js';
import { IMPORT_PG_TRACK } from './store/storeImport.js';
import { ensureManagedPostgres, stopManagedPostgres, type ManagedDocker } from './store/managedPostgres.js';
import { dockerodeManagedDocker } from './store/managedDocker.js';
import { broadcastInboxChanged } from './inbox/inboxBroadcast.js';
import { getSecret, setSecret } from './vault.js';
import { MANAGED_STORE_PASSWORD_KEY, MANAGED_STORE_SCOPE } from './vaultScopes.js';
import type { StoreStatus } from '../preload/storeTypes.js';"""),
    ("import { indexSessionTurns, indexSessionSummaries } from './transcriptIndex.js';",
     "import { indexSessionTurns, indexSessionSummaries, type EmbedFn } from './transcriptIndex.js';"),
    ("""// The Postgres store's shared pool when config.json chooses it.
let pgStores: PgStores | null = null;""", """// The Postgres store's shared pool when config.json chooses it.
let pgStores: PgStores | null = null;
let supervisor: StoreSupervisor<PgStores> | null = null;
// Set when the store is the managed container: stopped at quit.
let managedDocker: ManagedDocker | null = null;"""),
    ("""app.on('before-quit', async () => {
  markQuitting();""", """app.on('before-quit', async () => {
  markQuitting();
  supervisor?.stop();"""),
    ("""  await pgStores?.end();
  pgStores = null;""", """  await pgStores?.end();
  pgStores = null;
  if (managedDocker) await stopManagedPostgres(managedDocker).catch(() => undefined);"""),
])
print('ok')
```

- [ ] **Step 7: Check the SQLite boot order didn't move**

```bash
git -C "$WT" diff HEAD -- src/main/index.ts | /usr/bin/grep -E "^[-+]\s+(openDb|setErrorSink|initPerf|perfSpan\('claude_fleet.boot|registerIpc|registerPresenceIpc|mainWindow = |createWindow)" 
```

Read every hit against the original order listed in Step 6. Moving a statement into a function is fine; reordering one on the SQLite path isn't.

- [ ] **Step 8: Gate and commit**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run typecheck:host
CI=true npx vitest run src
CI=true npm run test:unit:pg
git -C "$WT" add src/main/store/storeSupervisor.ts src/main/store/storeSupervisor.test.ts src/main/store/storeIpc.ts src/main/jsonlWatcher.requeue.test.ts src/main/store/pgStores.ts src/main/jsonlWatcher.ts src/main/config.ts src/preload/index.ts src/main/index.ts
git -C "$WT" commit -m "feat(store): the Postgres store comes up under a supervisor; services start when it is ready

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Settings → Storage and the store banner

**Files:**
- Create: `src/renderer/src/storeView.ts`, `src/renderer/src/storeView.test.ts`, `src/renderer/src/components/StorageSettings.tsx`, `tests/storage-settings.spec.ts`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/components/SettingsModal.tsx`, `src/renderer/src/styles.css`, `tsconfig.web.json`

**Interfaces:**
- Consumes: `window.api.store.{getSettings, setChoice, onStatus}` and `window.api.app.relaunch` (Task 4).
- Produces: `storeBannerText(status)`, `storeSwitchNote(active, configured)`, `STORE_CHOICES` and `<StorageSettings />`.

- [ ] **Step 1: Write `src/renderer/src/storeView.test.ts`, see it fail, then write `src/renderer/src/storeView.ts`**

Pure renderer modules import types from the preload types file, as `accountView.ts` does. `tsconfig.web.json` doesn't include `src/preload/index.ts`.

```ts
import { describe, expect, it } from 'vitest';
import type { StoreStatus } from '../../preload/storeTypes';
import { storeBannerText, storeSwitchNote } from './storeView';

const st = (p: Partial<StoreStatus>): StoreStatus => ({ choice: 'managed', phase: 'ready', detail: null, progress: null, notice: null, ...p });

describe('storeBannerText', () => {
  it('is silent on SQLite and when ready', () => {
    expect(storeBannerText(null)).toBeNull();
    expect(storeBannerText(st({ choice: 'sqlite', phase: 'down' }))).toBeNull();
    expect(storeBannerText(st({ phase: 'ready' }))).toBeNull();
  });
  it('names the phase, the copy progress and the reason', () => {
    expect(storeBannerText(st({ phase: 'starting' }))).toMatch(/^Starting the Postgres store/);
    expect(storeBannerText(st({ phase: 'importing', progress: { source: 'state', table: 'events', copied: 1500, total: 20000 } })))
      .toBe('Copying your history to Postgres: events, 1,500 of 20,000 rows.');
    expect(storeBannerText(st({ phase: 'down', detail: 'Docker is not running: the managed Postgres store needs it' })))
      .toBe('Postgres store unreachable. History and inbox are unavailable: Docker is not running: the managed Postgres store needs it');
  });
});

describe('storeSwitchNote', () => {
  it('describes the next start only when the choice changed', () => {
    expect(storeSwitchNote('sqlite', 'sqlite')).toBeNull();
    expect(storeSwitchNote('sqlite', 'managed')).toMatch(/copies your SQLite inbox and history/);
    expect(storeSwitchNote('managed', 'sqlite')).toMatch(/not copied back/);
  });
});
```

```ts
// Text for Settings › Storage and the store banner. Pure, so it unit-tests.
import type { StoreChoice, StoreStatus } from '../../preload/storeTypes';

export const STORE_CHOICES: ReadonlyArray<{ id: Exclude<StoreChoice, 'external'>; label: string; desc: string }> = [
  {
    id: 'sqlite',
    label: 'SQLite (built in)',
    desc: 'History and inbox live in files in the app data folder. No setup, and works without Docker.',
  },
  {
    id: 'managed',
    label: 'Postgres, managed by claude-fleet',
    desc:
      'A local Postgres + pgvector container that the app starts and stops, with its data in a Docker volume. ' +
      'It needs Docker running: while Docker is down, history and inbox are unavailable.',
  },
];

/** What the next start does after a switch, or null when nothing changes. */
export function storeSwitchNote(active: StoreChoice, configured: StoreChoice): string | null {
  if (active === configured) return null;
  if (configured === 'managed') {
    return 'At the next start the app creates the container and copies your SQLite inbox and history into it. ' +
      'inbox.db is then renamed inbox.db.migrated-<time>.';
  }
  if (configured === 'sqlite') {
    return 'At the next start the app uses SQLite again. Inbox items and history created on Postgres stay in its ' +
      'Docker volume and are not copied back.';
  }
  return null;
}

/** The banner under the strip, or null when the store is ready or SQLite. */
export function storeBannerText(s: StoreStatus | null): string | null {
  if (!s || s.choice === 'sqlite' || s.phase === 'ready') return null;
  if (s.phase === 'starting') return 'Starting the Postgres store. History and inbox are unavailable until it is up.';
  if (s.phase === 'importing') {
    const p = s.progress;
    if (!p) return 'Copying your history and inbox to Postgres…';
    return `Copying your ${p.source === 'inbox' ? 'inbox' : 'history'} to Postgres: ${p.table}, ` +
      `${p.copied.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')} rows.`;
  }
  return `Postgres store unreachable. History and inbox are unavailable${s.detail ? `: ${s.detail}` : '.'}`;
}
```

- [ ] **Step 2: Write `src/renderer/src/components/StorageSettings.tsx`**

```tsx
// Settings › Storage › History and inbox: SQLite or the managed Postgres
// container. The choice is written to config.json and applies at restart.
import { useEffect, useState } from 'react';
import type { StoreChoice, StoreSettings } from '../../../preload';
import { STORE_CHOICES, storeSwitchNote } from '../storeView';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function StorageSettings() {
  const [s, setS] = useState<StoreSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    window.api.store.getSettings()
      .then((x) => { if (live) setS(x); })
      .catch((e: unknown) => { if (live) setError(message(e)); });
    const off = window.api.store.onStatus((status) => setS((cur) => (cur ? { ...cur, status } : cur)));
    return () => { live = false; off(); };
  }, []);

  async function choose(choice: Exclude<StoreChoice, 'external'>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setS(await window.api.store.setChoice(choice));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (!s) return error ? <p className="setting-desc">{error}</p> : null;
  if (s.configured === 'external') {
    return (
      <p className="setting-desc store-choice-external">
        History and inbox are in an external Postgres store set in config.json (<code>store</code>). Edit the file to change it.
      </p>
    );
  }
  const note = storeSwitchNote(s.active, s.configured);
  return (
    <div className="store-choice" role="radiogroup" aria-label="History and inbox store">
      <div className="setting-title">History and inbox</div>
      {STORE_CHOICES.map((c) => (
        <label key={c.id} className="setting-row store-choice-row">
          <input
            type="radio"
            name="store-choice"
            value={c.id}
            checked={s.configured === c.id}
            disabled={busy}
            onChange={() => void choose(c.id)}
          />
          <span className="setting-row-text">
            <span className="setting-title">{c.label}</span>
            <span className="setting-desc">{c.desc}</span>
          </span>
        </label>
      ))}
      {s.status.notice && <p className="setting-desc">{s.status.notice}</p>}
      {s.restartRequired && note && (
        <div className="store-choice-restart">
          <p className="setting-desc"><strong>Restart required.</strong> {note}</p>
          <button type="button" className="btn" onClick={() => void window.api.app.relaunch()}>Restart now</button>
        </div>
      )}
      {error && <p className="setting-desc">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Wire the banner, the section, the CSS and the web tsconfig**

Save as `/tmp/p4b_t5.py` and run `python3 /tmp/p4b_t5.py` from `$WT`. Three things change:
- The three banners move into one `.app-banners` wrapper, so the grid needs one `auto` row whatever the combination. That replaces the `daemon-down`/`remote-down` row rules.
- `docker-down.spec.ts` keeps working: it selects `.daemon-banner`.
- `App.tsx` keeps its classes.

```python
"""Part 4b Task 5: the store banner in App.tsx, the Storage section, CSS. Run from the worktree root."""


def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected one {old[:70]!r}, found {s.count(old)}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


edit('src/renderer/src/App.tsx', [
    ("import type { WorkspaceObservabilitySummary, SessionListItem, UsageBudget, UiPrefs, InboxCounts, InboxConfig, QuietState } from '../../preload';",
     "import type { WorkspaceObservabilitySummary, SessionListItem, UsageBudget, UiPrefs, InboxCounts, InboxConfig, QuietState, StoreStatus } from '../../preload';\nimport { storeBannerText } from './storeView';"),
    ("""  const [inboxCounts, setInboxCounts] = useState<InboxCounts>({ open: 0, urgent: 0, high: 0 });
  useEffect(() => {
    void window.api.inbox.counts().then(setInboxCounts);
    return window.api.inbox.onChanged(setInboxCounts);
  }, []);""", """  const [inboxCounts, setInboxCounts] = useState<InboxCounts>({ open: 0, urgent: 0, high: 0 });
  useEffect(() => {
    void window.api.inbox.counts().then(setInboxCounts);
    return window.api.inbox.onChanged(setInboxCounts);
  }, []);
  // The Postgres store's phase (starting, importing, down) drives a banner;
  // main broadcasts inbox:changed when it becomes ready.
  const [storeStatus, setStoreStatus] = useState<StoreStatus | null>(null);
  useEffect(() => {
    let live = true;
    window.api.store.getSettings()
      .then((s) => { if (live) setStoreStatus(s.status); })
      .catch(() => undefined);
    const off = window.api.store.onStatus(setStoreStatus);
    return () => { live = false; off(); };
  }, []);"""),
    ("""  const remoteBanner = unreachableBanner(unreachableRemoteNames(workspaces));""",
     """  const remoteBanner = unreachableBanner(unreachableRemoteNames(workspaces));
  const storeBanner = storeBannerText(storeStatus);
  const hasBanners = backendReady === false || !!remoteBanner || !!storeBanner;"""),
    ("""        backendReady === false ? ' daemon-down' : ''
      }${remoteBanner ? ' remote-down' : ''}`}""", """        backendReady === false ? ' daemon-down' : ''
      }${remoteBanner ? ' remote-down' : ''}${hasBanners ? ' has-banners' : ''}`}"""),
    ("""      {backendReady === false && (
        <div className="daemon-banner" role="status">
          <span className="dot" aria-hidden="true" />
          Docker daemon unreachable — container workspaces are shown from last-known state and
          can&apos;t be started or attached until it&apos;s back.
        </div>
      )}
      {remoteBanner && (
        <div className="daemon-banner remote-banner" role="status">
          <span className="dot" aria-hidden="true" />
          {remoteBanner}
        </div>
      )}""", """      {hasBanners && (
        <div className="app-banners">
          {backendReady === false && (
            <div className="daemon-banner" role="status">
              <span className="dot" aria-hidden="true" />
              Docker daemon unreachable — container workspaces are shown from last-known state and
              can&apos;t be started or attached until it&apos;s back.
            </div>
          )}
          {remoteBanner && (
            <div className="daemon-banner remote-banner" role="status">
              <span className="dot" aria-hidden="true" />
              {remoteBanner}
            </div>
          )}
          {storeBanner && (
            <div className="daemon-banner store-banner" role="status">
              <span className="dot" aria-hidden="true" />
              {storeBanner}
            </div>
          )}
        </div>
      )}"""),
])

edit('src/renderer/src/components/SettingsModal.tsx', [
    ("import { AccountSettings } from './AccountSettings';", "import { AccountSettings } from './AccountSettings';\nimport { StorageSettings } from './StorageSettings';"),
    ("""                <code>/workspace</code>, plus a shared <code>&lt;root&gt;/shared</code> →{' '}
                <code>/shared</code> in every container. Applies to new containers and on next
                restart.
              </p>
""", """                <code>/workspace</code>, plus a shared <code>&lt;root&gt;/shared</code> →{' '}
                <code>/shared</code> in every container. Applies to new containers and on next
                restart.
              </p>
              <StorageSettings />
"""),
])

edit('src/renderer/src/styles.css', [
    ("""/* Daemon-down banner (#380) sits between the top strip and the body as an
   extra in-flow row. Without a track for it, grid auto-placement would push
   the body out of the 1fr row into `auto`, so the banner would swallow all the
   spare height (worse the larger the window). Add a second `auto` row for the
   banner while the body keeps 1fr. */
.app.daemon-down,
.app.remote-down {
  grid-template-rows: auto auto 1fr auto;
}
.app.daemon-down.remote-down {
  grid-template-rows: auto auto auto 1fr auto;
}""", """/* The banners (#380 daemon-down, remote, store) share one wrapper row between
   the top strip and the body. Without a track for it, grid auto-placement would
   push the body out of the 1fr row into `auto`, so the banner would swallow all
   the spare height (worse the larger the window). */
.app.has-banners {
  grid-template-rows: auto auto 1fr auto;
}"""),
    (""".daemon-banner .dot {""", """.daemon-banner.store-banner { color: #e8d2a8; background: #2a2418; border-bottom-color: #4a3d22; }
.daemon-banner .dot {"""),
])
with open('src/renderer/src/styles.css', 'a') as f:
    f.write("""
/* Settings › Storage › History and inbox. */
.store-choice { margin-top: 12px; }
.store-choice-row { cursor: pointer; justify-content: flex-start; }
.store-choice-row input[type='radio'] { margin: 3px 0 0; accent-color: var(--ok); flex-shrink: 0; }
.store-choice-row .setting-desc { display: block; }
.store-choice-restart { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
""")
edit('tsconfig.web.json', [
    ('"src/preload/remoteTypes.ts"]', '"src/preload/remoteTypes.ts", "src/preload/storeTypes.ts"]'),
])
print('ok')
```

- [ ] **Step 4: Write the e2e smoke `tests/storage-settings.spec.ts`**

```ts
// Settings › Storage › History and inbox (async store part 4b): the choice is
// written to config.json and applies at restart. Mock mode never starts the
// container, so this pins the UI and the config write only.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './_helpers.js';

test('Storage: SQLite by default; choosing managed Postgres writes config.json and asks for a restart', async () => {
  const { app, window, userDataDir } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  const storeKey = (): unknown => {
    try {
      return (JSON.parse(readFileSync(join(userDataDir, 'config.json'), 'utf8')) as { store?: unknown }).store;
    } catch {
      return undefined;
    }
  };
  try {
    await expect(window.locator('.store-banner')).toHaveCount(0);
    await window.getByRole('button', { name: 'Settings' }).click();
    const sqlite = window.getByRole('radio', { name: /SQLite \(built in\)/ });
    const managed = window.getByRole('radio', { name: /Postgres, managed by claude-fleet/ });
    await expect(sqlite).toBeChecked();
    await expect(window.getByText('Restart required.')).toHaveCount(0);

    await managed.check();
    await expect(managed).toBeChecked();
    await expect(window.getByText('Restart required.')).toBeVisible();
    await expect.poll(storeKey).toEqual({ kind: 'postgres', managed: true });

    await sqlite.check();
    await expect(window.getByText('Restart required.')).toHaveCount(0);
    await expect.poll(storeKey).toBeUndefined();
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 5: Gate and commit**

```bash
npx tsc --noEmit -p tsconfig.web.json && npx tsc --noEmit -p tsconfig.node.json
npx vitest run src/renderer/src/storeView.test.ts
npx playwright test tests/storage-settings.spec.ts tests/docker-down.spec.ts   # only where a display exists; otherwise CI
git -C "$WT" add src/renderer/src/storeView.ts src/renderer/src/storeView.test.ts src/renderer/src/components/StorageSettings.tsx tests/storage-settings.spec.ts src/renderer/src/App.tsx src/renderer/src/components/SettingsModal.tsx src/renderer/src/styles.css tsconfig.web.json
git -C "$WT" commit -m "feat(ui): Settings > Storage chooses SQLite or managed Postgres; store banner

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The Postgres perf gate, SPEC.md, the PR

**Files:**
- Modify: `src/main/state/stateBench.test.ts`, `docs/SPEC.md`

- [ ] **Step 1: Let the state bench run on Postgres**

Save as `/tmp/p4b_bench.py` and run `python3 /tmp/p4b_bench.py` from `$WT`. On SQLite the bench is unchanged, so part 3's A/B gate against origin/main still compares like with like.

```python
"""Part 4b Task 6: the state bench also runs on Postgres, and gates Postgres against SQLite. Run from the worktree root."""


def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected one {old[:70]!r}, found {s.count(old)}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


edit('src/main/state/stateBench.test.ts', [
    ("""// embed_insert_us_per_row needs db.insertEmbeddings (the batched insert),
// which exists at the pre-port baseline.""", """// embed_insert_us_per_row needs db.insertEmbeddings (the batched insert),
// which exists at the pre-port baseline.
//
// On Postgres (STORE_TEST_DIALECT=postgres + PG_TEST_URL) the same metrics run
// on a fresh schema; search_ms is db.searchEmbeddings. Gate saved Postgres
// runs against the PG_GATE budgets:
//   STATE_BENCH=1 STATE_BENCH_PG_GATE=/tmp/p1.json,/tmp/p2.json npx vitest run src/main/state/stateBench.test.ts"""),
    ("""import { PerfStore } from '../perfStore.js';""", """import { PerfStore } from '../perfStore.js';
import { isPg, testPgSchema } from '../store/testStore.js';"""),
    ("""const RUNS = 5;""", """const RUNS = Number(process.env.STATE_BENCH_RUNS ?? 5);"""),
    ("""function medianOfFiles(list: string): Metrics {""", """/** Postgres budgets (part 4b D51), in each metric's own unit. Reads stay
 *  within one 16 ms frame; ingest and writes pay a round trip and a commit per
 *  statement, so they get absolute budgets the watcher and IPC can absorb
 *  rather than a ratio to SQLite. */
export const PG_GATE: Record<string, number> = {
  ingest_fresh_us_per_line: 3000,
  ingest_replay_us_per_line: 1500,
  summary_uncached_ms: 16,
  summary_cached_us: 1000,
  lookup_mapping_us: 1000,
  events_page_ms: 16,
  list_sessions_ms: 16,
  read_round_stall_ms: 16,
  stall_max_ms: 50,
  search_ms: 50,
  record_mapping_us: 10_000,
  record_error_us: 10_000,
};

export function pgGateRows(pg: Metrics) {
  return Object.entries(PG_GATE).map(([metric, max]) => ({ metric, postgres: pg[metric], max, ok: pg[metric] <= max }));
}

function medianOfFiles(list: string): Metrics {"""),
    ("""  const dir = mkdtempSync(join(tmpdir(), 'cf-state-bench-'));
  const m: Metrics = {};
  try {
    const raw = db.openDb(dir);""", """  const dir = mkdtempSync(join(tmpdir(), 'cf-state-bench-'));
  const m: Metrics = {};
  const pg = isPg ? await testPgSchema() : null;
  try {
    const raw = pg ? null : db.openDb(dir);
    if (pg) await db.openDbPostgres(pg.pool);"""),
    ("""    for (let i = 0; i < 10; i++) searches.push(await time(() => searchTranscripts('q', allowed, embed, { limit: 10 }, raw)));""",
     """    for (let i = 0; i < 10; i++) {
      searches.push(await time(async () => raw
        ? searchTranscripts('q', allowed, embed, { limit: 10 }, raw)
        : db.searchEmbeddings((await embed(['q']))[0], [...allowed], { limit: 10 })));
    }"""),
    ("""    const probe = new PerfStore(raw as never);
    const store = 'flushChain' in probe""", """    const probe = new PerfStore((raw ?? db.stateKysely()) as never);
    const store = !raw ? probe : 'flushChain' in probe"""),
    ("""  } finally {
    await db.closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}""", """  } finally {
    await db.closeDb();
    await pg?.drop();
    rmSync(dir, { recursive: true, force: true });
  }
}"""),
    ("""    if (process.env.STATE_BENCH_BASELINE && process.env.STATE_BENCH_CANDIDATE) {""", """    if (process.env.STATE_BENCH_PG_GATE) {
      const rows = pgGateRows(medianOfFiles(process.env.STATE_BENCH_PG_GATE));
      console.log('STATE_BENCH_PG_GATE ' + JSON.stringify(rows, null, 2));
      expect(rows.filter((r) => !r.ok).map((r) => r.metric)).toEqual([]);
      return;
    }
    if (process.env.STATE_BENCH_BASELINE && process.env.STATE_BENCH_CANDIDATE) {"""),
])
print('ok')
```

- [ ] **Step 2: Measure and gate**

```bash
STATE_BENCH=1 STATE_BENCH_OUT=/tmp/s1.json npx vitest run src/main/state/stateBench.test.ts
STATE_BENCH=1 STORE_TEST_DIALECT=postgres STATE_BENCH_OUT=/tmp/p1.json npx vitest run src/main/state/stateBench.test.ts
STATE_BENCH=1 STATE_BENCH_PG_GATE=/tmp/p1.json npx vitest run src/main/state/stateBench.test.ts
```

Expected: the gate passes. Measured while writing this plan (this container, socket server, 3 runs, with other test runs competing):

| metric | SQLite | Postgres | budget |
|---|---|---|---|
| ingest_fresh_us_per_line | 95.9 | 1721.0 | 3000 |
| ingest_replay_us_per_line | 32.7 | 689.4 | 1500 |
| summary_uncached_ms | 2.62 | 13.7 | 16 |
| summary_cached_us | 10.5 | 340.3 | 1000 |
| lookup_mapping_us | 13.5 | 550.4 | 1000 |
| events_page_ms | 2.27 | 5.99 | 16 |
| list_sessions_ms | 0.87 | 4.58 | 16 |
| read_round_stall_ms | 5.93 | 1.21 | 16 |
| stall_max_ms | 77.0 | 18.2 | 50 |
| search_ms (5k rows) | 32.0 | 6.6 | 50 |
| record_mapping_us | 179 | 6050 | 10000 |
| record_error_us | 140 | 5606 | 10000 |

Put the table in the PR. The bench creates a schema per run, which `fleet_app` may not do, so the host measurement goes through a throwaway container with the managed image over Docker's loopback port:

```bash
docker run -d --rm --name fleet-bench -e POSTGRES_PASSWORD=bench -p 127.0.0.1:55432:5432 pgvector/pgvector:0.8.7-pg16
STATE_BENCH=1 STORE_TEST_DIALECT=postgres PG_TEST_URL=postgres://postgres:bench@127.0.0.1:55432/postgres \
  STATE_BENCH_OUT=/tmp/host-p1.json npx vitest run src/main/state/stateBench.test.ts
```

Ask Troy to run this on the host and to add the gate result to the PR.

- [ ] **Step 3: SPEC.md**

Save as `/tmp/p4b_spec.py` and run `python3 /tmp/p4b_spec.py` from `$WT`. It runs after part 4a's SPEC edits, whose §8 text it replaces.

```python
"""Part 4b Task 6: SPEC.md. Run from the worktree root (after part 4a's SPEC edits)."""


def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected one {old[:70]!r}, found {s.count(old)}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


edit('docs/SPEC.md', [
    # §4 Stack: the managed image.
    ("""| Postgres driver | `pg` + `pg-connection-string` |""",
     """| Managed Postgres | `pgvector/pgvector:0.8.7-pg16`, pinned by digest | The app-managed local store (§7 *Managed Postgres*): the same PG 16 + pgvector 0.8.7 the store suite and Aurora run, so one baseline serves all three. The digest (`store/managedPostgres.ts:MANAGED_PG_IMAGE`) changes only with an app release; a new digest recreates the container on the same volume. |
| Postgres driver | `pg` + `pg-connection-string` |"""),
    # §6 Settings: the store key is now settable for sqlite/managed.
    ("""- **store** — hand-edited only (no setter channel, not in `config:get`). Validated strictly by `store/storeConfig.ts:parseStoreConfig`: unknown keys are rejected, and errors name keys, never values.
  - **SQLite:** absent or `{ kind: 'sqlite' }` ⇒ the SQLite files.""",
     """- **store** — set by Settings → *Storage* for SQLite and the managed container (`store:setChoice`, below); an external Postgres block is hand-edited. Not in `config:get`. Validated strictly by `store/storeConfig.ts:parseStoreConfig`: unknown keys are rejected, and errors name keys, never values.
  - **SQLite:** absent or `{ kind: 'sqlite' }` ⇒ the SQLite files.
  - **Managed Postgres:** `{ kind: 'postgres', managed: true, poolMax? }` ⇒ the app-managed container (§7 *Managed Postgres*). No other key is allowed; the connection and password come from the container and the vault. `fleet-host`'s `db:` refuses it."""),
    # §6: the Store channels, before Model endpoints.
    ("""### Model endpoints (#250)""", """### Store (async store part 4b)
- `store:getSettings` → `StoreSettings { configured, active, restartRequired, status }`: `configured` is what config.json names now, `active` what this run opened (`'sqlite' | 'managed' | 'external'`), `status` the live `StoreStatus`.
- `store:setChoice(choice: 'sqlite' | 'managed')` → `StoreSettings`. Writes config.json `store` (removes the key for SQLite). Refused when config.json names an external Postgres, or is unreadable. Applies at the next start.
- `store:status` (main → renderer push) → `StoreStatus { choice, phase: 'ready' | 'starting' | 'importing' | 'down', detail, progress: { source, table, copied, total } | null, notice }`. SQLite is always `ready`.
- `app:relaunch` → quits (running the normal `before-quit` cleanup) and starts the app again.

### Model endpoints (#250)"""),
    # §7 Postgres store: managed container + first-switch copy.
    ("""There is no vector index; search is exact.""",
     """There is no vector index; search is exact.
- **Managed Postgres** (`store/managedPostgres.ts`, Docker via `store/managedDocker.ts`): `ensureManagedPostgres` runs at every start and on recovery, and is idempotent.
  - **Container:** `claude-fleet-postgres` from the pinned image (§4), labels `com.claude-fleet.store=postgres` and `com.claude-fleet.store.pg-major=16` (never `com.claude-fleet.managed`, which marks workspace containers). `RestartPolicy: no`. Data in the named volume `claude-fleet-postgres-data` (same labels) at `/var/lib/postgresql/data`, `initdb --locale=C.UTF-8 --encoding=UTF8`, database `fleet`.
  - **Port:** `5432/tcp` published on `127.0.0.1` at a host port picked free once and fixed in the container, so a restart keeps the pool's address. TLS is off: the connection never leaves loopback (part 3's loopback default).
  - **Bootstrap**, as the superuser over the container's own socket (`docker exec … psql`, local trust): role `fleet_app` (LOGIN, CREATEROLE) with the vault-held password set as a SCRAM verifier, schema `fleet` owned by it, `vector` in `public` (`ALTER EXTENSION vector UPDATE` too), and `ALTER ROLE postgres PASSWORD NULL`. The SQL rides an exec env var. The app then connects as `fleet_app`, like `fleet_agent` on the host.
  - **Health:** `pg_isready -h 127.0.0.1` inside the container (TCP: during initdb the entrypoint's temporary server listens on the socket only), up to 90 s; a Docker healthcheck runs the same.
  - **Upgrades:** a container from another image digest is stopped, removed and recreated on the same volume and port. A volume labelled with another major (or not labelled by the app) is refused with an error naming it; `pg_upgrade` isn't run.
  - **Stop:** best effort at quit (`docker stop -t 10`); Postgres's WAL makes an unclean stop safe.
- **First-switch copy** (`store/firstSwitch.ts`, `store/storeImport.ts`): after the stores migrate and before anything uses them, `inbox.db` then `state.db` are copied into an empty Postgres store with their ids. state.db is copied, not re-ingested: renames, tab mappings, usage signals and embeddings aren't in the transcripts, and summaries reference event ids.
  - **Per table:** keyset by SQLite `rowid` in chunks bounded by 30 000 bind parameters; each chunk commits with its progress row in `store_import(source, tbl, last_rowid, copied, done)` (track `import`), so a failed or interrupted copy resumes. At a table's end its row count must equal SQLite's, and every identity column's sequence is `setval` to its max id.
  - **Restart, not resume,** when the file's fingerprint (size and mtime of the file and of a non-empty WAL) changed since the run began (`store_import_run`): the source tables are truncated and copied again. Only the import writes them until it finishes.
  - **Refused:** a target that already holds rows the import didn't write (`skipped-nonempty`: nothing is written, Settings shows a notice), and a SQLite file at another schema version.
  - **After:** `inbox.db` (with `-wal`/`-shm`) is renamed `inbox.db.migrated-<epochMs>`; `state.db` stays as the cache a switch back to SQLite resumes from. Nothing is copied back to SQLite."""),
    # §7 Vault layout: the store bag.
    ("""### Model endpoint registry (on disk)""", """The vault also holds the **managed Postgres password** (async store part 4b):
- **Scope and key:** scope `store:managed` (`vaultScopes.MANAGED_STORE_SCOPE`), key `APP_PASSWORD`: the `fleet_app` role's password, minted on first start.
- **No read path:** `store:` is host-only like `identity:`, and a reserved workspace-id prefix.
- **Lost vault:** the next start mints a new password and the bootstrap sets it (the superuser needs none), so the data survives.

### Model endpoint registry (on disk)"""),
    # §8 Startup: the supervisor replaces the launch-blocking dialog for connection failures.
    ("""   - **Postgres** opens both stores on one pool (`openPgStores`) and starts the MCP server on the Postgres read source (§11 *History reads*), provisioning `query` isolation first (§9). Pool errors are logged as `store-pool-error`; an `aws-rds-iam` auth failure (28P01/28000) carries a hint that names no secret.
   - **A configured Postgres that can't open** (unreachable within the 10 s connect timeout, missing schema, missing pgvector, invalid `store` block) stops the launch with a Quit-only error dialog naming the key to remove. It never falls back to SQLite, which would split the data.""",
     """   - **Postgres** (managed or external) doesn't hold the launch. The window, workspaces, terminals and the MCP server start at once; the MCP history tools answer "unavailable" until the store is ready. `StoreSupervisor` (`store/storeSupervisor.ts`) then:
     1. **opens** the store: `ensureManagedPostgres` (managed), then `openPgStores` with the `state`, `inbox` and `import` migrations. A failure is `down` with its reason (`store-open-failed`) and retries after 1 s, doubling to 30 s.
     2. **copies** on the first switch (§7 *First-switch copy*), reporting `importing` progress.
     3. **readies** the store-backed services, once: `openDbPostgres` (which rehydrates pending mappings from the copied rows), the error sink and perf telemetry, the MCP read source with `query` isolation (§9), the JSONL watcher, the embedding backfill, the inbox/notification/automation IPC and presence; then it broadcasts `inbox:changed`.
     4. **watches** with `SELECT 1` every 5 s (3 s timeout). A failure is `down` (`store-unreachable`, once per outage); for the managed store it also runs `ensureManagedPostgres` to restart a stopped container. The next good ping is `ready` again: the watcher re-reads every known transcript from its offset (`requeueAll`; a failed batch never advanced it) and `inbox:changed` is broadcast.
   - **While not ready** the renderer shows a store banner beside the daemon banner (`.app-banners`): *Starting the Postgres store*, *Copying your history to Postgres: <table>, n of m rows*, or *Postgres store unreachable* with the reason. Store-backed calls fail rather than fall back; it never falls back to SQLite, which would split the data. Pool errors are logged as `store-pool-error`; an `aws-rds-iam` auth failure (28P01/28000) carries a hint that names no secret.
   - **An invalid `store` block** stops the launch with a Quit-only error dialog naming the key to remove.
   - **Mock mode** ignores `store` and uses SQLite."""),
    # §9: the renderer can now choose, never configure credentials.
    ("""  - **Renderer:** `config.json` `store` has no IPC channel and isn't in `config:get`, and the desktop refuses plaintext secrets in it (§6 *Settings*). Credentials come from env vars or `aws-rds-iam`.""",
     """  - **Renderer:** `store:setChoice` can write only `sqlite` or the managed form, never a connection or credential; `store` isn't in `config:get`, and the desktop refuses plaintext secrets in it (§6 *Settings*). External credentials come from env vars or `aws-rds-iam`.
  - **Managed container:** its `fleet_app` password lives in the vault (`store:managed`, host-only) and reaches Postgres only as a SCRAM verifier inside a `docker exec` env var. The superuser has no password, the port is bound to `127.0.0.1`, and nothing in a workspace's env names the store."""),
])
print('ok')
```

- [ ] **Step 4: Final gate, push, PR, auto-merge**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run typecheck:host
CI=true npx vitest run src
CI=true npm run test:unit:pg
git -C "$WT" diff origin/main -- src/main/__snapshots__/ | head     # expect no output
git -C "$WT" add src/main/state/stateBench.test.ts docs/SPEC.md
git -C "$WT" commit -m "docs(spec): managed Postgres, Settings > Storage, first-switch copy, degraded state; Postgres perf budgets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$WT" push -u origin feat/async-store-p4b
gh pr create -R ImIOImI/claude-fleet --head feat/async-store-p4b --title "feat(store): async store part 4b: managed Postgres, Settings > Storage, first-switch copy" --body-file /tmp/p4b_pr.md
gh pr merge -R ImIOImI/claude-fleet --auto --squash feat/async-store-p4b
```

The PR body (`/tmp/p4b_pr.md`) states, factually:
- **What changed:** D45–D52.
- **Blast radius:** SQLite users see no change; Postgres is opt-in from Settings.
- **How it was tested:** both suites, the copy mutation table and the bench table.
- **Not testable here:** the real container. It needs Docker, so Troy's host checks are:
  1. Pick managed Postgres, then restart.
  2. The banner shows *Starting*, then *Copying*, then nothing.
  3. Todos and history are present; `inbox.db.migrated-*` exists.
  4. Quit Docker: the banner shows *unreachable*. Start Docker again: it clears, and new transcript lines ingest.
  5. MCP `query` from a container workspace returns only its rows.
  6. Switch back to SQLite.
- **Footer:** end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review notes

- **The outline and the request, item by item:**
  - *App-managed container (start/stop, volume, vault credentials, health, upgrade-safe):* Task 2 (D45–D47). Wired in by Task 4.
  - *Settings → Storage:* Task 5 (D48). The external option is hand-edited only; the reason is in D48.
  - *First-switch copy:*
    - inbox copied, and state copied rather than re-ingested, with the reason (D49);
    - `setval` (S1);
    - progress, resumable (S4) and safe to restart (S2, S5);
    - never loses data (read-only source, count check S6, rename after success, the non-empty refusal S3).
  - *Degraded banner:* Tasks 4–5 (D50).
  - *SQLite unchanged:* Task 4 Step 7, the unchanged SQLite bench, and both full suites.
  - *No plaintext secrets:* D47. *TLS on loopback:* D46. *Env scrub:* Task 1's `storeSecretEnvNames` test.
- **Names used across tasks:**
  - `ManagedStoreConfig`, `ensureManagedPostgres(deps, poolMax)`, `dockerodeManagedDocker()` and `IMPORT_PG_TRACK`.
  - `importSqlite`, `firstSwitchCopy({ pool, userData, state, onProgress })` and `StoreSupervisor<PgStores>`.
  - `pingStore(pool)`, `requeueAll()`, `setStoreChoice`, `registerStoreIpc`, `setActiveStore`, `storeChoiceOf` and `broadcastStoreStatus`.
  - The renderer API is `window.api.store.*`.
- **Deliberately not here:**
  - A UI for an external Postgres (D48).
  - Copying back to SQLite (D49).
  - `pg_upgrade` across Postgres majors (D45).
  - HNSW (part 4a D44).
