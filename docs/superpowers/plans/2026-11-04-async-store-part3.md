# Async store layer, part 3: the Postgres dialect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the same async stores (`state.db`'s `db.ts`, the inbox stores) on Postgres as well as SQLite, chosen by config, with per-dialect migrations, pgvector search, password providers (`static` / `env` / `aws-rds-iam`) with verify-full TLS, the #491 carry-overs, and the whole store test suite passing on both dialects in CI. SQLite behaviour is unchanged.

**Architecture:** A second Kysely dialect (`src/main/store/postgres.ts`) wraps one `pg` pool shared by both stores. It parses `int8`/`numeric` as numbers, sets `search_path` per connection, and serializes in-process writes behind a per-store lock, as the SQLite connection mutex did, while reads run concurrently. Postgres gets a baseline schema equal to today's final SQLite schemas plus a migration track per store. SQLite's `migrate()` chain is untouched. `openPgStores(config)` opens both stores from a validated `store` config, and `index.ts` uses it when `config.json` names Postgres. The characterization snapshots recorded on SQLite are the arbiters on Postgres too.

**Tech Stack:** TypeScript, Electron main (CJS bundle via electron-vite), better-sqlite3 13, kysely 0.28.x, `pg` 8.23, pgvector 0.8, `@aws-sdk/rds-signer` + `@aws-sdk/credential-providers` 3.1162.0, vitest 4, Postgres 16.

**Spec:** `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §7 *Data architecture* (*One store layer*, connection config), §11 sub-project (a), §12 (a). Design-state `/shared/remote-agent-design/design-state.md` (DB credentials and address, 2026-11-03). This plan refines the *Part 3* outline at the end of `docs/superpowers/plans/2026-11-02-async-store-part1.md` and covers GitHub issue #491. It provides the seam that `docs/superpowers/plans/2026-11-04-remote-c-3-host-store.md` (C3-2, C3-3) plugs into. SPEC.md §4 *Stack*, §6 *Settings*, §7 *JSONL→SQLite cache* and *Inbox store*, §8 *Startup*, §11 *In-container SQLite access via MCP*.

## Global Constraints

From the spec (§7, §11 (a)), verbatim:

- "**The local DB is the user's choice at setup** (`config.json` `store`): **SQLite** (default): today's `state.db` and `inbox.db`. Needs no setup and works without Docker."
- "`db.ts`, `inboxDb.ts` and the stores built on them (`automationStore.ts`, `proposalStore.ts`, `notifyStore.ts`) move behind one **async** store interface. It's written once with **Kysely** against both dialects (better-sqlite3 and `pg`)."
- "Migrations are per dialect where the SQL differs (`AUTOINCREMENT` vs identity columns, BLOB vs `vector`), driven from one migration list."
- "**Vector search is per backend.** SQLite keeps today's brute-force cosine search over Float32 BLOBs (`vectors.ts`). Postgres uses pgvector (`vector(384)`, cosine distance, an HNSW index). Both sit behind `searchEmbeddings(query, scope, limit)`."
- "`fleet-host` uses the same store layer, always on Postgres."
- "**Connection config: a connection string or fields, plus a password provider.** A connection string (`connectionString: 'postgres://user:pass@host:5432/db?sslmode=…'`, or `env: DATABASE_URL`) is the simple path. … Or discrete fields (`host`, `port`, `database`, `user`, `ssl`) plus `password: { kind: 'static' | 'env' | 'aws-rds-iam' }`. The pool calls the provider on **every new connection** (the `pg` pool's async `password` function)."
- "**On AWS, use `aws-rds-iam`.** It mints a 15-minute token with the RDS signer from the pod's workload identity, so no long-lived DB password exists."
- "MCP `query` isolation on local Postgres (role + RLS) ships here [in (a)], because the local Postgres choice needs it." / "*Ships:* users can pick Postgres locally. SQLite behaviour is unchanged." (Part 3 ships the dialect; part 4 ships the pick and the isolation: D20.)

From design-state (2026-11-03), verbatim:

- "The `aws-rds-iam` password provider must use the SDK's default Node chain (container credentials: `AWS_CONTAINER_CREDENTIALS_FULL_URI` + `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`), pinned to an SDK release with Pod Identity support (verify the minimum at implementation), with a unit test against a fake credentials endpoint."
- "fleet-host connects to the real Aurora cluster writer endpoint, set in Helm values. IAM tokens are signed for that exact hostname (a Route53 alias can't be signed; any future alias needs resolve-then-sign). Use `sslmode=verify-full`, which means **the host image must ship the AWS RDS CA bundle** (`global-bundle.pem`) and the pg client must be pointed at it."
- The host's DB user `fleet_agent` migrates inside its own schema `fleet`, which infra creates by hand (c3 open item 1: "the writer endpoint, region, IAM user `fleet_agent`").

From parts 1, 2a and 2b (still binding):

- **SQLite behaviour is unchanged:**
  - The same `state.db` and `inbox.db` files, the same `migrate()` SQL (v1–v14) and `MIGRATIONS` (1–5), the same rows and the same `inbox.db.bak-v<old>-<epochMs>` backup.
  - Every IPC channel name, payload and return shape stays the same. No renderer or preload change.
  - **2a's ingest characterization snapshot (`src/main/__snapshots__/dbIngestBatch.test.ts.snap`) and 2b's read characterization snapshot (`src/main/__snapshots__/dbReadCharacterization.test.ts.snap`) are the arbiters,** on both dialects. The only allowed change is the one documented #491 update in Task 3 (`0.7534357500000001` → `0.75343575`). Never run `vitest -u` on either.
- **Dialect-neutral queries in store code:** no `IFNULL`, no multi-argument `MAX(a, b)`, no `INSERT OR IGNORE`, no `lastInsertRowid`, no SQLite bare-column aggregates. Wrap every `COUNT`/`SUM`/`MAX` result in `num()`. Qualify columns in `ON CONFLICT … DO UPDATE`. Part 3 adds: every list read has a total `ORDER BY`, and nullable sort keys say `nullsFirst()` (D26). Dialect branches live only in `src/main/store/*` and the two vector spots in `db.ts` (D30).
- **Transactions await only `trx`.** Inside `kysely.transaction().execute(async (trx) => …)`, use only `trx` and helpers that take a `q` argument. On Postgres an outer-handle **write** inside a write transaction waits on the write lock the transaction holds, and deadlocks, exactly as on the SQLite mutex.
- **Check-then-act stays atomic.** A read followed by a dependent write is one transaction or one guarded statement. In-memory mirrors (`pendingClaudeIds`) are mutated inside the transaction callback after its last `await`. Cache invalidation runs after commit.
- **No `.then(onFulfilled, onRejected)`.** Use `await`/`try`, `.catch()` alone, or a single-argument `.then(fn)`.
- **No N+1.** Never add a per-row or per-workspace query loop where one statement or a `chunked()` IN-list does.
- **Keep every commit shippable:** each task ends green on both `tsc` configs, the full SQLite unit suite, and the Postgres suite as it stands at that task.
- **`mcpServer.ts` read path is out of scope** apart from Task 9's start-without-state.db switch (D34). Its `{ readonly: true }` connection, `buildSnapshot` and `searchTranscripts(…, db)` stay as they are (D1, D14).
- **Never `npm install` into `/workspace/claude-fleet/node_modules`** (the shared base checkout). Work in your own worktree.
- **Typecheck every config separately:** `npx tsc --noEmit -p tsconfig.node.json`, `npx tsc --noEmit -p tsconfig.web.json`, and (since c1, #493) `npm run typecheck:host`. The task steps name the first two; run the third with them.
- **`tsc` cannot see a missing `await`** on a call whose result is unused. Tasks 4 and 5 list a `/usr/bin/grep` check; inspect each hit.
- **CI (`build-app.yml`: `unit (vitest)` + build + e2e) is the real gate.** From Task 1 the unit job also runs the Postgres suite. The container can't run Electron; Troy eyeballs the app on the host after merge.
- **Every commit message ends with** `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **SPEC.md is updated in the same PR** (Task 10).
- **Comments are terse and necessary** (`/workspace/.claude/rules/review-conventions.md`): no restating, no PR/ticket narrative in code.

## Decisions

D1–D19 from parts 2a and 2b still bind. The ones part 3 leans on: **D1** (the MCP read path stays raw better-sqlite3), **D9/D18** (A/B perf gate and its tolerances), **D11** (in-flight cache rules), **D12** (multi-query reads in one read transaction) and **D14** (`searchTranscripts` stays raw). New in part 3, recorded in SPEC.md by Task 10:

- **D20 — The split.** The spec's sub-project (a) is split between part 3 and part 4.
  - **Part 3 (this plan):**
    - the Postgres dialect, per-dialect migrations and the store factory chosen by `config.json` `store`;
    - the password providers (`static` / `env` / `aws-rds-iam`), verify-full TLS and the RDS CA bundle script;
    - pgvector search and the #491 carry-overs;
    - the whole store test suite on Postgres, locally and in CI.
  - **Part 4 (outlined below):** the app-managed Postgres container, the Settings → *Storage* choice and first-switch copy, the Docker-down degraded state, and MCP on Postgres (typed tools on a `ReadSource` plus `query` isolation by role + RLS).
  - pgvector is in part 3 because the Postgres `embeddings` table's column type is fixed by the baseline, and #491 asks for it.
  - **Part 3 ships two things:**
    - a working Postgres store for `fleet-host` (c3's C3-2 and C3-3 consume it);
    - a hand-configured desktop Postgres store. This is a preview: no UI, and MCP history tools are unavailable on it (D34).
- **D21 — Concurrency on Postgres:**
  - **Writes:** each store's Kysely handle serializes in-process writes behind its own lock (`writeLock()` in `postgres.ts`), covering read-write transactions and bare `INSERT`/`UPDATE`/`DELETE`/raw statements.
  - **Reads:** reads and read-only transactions run concurrently on the pool.
  - **Why:**
    - It keeps 2a's invariants (serialized check-then-act, `pendingClaudeIds` mutated in-transaction) without `SERIALIZABLE` retry loops.
    - A summary or list read never waits behind an ingest chunk, which is ~2,000 statements over a network round trip.
    - Raw `sql` counts as a write, so `closeDb()`'s `select 1` still waits for in-flight write transactions.
- **D22 — Postgres schema = a baseline plus steps:**
  - **Baseline:**
    - Postgres starts from a baseline equal to the final SQLite schemas: `state` at v14 (`STATE_PG_BASELINE`) and `inbox` at v5 (`INBOX_PG_BASELINE`).
    - The baseline maps types as follows:

      | SQLite | Postgres |
      |---|---|
      | `INTEGER` | `BIGINT` |
      | `REAL` | `DOUBLE PRECISION` |
      | every `TEXT` | `TEXT COLLATE "C"` (byte order, as SQLite compares; independent of the server locale) |
      | `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` |
      | `IFNULL` in the `todos_dedupe` expression index | `COALESCE` |
      | the `embeddings.vec` BLOB | `vector(384)` |

  - **Migration state:** versions live in `schema_migrations(track, version)`. One transaction per run, under `pg_advisory_xact_lock`, so two host pods can't both migrate.
  - **Later changes:** a later schema change is a `{ version, postgres }` step in the track's `steps`, landing in the same commit as the matching SQLite `migrate()`/`MIGRATIONS` step. That is the spec's "one migration list".
  - **SQLite untouched:** SQLite's v1–v14 chain and inbox `MIGRATIONS` are left as they are.
  - **Drift guard:** `schemaParity.test.ts` pins each baseline to the SQLite schema it mirrors: tables, columns, NOT NULL, primary and unique keys.
- **D23 — The store never creates its schema or extension:**
  - The schema (default `fleet`) must exist, as with `fleet_agent`. `migratePostgres` checks `current_schema()` equals it.
  - Why the check: with `search_path = fleet, public`, a missing `fleet` makes unqualified DDL land in `public`. The prototype did exactly that.
  - pgvector ≥ 0.8.0 (iterative index scans) must be installed. `ensureVector` creates it when the role may. Otherwise it fails, naming the admin step.
- **D24 — `search_path`** is set by an explicit `SET search_path TO <schema>, public` once per physical connection, in the pool adapter.
  - Why not a startup `options` parameter: poolers and some servers drop it. PGlite ignored it in the prototype.
  - Why `public`: so extension types resolve.
- **D25 — Type parsing per pool.** `int8` and `numeric` parse as `number`, as SQLite returns them. The values are epoch ms and token counts, all below 2^53. The parsers go on the pool's `types`, never pg's global registry.
- **D26 — Result-order parity.** Every list read has a total `ORDER BY`, and nullable keys sort `NULLS FIRST`, SQLite's default. This found and fixes:
  - **#491 canonical cost-row order:**
    - `listSessionCostsQuery` orders by `(session_id, workspace_id, model, service_tier)`.
    - `listSessions`' per-session USD float sum becomes order-independent of storage.
    - This is the one deliberate snapshot change: `0.7534357500000001` → `0.75343575`.
  - **#491 latest-session tiebreak:**
    - `latestSessionId`, `listSessions` and `listSessionIds` break `COALESCE(last_active_at, 0)` ties by `id ASC`.
    - `ASC` was chosen because it reproduces both recorded snapshots unchanged.
    - Ties used to follow SQLite's rowid order; on Postgres they were arbitrary.
  - **`planUsageRows`:** it had no `ORDER BY`. SQLite's `GROUP BY` returned sorted groups; Postgres's hash aggregate didn't.
  - **`costForSessionQ`/`costForWorkspace`:** they ordered by the `nullif(model, '')` output alias, where NULL sorts last on Postgres. They now order by the raw key columns, where `''` sorts first on both dialects.
- **D27 — The SQLite snapshots arbitrate Postgres.**
  - The Postgres suite runs the same test files against the same `.snap` files with `CI=true`, so nothing is ever written.
  - Event ids match too: both engines consume an id on a conflicting `INSERT … ON CONFLICT DO NOTHING`.
  - New snapshots (Task 6) are recorded on SQLite first.
- **D28 — The test harness:**
  - **Selection:** `STORE_TEST_DIALECT=postgres` plus `PG_TEST_URL` select Postgres. Each test gets a fresh schema (`testPgSchema()`), dropped afterwards.
  - **Suite config:** `vitest.pg.config.ts` lists the store suite, with 30 s timeouts. Its globalSetup creates the extension once and drops stale `t_*` schemas.
  - **Helpers:** tests open the store through `openTestState()` / `openTestInbox()` and read raw rows with `queryRows(sql, params)` (`?` placeholders on both dialects). The N+1 guards count statements on either dialect (`countQueries`). Timer-driven service tests wait with `settle()`.
  - **SQLite-only tests** skip on Postgres (`isPg`): raw-handle sharing, `EXPLAIN QUERY PLAN` pins, the inbox file backup, the v12 repair, `PRAGMA` checks, the MCP read path and the watcher integration tests.
- **D29 — Postgres in this container is a real PG 16 without Docker.**
  - **Why no Docker:** this container has no docker CLI or socket.
  - **What runs instead:** `scripts/pg-test-server.sh` runs PG 16.15 server binaries from `@embedded-postgres/linux-*` (npm), with pgvector 0.8.7 from the PGDG bookworm `.deb`, on a Unix socket. It installs into `/tmp`, never into the repo.
  - **Rejected, PGlite + pglite-socket:**
    - It crashed (wasm `unreachable`) on protocol messages above ~60 KB, which one `insertEmbeddings` batch exceeds.
    - It serves one connection at a time and ignores startup parameters.
    - It is PG 17/18, not 16.
  - **Rejected, pg-mem:** no pgvector, partial SQL.
  - **CI:** a `pgvector/pgvector:0.8.7-pg16` service container. This corrects c3's outline, which said `pg17`; Aurora is PG16.
- **D30 — Embeddings on Postgres:**
  - **Column and index:** `vec vector(384)` with an HNSW `vector_cosine_ops` index, partial `WHERE text <> ''`. Placeholder zero vectors have empty text and a NaN cosine.
  - **Search:**
    - `searchEmbeddings(qvec, scope, { limit, kind })` is the per-dialect search: brute-force dot product on SQLite, HNSW on Postgres. The query is taken as a vector so the embedder stays out of `db.ts`.
    - `SET LOCAL hnsw.iterative_scan = strict_order` keeps the `workspace_id`/`model_id`/`kind` filters from truncating results.
    - The score is `1 − cosine distance`, which equals the dot product for the unit vectors the embedder produces. Ties break by `id`.
  - **MCP:** `search_transcripts` keeps `searchTranscripts(…, db)` on the SQLite read-only connection (D14). On Postgres it is unavailable until part 4 points it at `searchEmbeddings`.
  - **Tests:** test vectors are full-width, because `vector(384)` rejects other dimensions.
- **D31 — Store config:**
  - **Where:** `config.json` `store`, hand-edited only. There is no IPC channel or UI (part 4).
  - **Shapes:**
    - `{ kind: 'sqlite' }` (the default when absent);
    - `{ kind: 'postgres', connectionString | env | host, port?, database, user, password, ssl?, caFile?, schema?, poolMax? }`.
  - **Defaults:** `schema 'fleet'`, `poolMax 4`, `port 5432`, `ssl 'verify-full'`.
  - **Secrets:**
    - The desktop refuses plaintext secrets in `config.json` (a `static` password, or a password inside `connectionString`), because `config.json` is not secret storage (SPEC §9).
    - `fleet-host` allows them (`allowStaticSecrets: true`): its config is a mounted secret.
  - **Rules:**
    - `aws-rds-iam` needs `verify-full`.
    - An invalid `store` is an error at startup, never a silent SQLite fallback, which would split the data.
- **D32 — Credentials and TLS:**
  - **Providers:** `passwordProvider(source, { host, port, user })` returns pg's async `password` function, called per new connection.
  - **`aws-rds-iam`:**
    - It uses `@aws-sdk/rds-signer`'s `Signer` with `fromNodeProviderChain()`, which includes the container provider: Pod Identity via `AWS_CONTAINER_CREDENTIALS_FULL_URI` + `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`.
    - The token is signed for the configured host and port as given, with no alias resolution.
    - Both SDK packages are pinned exactly at `3.1162.0`. A unit test against a fake container-credentials endpoint is the proof that the pinned chain supports Pod Identity.
  - **TLS:** `verify-full` means the CA from `caFile` plus Node's hostname check.
  - **The RDS CA bundle:** `docker/scripts/rds-ca-bundle.sh <dest>` fetches `global-bundle.pem` and checks it against the sha256 pinned in `docker/versions.yaml`. c3's host image runs it (F4). A desktop user points `caFile` at their own copy.
- **D33 — Startup on Postgres:**
  - **One pool, one schema:** both stores share one pool and one schema. The table names don't collide.
  - **Files:** `state.db` and `inbox.db` are not opened.
  - **Failure:** a configured Postgres that fails to open stops the launch with an error dialog that names the `store` key to remove. Pool `error` events are logged (`store-pool-error`), because without a listener pg crashes the process. Part 4 replaces the dialog with the degraded-mode banner.
- **D34 — MCP on the Postgres store (part 3):**
  - The server starts without the read-only `state.db` connection (`startMcpServer(dir, { stateDb: false })`).
  - The nine tools that read it return `<tool> is unavailable on the Postgres store` as a tool error: `list_sessions`, `get_session`, `get_cost`, `list_events`, `search_transcripts`, `session_summary`, `list_errors`, `query` and `mark_useful`.
  - Every other tool works. Part 4 brings them back on Postgres.
- **D35 — Latest-wins summary pushes (#491).** `latestWins()` gives the `'ingest'` push and the trailing re-broadcast one per-workspace sequence. A push that resolves after a later one for the same workspace began is dropped.
- **D36 — The seam c3 plugs into:**
  - Its pieces are `parseStoreConfig(v, { allowStaticSecrets: true })`, `pgPoolConfig`, `createPgPool`, `openPgStores(cfg, { state: true, afterBeginWrite })`, `migratePostgres(k, schema, track)` (a `host` track for `host_meta`/`host_lease`) and `PgStores.pool`.
  - `afterBeginWrite` (`WriteHook`) runs first in every read-write transaction and around every bare write. A throw rolls back. That is F3's `withFence`, with no store-code change.
  - C3-2's `src/main/store/passwordProvider.ts` is created here.
- **D37 — Perf gate:**
  - SQLite only, the same A/B method (D9) and tolerances (D18), with `origin/main` as the baseline.
  - Postgres has no users by default in part 3, so its speed isn't gated here; part 4 measures the managed container.
  - The prototype's gate passed (Task 10 lists the numbers).
- **D38 — Dependencies:**
  - `pg` `^8.23.1` and `@types/pg` `^8` (dev).
  - `@aws-sdk/rds-signer` and `@aws-sdk/credential-providers` pinned at `3.1162.0`. They add about 8 MB of JS (`@aws-sdk` + `@smithy`) to the package, externalized like every main dependency.
  - Nothing native.

## Inventory: what differs on Postgres, and where it is handled

Found by running the whole store suite on PG 16 in the prototype:

| Difference | Symptom on Postgres | Handled in |
|---|---|---|
| `COUNT`/`SUM`/`BIGINT` come back as strings | every count and id would be a string | `pgTypes` (Task 1, D25) |
| `GROUP BY` output order isn't sorted | `planUsageRows` order changes | explicit `ORDER BY` (Task 3, D26) |
| NULL sorts last | `costFor*` and `planUsageRows` row order changes | `nullsFirst()` or raw key columns (Task 3) |
| heap order isn't insertion order | `listSessions` USD last digit, tied sessions | #491 order and tiebreak (Task 3) |
| READ COMMITTED per statement | a summary could mix pre- and post-ingest rows | `readTransaction` (REPEATABLE READ, Task 3) |
| reads and writes really run concurrently | invalidate-during-recompute, out-of-order pushes | D11 (already), `latestWins` (Task 7) |
| no BLOB vectors | `insertEmbeddings` | `vector(384)` + literal (Tasks 2, 6) |
| `CREATE EXTENSION` races across parallel test files | `duplicate key … pg_extension_name_index` | `pgGlobalSetup.ts` (Task 1) |
| missing schema + `search_path` | baseline DDL lands in `public` | `migratePostgres` schema check (Task 2, D23) |
| an idle-client error event | process crash | `pool.on('error')` (Task 9) |
| locale collation (`en_US.utf8` in the CI image) | text sort order differs from SQLite | `COLLATE "C"` (Task 2, D22) |
| `INSERT OR IGNORE` in one test | syntax error | `ON CONFLICT DO NOTHING` (Task 4) |
| per-statement I/O in timer-driven tests | 3 `setImmediate` turns aren't enough | `settle()` (Task 5) |

## Verification environment (do this once, before Task 1)

```bash
git -C /workspace/claude-fleet fetch -q origin
WT=/workspace/claude-fleet/.claude/worktrees/async-store-p3
git -C /workspace/claude-fleet worktree add -b feat/async-store-p3 "$WT" origin/main
cd "$WT"
npm ci --ignore-scripts                                  # worktree-local node_modules
printf 'electron-stub' > node_modules/electron/path.txt  # lets `import { app } from 'electron'` load in vitest
npx vitest run src/main/db.test.ts                       # baseline: expect PASS
npx tsc --noEmit -p tsconfig.node.json; echo "node tsc exit $?"   # expect 0
npx tsc --noEmit -p tsconfig.web.json;  echo "web tsc exit $?"    # expect 0
npm run typecheck:host;                  echo "host tsc exit $?"   # expect 0
```

Never `cd /workspace/claude-fleet` from inside the worktree. Use `$WT` paths or `git -C "$WT"`. Every command below runs from `$WT`.

If the test run fails with "Module did not self-register", run `(cd node_modules/better-sqlite3 && npx --yes prebuild-install)` once.

Known flakes on unchanged `origin/main` in this container: `src/main/mcpLocalBridge.run.test.ts` (timing) and `src/main/jsonlWatcher.ordering.test.ts > stop() resolves only after every queued batch has finished`. If one of those is the only failure, re-run that file: three clean passes in a row mean it's the flake.

**Postgres.** Task 1 adds `scripts/pg-test-server.sh`. After Task 1, start it once per session:

```bash
eval "$(scripts/pg-test-server.sh start)"   # exports PG_TEST_URL (Unix socket under /tmp/fleet-pg-test)
```

Where Docker works, this is equivalent: `docker run -d --name fleet-pg -e POSTGRES_PASSWORD=fleet -p 5432:5432 pgvector/pgvector:0.8.7-pg16` with `export PG_TEST_URL=postgres://postgres:fleet@localhost:5432/postgres`.

Two runs gate every task:

```bash
CI=true npx vitest run src                     # SQLite: the whole unit suite
CI=true npm run test:unit:pg                   # Postgres: the store suite (vitest.pg.config.ts)
```

`CI=true` matters for both. It stops vitest from writing snapshots, so the SQLite-recorded snapshots arbitrate Postgres (D27).

**Edit helpers.** Save these once. Tasks apply exact replacements with `edit()` (each `old` must occur exactly `count` times, or it stops) and grow the Postgres suite with `add_pg_suite()`:

```bash
cat > /tmp/p3_edit.py <<'PYEOF'
"""Exact-replacement edits for the async-store part 3 plan. Run from the worktree root."""
import re


def edit(path, pairs):
    """Apply (old, new, count) replacements; each old must occur exactly count times."""
    s = open(path).read()
    for old, new, count in pairs:
        n = s.count(old)
        assert n == count, f'{path}: expected {count} of {old[:80]!r}, found {n}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


def add_pg_suite(*files):
    """Add test files to vitest.pg.config.ts's include list, kept sorted."""
    path = 'vitest.pg.config.ts'
    s = open(path).read()
    m = re.search(r'(    include: \[\n)(.*?)(\n    \],)', s, flags=re.S)
    have = set(re.findall(r"'([^']+)'", m.group(2)))
    have.update(files)
    body = '\n'.join(f"      '{f}'," for f in sorted(have))
    open(path, 'w').write(s[:m.start()] + m.group(1) + body + m.group(3) + s[m.end():])
PYEOF
```

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/store/postgres.ts` (new) | The Postgres dialect: `createPgPool`, `pgTypes`, `schemaOf`, `writeLock`, the serializing driver, the `WriteHook`, `postgresKysely`. |
| `src/main/store/pgMigrate.ts` (new) | `migratePostgres(k, schema, track)` and `ensureVector(k)`. |
| `src/main/store/migrations/statePg.ts`, `inboxPg.ts` (new) | The Postgres baselines for `state` (v14) and `inbox` (v5). |
| `src/main/store/kysely.ts` | Adds `readTransaction`. |
| `src/main/store/storeConfig.ts` (new) | `parseStoreConfig`, `pgPoolConfig`, the `StoreConfig` types. |
| `src/main/store/passwordProvider.ts` (new) | `static` / `env` / `aws-rds-iam` password functions. |
| `src/main/store/pgSsl.ts` (new) | `pgSsl(mode, caFile)`. |
| `src/main/store/pgStores.ts` (new) | `openPgStores(cfg, opts)`: one pool, both stores. |
| `src/main/store/testStore.ts`, `pgGlobalSetup.ts` (new) | Test support: dialect selection, per-test schemas, `queryRows`, `countQueries`, `settle`; the suite's one-time setup. |
| `vitest.pg.config.ts` (new) | The store suite on Postgres. |
| `scripts/pg-test-server.sh` (new) | Local PG 16 + pgvector without Docker (D29). |
| `src/main/db.ts` | `openDbPostgres`, dialect-aware `closeDb`, vector insert, `searchEmbeddings`, result-order fixes, `readTransaction` for the summary and `listSessions`. |
| `src/main/inbox/inboxDb.ts` | `InboxStore.openPostgres`. |
| `src/main/config.ts` | `store` kept verbatim; `getStoreConfig()`. |
| `src/main/index.ts` | Opens the Postgres stores when configured; the startup failure dialog; pool shutdown. |
| `src/main/mcpServer.ts` | `startMcpServer(dir, { stateDb })` (D34). |
| `src/main/observabilityBroadcast.ts`, `src/main/ipc.ts` | `latestWins` on both summary pushes. |
| `src/main/state/ingestFixture.ts` | `dump()` reads through Kysely, so both dialects can snapshot. |
| `docker/scripts/rds-ca-bundle.sh` (new), `docker/versions.yaml` | The RDS CA bundle, sha256-pinned. |
| `.github/workflows/build-app.yml` | The Postgres service and the `test:unit:pg` step in the unit job. |
| Test files listed in Tasks 3–5 | Open the store through the harness and run on both dialects. |
| `docs/SPEC.md`, the c3 outline | Task 10. |

---

### Task 1: The Postgres dialect seam, local Postgres, and the CI Postgres run

**Files:**
- Create: `src/main/store/postgres.ts`, `src/main/store/postgres.test.ts`, `src/main/store/testStore.ts`, `src/main/store/pgGlobalSetup.ts`, `vitest.pg.config.ts`, `scripts/pg-test-server.sh`
- Modify: `package.json`, `package-lock.json`, `.github/workflows/build-app.yml`

**Interfaces:**
- Produces:
  - `createPgPool(cfg: PgPoolConfig): pg.Pool`, where `PgPoolConfig = Omit<pg.PoolConfig, 'types'> & { schema: string }`;
  - `schemaOf(pool): string`;
  - `postgresKysely<DB>(pool, opts?: { afterBeginWrite?: WriteHook }): Kysely<DB>`;
  - `type WriteHook = (exec: (sql: string, params?: readonly unknown[]) => Promise<unknown[]>) => Promise<void>`;
  - `writeLock(): () => Promise<() => void>`;
  - `pgTypes`.
  - Test support: `isPg`, `pgMultiConnection`, `testPgSchema(): Promise<{ pool, schema, drop() }>`.
  - `npm run test:unit:pg`.

- [ ] **Step 1: Add the driver and the script**

```bash
npm install --ignore-scripts --no-audit --no-fund pg@^8.23.1
npm install --ignore-scripts --no-audit --no-fund -D @types/pg@^8
npm pkg set 'scripts.test:unit:pg=vitest run -c vitest.pg.config.ts'
```

Expected: `package.json` gains `"pg": "^8.23.1"` in `dependencies`, `@types/pg` in `devDependencies`, and the `test:unit:pg` script.

- [ ] **Step 2: Create `scripts/pg-test-server.sh` and start it**

```bash
#!/usr/bin/env bash
# Local Postgres 16 + pgvector for the store suite where Docker is unavailable
# (Linux x64/arm64). Real server binaries from @embedded-postgres, pgvector from
# the PGDG bookworm .deb; Unix socket only. CI uses the pgvector/pgvector:pg16
# service container instead.
#
#   scripts/pg-test-server.sh start   # prints the PG_TEST_URL to export
#   scripts/pg-test-server.sh stop
set -euo pipefail
ROOT=${PG_TEST_ROOT:-/tmp/fleet-pg-test}
PG_PKG_VERSION=16.15.0-beta.19
PGVECTOR_DEB_VERSION=0.8.7-1.pgdg12+1
case "$(uname -m)" in
  x86_64) NPM_ARCH=x64; DEB_ARCH=amd64 ;;
  aarch64|arm64) NPM_ARCH=arm64; DEB_ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
NATIVE="$ROOT/node_modules/@embedded-postgres/linux-$NPM_ARCH/native"
URL="postgres://postgres@localhost/postgres?host=$ROOT/sock"

install() {
  [ -x "$NATIVE/bin/postgres" ] && [ -f "$NATIVE/lib/postgresql/vector.so" ] && return
  mkdir -p "$ROOT"
  (cd "$ROOT" && [ -f package.json ] || npm init -y >/dev/null)
  (cd "$ROOT" && npm i --no-audit --no-fund "@embedded-postgres/linux-$NPM_ARCH@$PG_PKG_VERSION" >/dev/null)
  chmod +x "$NATIVE"/bin/*
  local deb="postgresql-16-pgvector_${PGVECTOR_DEB_VERSION}_${DEB_ARCH}.deb"
  curl -sfL -o "$ROOT/$deb" "https://apt.postgresql.org/pub/repos/apt/pool/main/p/pgvector/${deb//+/%2B}"
  rm -rf "$ROOT/deb" && dpkg-deb -x "$ROOT/$deb" "$ROOT/deb"
  cp "$ROOT/deb/usr/lib/postgresql/16/lib/vector.so" "$NATIVE/lib/postgresql/"
  cp "$ROOT"/deb/usr/share/postgresql/16/extension/vector* "$NATIVE/share/postgresql/extension/"
}

case "${1:-}" in
  start)
    install
    if [ ! -f "$ROOT/data/PG_VERSION" ]; then
      "$NATIVE/bin/initdb" -D "$ROOT/data" -U postgres --auth=trust --locale=C.UTF-8 -E UTF8 >/dev/null
    fi
    mkdir -p "$ROOT/sock"
    "$NATIVE/bin/pg_ctl" -D "$ROOT/data" -o "-k $ROOT/sock -c listen_addresses=''" -l "$ROOT/pg.log" -w status >/dev/null 2>&1 \
      || "$NATIVE/bin/pg_ctl" -D "$ROOT/data" -o "-k $ROOT/sock -c listen_addresses=''" -l "$ROOT/pg.log" -w start >/dev/null
    echo "export PG_TEST_URL='$URL'"
    ;;
  stop)
    "$NATIVE/bin/pg_ctl" -D "$ROOT/data" -m fast stop >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
```

```bash
chmod +x scripts/pg-test-server.sh
eval "$(scripts/pg-test-server.sh start)"; echo "$PG_TEST_URL"
```

Expected: `postgres://postgres@localhost/postgres?host=/tmp/fleet-pg-test/sock`. The first start downloads ~30 MB into `/tmp/fleet-pg-test`. Then check that the server answers:

```bash
node -e "const pg=require('pg');const c=new pg.Client({connectionString:process.env.PG_TEST_URL});c.connect().then(()=>c.query('select version()')).then((r)=>{console.log(r.rows[0].version.slice(0,16));return c.end();})"
```

Expected: `PostgreSQL 16.15`.

- [ ] **Step 3: Write the failing tests and the test support**

`src/main/store/testStore.ts` (Task 2 and Task 5 extend it):

```ts
// Test support: run store tests on the dialect STORE_TEST_DIALECT names.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createPgPool } from './postgres.js';

export const isPg = process.env.STORE_TEST_DIALECT === 'postgres';
const POOL_MAX = Number(process.env.PG_TEST_POOL_MAX ?? 4);
/** Tests that need concurrent connections skip on a single-connection server. */
export const pgMultiConnection = isPg && POOL_MAX > 1;

export interface TestPg { pool: pg.Pool; schema: string; drop(): Promise<void> }

/** A fresh schema on PG_TEST_URL; drop() removes it and ends the pool. */
export async function testPgSchema(): Promise<TestPg> {
  const url = process.env.PG_TEST_URL;
  if (!url) throw new Error('STORE_TEST_DIALECT=postgres needs PG_TEST_URL');
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const pool = createPgPool({ connectionString: url, schema, max: POOL_MAX });
  await pool.query(`CREATE SCHEMA ${schema}`);
  return {
    pool, schema,
    async drop() {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
```

`src/main/store/pgGlobalSetup.ts`:

```ts
// vitest globalSetup for the Postgres store suite: one-time database prep, so
// parallel test files never race CREATE EXTENSION.
import pg from 'pg';

export default async function setup(): Promise<void> {
  const url = process.env.PG_TEST_URL;
  if (!url) throw new Error('the Postgres store suite needs PG_TEST_URL (scripts/pg-test-server.sh start, or CI)');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS vector');
    const stale = await c.query<{ s: string }>(`SELECT nspname AS s FROM pg_namespace WHERE nspname LIKE 't\\_%'`);
    for (const { s } of stale.rows) await c.query(`DROP SCHEMA ${s} CASCADE`);
  } finally {
    await c.end();
  }
}
```

`vitest.pg.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// The store suite on Postgres. Every listed file also
// runs on SQLite under the default config; PG_TEST_URL names the server.
export default defineConfig({
  test: {
    include: [
      'src/main/store/postgres.test.ts',
    ],
    env: { STORE_TEST_DIALECT: 'postgres' },
    globalSetup: ['src/main/store/pgGlobalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

`src/main/store/postgres.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, type Generated, type Kysely } from 'kysely';
import { createPgPool, postgresKysely, writeLock, type WriteHook } from './postgres.js';
import { isPg, pgMultiConnection, testPgSchema, type TestPg } from './testStore.js';

interface T { t: { id: Generated<number>; v: string } }

describe('writeLock', () => {
  it('grants holders one at a time, in request order', async () => {
    const lock = writeLock();
    const order: string[] = [];
    const a = await lock();
    const b = lock().then((release) => { order.push('b'); release(); });
    const c = lock().then((release) => { order.push('c'); release(); });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    a();
    await Promise.all([b, c]);
    expect(order).toEqual(['b', 'c']);
  });
});

describe('createPgPool', () => {
  it('refuses a schema name it would have to quote', () => {
    expect(() => createPgPool({ schema: 'Fleet; drop' })).toThrow(/invalid store schema name/);
  });
  it('passes an async password function through to pg (called per new connection)', () => {
    const password = async () => 'token';
    const pool = createPgPool({ schema: 'fleet', password });
    expect((pool as unknown as { options: { password: unknown } }).options.password).toBe(password);
    void pool.end();
  });
});

describe.skipIf(!isPg)('postgresKysely', () => {
  let t: TestPg;
  let k: Kysely<T>;
  const hookCalls: string[] = [];
  beforeEach(async () => {
    t = await testPgSchema();
    hookCalls.length = 0;
    k = postgresKysely<T>(t.pool);
    await sql`CREATE TABLE t (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v TEXT NOT NULL)`.execute(k);
  });
  afterEach(async () => {
    await k.destroy();
    await t.drop();
  });

  it('creates and reads unqualified tables in the store schema, BIGINT and COUNT as numbers', async () => {
    await k.insertInto('t').values({ v: 'a' }).execute();
    const where = await sql<{ s: string }>`SELECT table_schema AS s FROM information_schema.tables WHERE table_name = 't'`.execute(k);
    expect(where.rows).toEqual([{ s: t.schema }]);
    const r = await k.selectFrom('t').select((eb) => ['id', eb.fn.countAll().as('n'), eb.fn.sum<number>('id').as('s')]).groupBy('id').executeTakeFirstOrThrow();
    expect(r).toEqual({ id: 1, n: 1, s: 1 });
  });

  it.skipIf(!pgMultiConnection)('a read runs while a write transaction is open; a second write waits for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const tx = k.transaction().execute(async (trx) => {
      await trx.insertInto('t').values({ v: 'tx' }).execute();
      await gate;
      order.push('tx-commit');
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(await k.selectFrom('t').selectAll().execute()).toEqual([]);
    const write = k.insertInto('t').values({ v: 'bare' }).execute().then(() => { order.push('bare-write'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    await Promise.all([tx, write]);
    expect(order).toEqual(['tx-commit', 'bare-write']);
  });

  it('runs afterBeginWrite first in every write transaction and around bare writes, never for reads', async () => {
    const hook: WriteHook = async (exec) => {
      const [row] = (await exec('SELECT txid_current() AS x')) as Array<{ x: string }>;
      hookCalls.push(row.x);
    };
    const hk = postgresKysely<T>(t.pool, { afterBeginWrite: hook });
    await hk.transaction().execute(async (trx) => { await trx.insertInto('t').values({ v: 'a' }).execute(); });
    await hk.insertInto('t').values({ v: 'b' }).execute();
    await hk.selectFrom('t').selectAll().execute();
    await hk.transaction().setAccessMode('read only').execute(async (trx) => { await trx.selectFrom('t').selectAll().execute(); });
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[0]).not.toBe(hookCalls[1]);
    await hk.destroy();
  });

  it('a throwing hook rolls back the transaction and the bare write', async () => {
    const hk = postgresKysely<T>(t.pool, { afterBeginWrite: async () => { throw new Error('lease lost'); } });
    await expect(hk.transaction().execute(async (trx) => { await trx.insertInto('t').values({ v: 'a' }).execute(); }))
      .rejects.toThrow('lease lost');
    await expect(hk.insertInto('t').values({ v: 'b' }).execute()).rejects.toThrow('lease lost');
    expect(await k.selectFrom('t').selectAll().execute()).toEqual([]);
    await hk.destroy();
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `CI=true npx vitest run src/main/store/postgres.test.ts`
Expected: FAIL. `Failed to resolve import "./postgres.js"`.

- [ ] **Step 5: Create `src/main/store/postgres.ts`**

```ts
// The Postgres dialect of the async store layer (remote-workspaces spec §7
// "One store layer"). Stores stay dialect-neutral; this file owns the pool
// shape, type parsing, search_path and the in-process write lock.
import pg from 'pg';
import {
  CompiledQuery, Kysely, PostgresDialect,
  type DatabaseConnection, type Driver, type QueryResult, type TransactionSettings,
} from 'kysely';

const INT8 = 20;
const NUMERIC = 1700;

/** int8 (COUNT, BIGINT columns) and numeric (SUM of BIGINT) parse to number,
 *  as SQLite returns them. Per pool, never pg's global registry. */
export const pgTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8 || oid === NUMERIC) return (v: string) => Number(v);
    return pg.types.getTypeParser(oid, format);
  },
};

export interface PgPoolConfig extends Omit<pg.PoolConfig, 'types'> {
  /** Every store table lives here; it must already exist. */
  schema: string;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const poolSchema = new WeakMap<pg.Pool, string>();
const inSchema = new WeakSet<pg.PoolClient>();

export function createPgPool(cfg: PgPoolConfig): pg.Pool {
  const { schema, ...rest } = cfg;
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid store schema name: ${schema}`);
  const pool = new pg.Pool({ ...rest, types: pgTypes });
  poolSchema.set(pool, schema);
  return pool;
}

/** The schema a pool was created for. */
export function schemaOf(pool: pg.Pool): string {
  const s = poolSchema.get(pool);
  if (!s) throw new Error('not a store pool: create it with createPgPool');
  return s;
}

/** pool.connect() with search_path set once per physical connection. A
 *  startup `options` parameter would do it too, but poolers and some servers
 *  drop it; an explicit SET is honored everywhere. */
async function connectInSchema(pool: pg.Pool): Promise<pg.PoolClient> {
  const client = await pool.connect();
  if (!inSchema.has(client)) {
    const schema = poolSchema.get(pool);
    if (schema) await client.query(`SET search_path TO ${schema}, public`);
    inSchema.add(client);
  }
  return client;
}

/** Promise-chain mutex: `await lock()` resolves to its release function. */
export function writeLock(): () => Promise<() => void> {
  let tail = Promise.resolve();
  return () => {
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const acquired = tail.then(() => release);
    tail = tail.then(() => next);
    return acquired;
  };
}

/** Runs first in every read-write transaction (and around a bare write);
 *  a throw rolls the transaction back. fleet-host's lease fence plugs in here. */
export type WriteHook = (exec: (sqlText: string, params?: readonly unknown[]) => Promise<unknown[]>) => Promise<void>;

// Raw `sql` statements count as writes: closeDb's `select 1` must queue behind
// in-flight write transactions, as it did on the SQLite mutex.
const WRITE_KINDS = new Set(['InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'MergeQueryNode', 'RawNode']);

interface Conn extends DatabaseConnection { inner: DatabaseConnection; inTx: boolean; unlock: (() => void) | null }

/** Serializes every in-process write (read-write transactions and bare write
 *  statements), as SQLite's connection mutex did; reads and read-only
 *  transactions run concurrently on the pool. */
class SerializingDriver implements Driver {
  constructor(
    private readonly inner: Driver,
    private readonly lock: () => Promise<() => void>,
    private readonly hook: WriteHook | undefined,
  ) {}

  init(): Promise<void> { return this.inner.init(); }

  async acquireConnection(): Promise<DatabaseConnection> {
    const inner = await this.inner.acquireConnection();
    const conn: Conn = {
      inner, inTx: false, unlock: null,
      executeQuery: <R>(cq: CompiledQuery) => this.execute<R>(conn, cq),
      streamQuery: (cq, chunk) => inner.streamQuery(cq, chunk),
    };
    return conn;
  }

  private async execute<R>(conn: Conn, cq: CompiledQuery): Promise<QueryResult<R>> {
    if (conn.inTx || !WRITE_KINDS.has(cq.query.kind)) return conn.inner.executeQuery<R>(cq);
    const unlock = await this.lock();
    try {
      if (!this.hook) return await conn.inner.executeQuery<R>(cq);
      await conn.inner.executeQuery(CompiledQuery.raw('begin'));
      try {
        await this.hook(this.exec(conn.inner));
        const r = await conn.inner.executeQuery<R>(cq);
        await conn.inner.executeQuery(CompiledQuery.raw('commit'));
        return r;
      } catch (e) {
        await conn.inner.executeQuery(CompiledQuery.raw('rollback')).catch(() => undefined);
        throw e;
      }
    } finally {
      unlock();
    }
  }

  async beginTransaction(c: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const conn = c as Conn;
    const write = settings.accessMode !== 'read only';
    if (write) conn.unlock = await this.lock();
    conn.inTx = true;
    try {
      await this.inner.beginTransaction(conn.inner, settings);
    } catch (e) {
      this.end(conn);
      throw e;
    }
    if (!write || !this.hook) return;
    try {
      await this.hook(this.exec(conn.inner));
    } catch (e) {
      await this.inner.rollbackTransaction(conn.inner).catch(() => undefined);
      this.end(conn);
      throw e;
    }
  }

  async commitTransaction(c: DatabaseConnection): Promise<void> {
    try { await this.inner.commitTransaction((c as Conn).inner); } finally { this.end(c as Conn); }
  }

  async rollbackTransaction(c: DatabaseConnection): Promise<void> {
    try { await this.inner.rollbackTransaction((c as Conn).inner); } finally { this.end(c as Conn); }
  }

  releaseConnection(c: DatabaseConnection): Promise<void> { return this.inner.releaseConnection((c as Conn).inner); }

  destroy(): Promise<void> { return this.inner.destroy(); }

  private exec(inner: DatabaseConnection) {
    return async (sqlText: string, params: readonly unknown[] = []) =>
      (await inner.executeQuery(CompiledQuery.raw(sqlText, [...params]))).rows as unknown[];
  }

  private end(conn: Conn): void {
    conn.inTx = false;
    conn.unlock?.();
    conn.unlock = null;
  }
}

class SerializingPostgresDialect extends PostgresDialect {
  constructor(
    cfg: ConstructorParameters<typeof PostgresDialect>[0],
    private readonly lock: () => Promise<() => void>,
    private readonly hook: WriteHook | undefined,
  ) { super(cfg); }
  override createDriver(): Driver { return new SerializingDriver(super.createDriver(), this.lock, this.hook); }
}

export interface PostgresKyselyOptions { afterBeginWrite?: WriteHook }

/** A Kysely handle on a shared pool, with its own write lock (one per store,
 *  as each SQLite file had its own mutex). destroy() leaves the pool open: the
 *  store factory owns it. */
export function postgresKysely<DB>(pool: pg.Pool, opts: PostgresKyselyOptions = {}): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new SerializingPostgresDialect(
      { pool: { connect: () => connectInSchema(pool), end: async () => undefined } }, writeLock(), opts.afterBeginWrite,
    ),
  });
}
```

- [ ] **Step 6: Run the tests on both dialects**

Run: `CI=true npx vitest run src/main/store/postgres.test.ts`
Expected: PASS. 3 passed, 4 skipped (the Postgres-only `describe`).

Run: `CI=true npm run test:unit:pg`
Expected: PASS. 7 passed. Among them: the bare write waits for the open write transaction while a read doesn't (`['tx-commit', 'bare-write']`), the hook runs twice (once for the transaction, once around the bare write) and never for reads, and a throwing hook leaves `t` empty.

- [ ] **Step 7: Run the Postgres suite in CI**

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit
edit('.github/workflows/build-app.yml', [
    ("""  unit-run:
    name: unit run (vitest)
    needs: changes
    if: needs.changes.outputs.code == 'true'
    runs-on: ubuntu-latest
    steps:""", """  unit-run:
    name: unit run (vitest)
    needs: changes
    if: needs.changes.outputs.code == 'true'
    runs-on: ubuntu-latest
    # The store suite on Postgres: PG 16 as on Aurora,
    # pgvector at the version scripts/pg-test-server.sh installs.
    services:
      postgres:
        image: pgvector/pgvector:0.8.7-pg16
        env:
          POSTGRES_PASSWORD: fleet
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 12
    steps:""", 1),
    ("""        run: npm run test:unit

      - name: Bundle fleet-host
""", """        run: npm run test:unit

      - name: Unit tests (store suite on Postgres)
        env:
          PG_TEST_URL: postgres://postgres:fleet@localhost:5432/postgres
        run: npm run test:unit:pg

      - name: Bundle fleet-host
""", 1),
])
PYEOF
```

The service runs in the existing `unit run (vitest)` job, so the required `unit (vitest)` context covers it and the #303 aggregator pattern is untouched.

- [ ] **Step 8: Typecheck and run the full SQLite suite**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src`
Expected: both exit 0. The suite passes, with the new file's Postgres-only tests skipped.

- [ ] **Step 9: Commit**

```bash
git -C "$WT" add package.json package-lock.json vitest.pg.config.ts scripts/pg-test-server.sh .github/workflows/build-app.yml \
  src/main/store/postgres.ts src/main/store/postgres.test.ts src/main/store/testStore.ts src/main/store/pgGlobalSetup.ts
git -C "$WT" commit -m "feat(store): Postgres dialect seam: pg pool, type parsing, search_path, per-store write lock

Adds the Postgres store suite (vitest.pg.config.ts), a local PG16+pgvector
server script, and a pgvector/pgvector:0.8.7-pg16 service in the unit job.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Per-dialect migrations; `state.db` and the inbox open on Postgres

**Files:**
- Create: `src/main/store/pgMigrate.ts`, `src/main/store/pgMigrate.test.ts`, `src/main/store/migrations/statePg.ts`, `src/main/store/migrations/inboxPg.ts`, `src/main/store/schemaParity.test.ts`
- Modify: `src/main/store/testStore.ts` (replaced), `src/main/db.ts`, `src/main/inbox/inboxDb.ts`, `vitest.pg.config.ts`

**Interfaces:**
- Consumes: `postgresKysely`, `schemaOf`, `PostgresKyselyOptions` (Task 1).
- Produces:
  - `migratePostgres<DB>(k, schema, track: PgTrack)`, where `PgTrack = { track, baselineVersion, baseline, steps: { version, postgres }[] }`;
  - `ensureVector(k)`;
  - `openDbPostgres(pool, opts?): Promise<void>`;
  - `InboxStore.openPostgres(pool, opts?): Promise<InboxStore>`.
  - Test support: `openTestState(prefix?): Promise<TestState>` (`{ dir, pg, open(), reopen(), close() }`), `openTestInbox()`, `queryRows(sql, params?, k?)`.

- [ ] **Step 1: Write the failing tests**

`src/main/store/pgMigrate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { createPgPool, postgresKysely } from './postgres.js';
import { migratePostgres, type PgTrack } from './pgMigrate.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';

const TRACK: PgTrack = {
  track: 'demo', baselineVersion: 3, baseline: 'CREATE TABLE a (x BIGINT); CREATE TABLE b (y BIGINT);',
  steps: [{ version: 3, postgres: 'SELECT 1/0' }, { version: 4, postgres: 'ALTER TABLE a ADD COLUMN z TEXT' }],
};

describe.skipIf(!isPg)('migratePostgres', () => {
  let t: TestPg;
  let k: Kysely<unknown>;
  beforeEach(async () => { t = await testPgSchema(); k = postgresKysely(t.pool); });
  afterEach(async () => { await k.destroy(); await t.drop(); });

  const version = async () =>
    (await sql<{ version: number }>`SELECT version FROM schema_migrations WHERE track = 'demo'`.execute(k)).rows[0]?.version;
  const columns = async (table: string) =>
    (await sql<{ c: string }>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ${t.schema} AND table_name = ${table} ORDER BY ordinal_position`.execute(k)).rows.map((r) => r.c);

  it('applies the baseline, skips steps at or below it, runs later ones, and is idempotent', async () => {
    await migratePostgres(k, t.schema, TRACK);
    expect(await version()).toBe(4);
    expect(await columns('a')).toEqual(['x', 'z']);
    await migratePostgres(k, t.schema, TRACK);
    expect(await version()).toBe(4);
  });

  it('serializes concurrent migrators: the baseline runs once', async () => {
    const k2 = postgresKysely(t.pool);
    await Promise.all([migratePostgres(k, t.schema, TRACK), migratePostgres(k2, t.schema, TRACK)]);
    expect(await version()).toBe(4);
    await k2.destroy();
  });

  it('a failing step rolls the whole run back', async () => {
    await expect(migratePostgres(k, t.schema, { ...TRACK, steps: [{ version: 4, postgres: 'SELECT 1/0' }] })).rejects.toThrow(/division by zero/);
    expect(await columns('a')).toEqual([]);
  });

  it('refuses a schema that does not exist instead of creating tables elsewhere', async () => {
    const pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: 'no_such_schema_x', max: 1 });
    const kk = postgresKysely(pool);
    await expect(migratePostgres(kk, 'no_such_schema_x', TRACK)).rejects.toThrow(/store schema "no_such_schema_x" does not exist/);
    await kk.destroy();
    await pool.end();
  });
});
```

`src/main/store/schemaParity.test.ts`:

```ts
// Postgres baselines ≡ the SQLite schemas they mirror: same tables, columns,
// NOT NULL, primary keys and unique keys. Runs only on the Postgres suite.
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import * as db from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { isPg, testPgSchema } from './testStore.js';
import { postgresKysely } from './postgres.js';

interface Shape { columns: Record<string, { notNull: boolean }>; pk: string[]; uniques: string[] }

function sqliteShapes(raw: Database.Database): Record<string, Shape> {
  const out: Record<string, Shape> = {};
  const tables = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
  for (const { name } of tables) {
    const cols = raw.prepare(`PRAGMA table_info(${name})`).all() as { name: string; notnull: number; pk: number }[];
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const uniques = (raw.prepare(`PRAGMA index_list(${name})`).all() as { name: string; unique: number; origin: string; partial: number }[])
      .filter((i) => i.unique && i.origin !== 'pk' && !i.partial)
      .map((i) => (raw.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name).join(','))
      .sort();
    out[name] = {
      columns: Object.fromEntries(cols.map((c) => [c.name, { notNull: c.notnull === 1 || pk.includes(c.name) }])),
      pk, uniques,
    };
  }
  return out;
}

async function pgShapes(schema: string, k: ReturnType<typeof postgresKysely>): Promise<Record<string, Shape>> {
  const cols = (await sql<{ t: string; c: string; nn: string }>`
    SELECT table_name AS t, column_name AS c, is_nullable AS nn FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name <> 'schema_migrations' ORDER BY table_name, ordinal_position`.execute(k)).rows;
  const keys = (await sql<{ t: string; kind: string; cols: string }>`
    SELECT rel.relname AS t, con.contype AS kind,
           string_agg(att.attname, ',' ORDER BY k.ord) AS cols
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = k.attnum
    WHERE ns.nspname = ${schema} AND con.contype IN ('p', 'u') AND rel.relname <> 'schema_migrations'
    GROUP BY rel.relname, con.conname, con.contype`.execute(k)).rows;
  const out: Record<string, Shape> = {};
  for (const r of cols) {
    out[r.t] ??= { columns: {}, pk: [], uniques: [] };
    out[r.t].columns[r.c] = { notNull: r.nn === 'NO' };
  }
  for (const r of keys) {
    if (r.kind === 'p') out[r.t].pk = r.cols.split(',');
    else out[r.t].uniques.push(r.cols);
  }
  for (const s of Object.values(out)) s.uniques.sort();
  return out;
}

describe.skipIf(!isPg)('Postgres baseline schema parity', () => {
  it('state baseline mirrors state.db at user_version 14', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-parity-'));
    const raw = db.openDb(dir);
    const want = sqliteShapes(raw);
    await db.closeDb();
    rmSync(dir, { recursive: true, force: true });
    const t = await testPgSchema();
    try {
      await db.openDbPostgres(t.pool);
      expect(await pgShapes(t.schema, postgresKysely(t.pool))).toEqual(want);
    } finally {
      await db.closeDb();
      await t.drop();
    }
  });

  it('inbox baseline mirrors inbox.db at INBOX_SCHEMA_VERSION', async () => {
    const mem = InboxStore.memory();
    const want = sqliteShapes((mem as unknown as { raw: Database.Database }).raw);
    await mem.close();
    const t = await testPgSchema();
    try {
      const store = await InboxStore.openPostgres(t.pool);
      expect(await pgShapes(t.schema, postgresKysely(t.pool))).toEqual(want);
      await store.close();
    } finally {
      await t.drop();
    }
  });
});
```

Replace `src/main/store/testStore.ts` with:

```ts
// Test support: open state.db / inbox on the dialect STORE_TEST_DIALECT names.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { CompiledQuery, type Kysely } from 'kysely';
import { createPgPool } from './postgres.js';
import * as db from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';

export const isPg = process.env.STORE_TEST_DIALECT === 'postgres';
const POOL_MAX = Number(process.env.PG_TEST_POOL_MAX ?? 4);
/** Tests that need concurrent connections skip on a single-connection server. */
export const pgMultiConnection = isPg && POOL_MAX > 1;

export interface TestPg { pool: pg.Pool; schema: string; drop(): Promise<void> }

/** A fresh schema on PG_TEST_URL; drop() removes it and ends the pool. */
export async function testPgSchema(): Promise<TestPg> {
  const url = process.env.PG_TEST_URL;
  if (!url) throw new Error('STORE_TEST_DIALECT=postgres needs PG_TEST_URL');
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const pool = createPgPool({ connectionString: url, schema, max: POOL_MAX });
  await pool.query(`CREATE SCHEMA ${schema}`);
  return {
    pool, schema,
    async drop() {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}

export interface TestState {
  dir: string;
  pg: TestPg | null;
  /** Open the same database again (after, or racing, a closeDb). */
  open(): Promise<void>;
  /** closeDb, then open(). */
  reopen(): Promise<void>;
  close(): Promise<void>;
}

/** openDb on a fresh tmpdir (SQLite) or openDbPostgres on a fresh schema. */
export async function openTestState(prefix = 'cf-state-'): Promise<TestState> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const t = isPg ? await testPgSchema() : null;
  const open = async () => { if (t) await db.openDbPostgres(t.pool); else db.openDb(dir); };
  await open();
  return {
    dir, pg: t, open,
    async reopen() { await db.closeDb(); await open(); },
    async close() {
      await db.closeDb();
      await t?.drop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** InboxStore.memory() (SQLite) or a fresh-schema store whose close() drops it. */
export async function openTestInbox(): Promise<InboxStore> {
  if (!isPg) return InboxStore.memory();
  const t = await testPgSchema();
  const store = await InboxStore.openPostgres(t.pool);
  const close = store.close.bind(store);
  store.close = async () => { await close(); await t.drop(); };
  return store;
}

/** Raw SQL with `?` placeholders on either dialect (state.db by default). */
export async function queryRows<T = Record<string, unknown>>(
  text: string, params: readonly unknown[] = [], k: Kysely<unknown> = db.stateKysely() as Kysely<unknown>,
): Promise<T[]> {
  let n = 0;
  const q = isPg ? text.replace(/\?/g, () => `$${++n}`) : text;
  return (await k.executeQuery<T>(CompiledQuery.raw(q, [...params]))).rows;
}

```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true STORE_TEST_DIALECT=postgres npx vitest run src/main/store/pgMigrate.test.ts src/main/store/schemaParity.test.ts`
Expected: FAIL. `Failed to resolve import "./pgMigrate.js"`.

- [ ] **Step 3: Create the migration runner and the baselines**

`src/main/store/pgMigrate.ts`:

```ts
// Postgres migrations: one `schema_migrations` row per track. A fresh schema
// gets the track's baseline (≡ the final SQLite schema), then each later step.
// SQLite keeps its own user_version chain.
import { sql, type Kysely } from 'kysely';

export interface PgMigrationStep { version: number; postgres: string }

export interface PgTrack {
  /** `schema_migrations.track`: 'state' | 'inbox' (fleet-host adds its own). */
  track: string;
  baselineVersion: number;
  baseline: string;
  steps: readonly PgMigrationStep[];
}

// Arbitrary constant: serializes concurrent migrators (two host pods, two tracks).
const MIGRATE_LOCK = 7_340_211;

/** Migrate `t` inside `schema`, which must exist (the store never creates it). */
export async function migratePostgres<DB>(k: Kysely<DB>, schema: string, t: PgTrack): Promise<void> {
  const cur = await sql<{ s: string | null }>`SELECT current_schema() AS s`.execute(k);
  if (cur.rows[0]?.s !== schema) {
    throw new Error(`the store schema "${schema}" does not exist: create it (and grant this role CREATE on it) before first start`);
  }
  await k.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK})`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (track TEXT PRIMARY KEY, version BIGINT NOT NULL)`.execute(trx);
    const row = await sql<{ version: number }>`SELECT version FROM schema_migrations WHERE track = ${t.track}`.execute(trx);
    let v = row.rows[0]?.version ?? 0;
    if (v === 0) {
      await sql.raw(t.baseline).execute(trx);
      v = t.baselineVersion;
      await sql`INSERT INTO schema_migrations (track, version) VALUES (${t.track}, ${v})`.execute(trx);
    }
    for (const s of t.steps) {
      if (s.version <= v) continue;
      await sql.raw(s.postgres).execute(trx);
      v = s.version;
      await sql`UPDATE schema_migrations SET version = ${v} WHERE track = ${t.track}`.execute(trx);
    }
  });
}

/** pgvector ≥ 0.8.0 (iterative index scans) must be installed in the database.
 *  Creates it when this role may; otherwise names the admin step. */
export async function ensureVector<DB>(k: Kysely<DB>): Promise<void> {
  const installed = async () =>
    (await sql<{ v: string }>`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`.execute(k)).rows[0]?.v;
  let v = await installed();
  if (!v) {
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(k);
    } catch (e) {
      throw new Error(`pgvector is not installed and this role cannot create it; an admin must run CREATE EXTENSION vector (${String(e)})`);
    }
    v = await installed();
  }
  const [maj, min] = String(v).split('.').map(Number);
  if (maj === 0 && min < 8) throw new Error(`pgvector ${v} is too old: the store needs 0.8.0 or later`);
}
```

`src/main/store/migrations/statePg.ts`:

```ts
// Postgres DDL for state.db's schema at SQLite user_version 14.
// Byte-order text, as SQLite compares it: sort order must not follow the server locale.
const T = 'TEXT COLLATE "C"';
const ID = 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY';

export const STATE_PG_BASELINE_VERSION = 14;

export const STATE_PG_BASELINE = `
CREATE TABLE events (
  id ${ID},
  session_id ${T} NOT NULL,
  workspace_id ${T} NOT NULL,
  ts BIGINT,
  type ${T} NOT NULL,
  subtype ${T},
  uuid ${T},
  parent_uuid ${T},
  model ${T},
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_input_tokens BIGINT,
  cache_creation_input_tokens BIGINT,
  service_tier ${T},
  tool_name ${T},
  raw_jsonl ${T} NOT NULL,
  dedup_key ${T} NOT NULL,
  tool_use_id ${T},
  tool_input ${T},
  tool_result_is_error BIGINT,
  UNIQUE (session_id, dedup_key)
);
CREATE INDEX idx_events_session_ts ON events (session_id, ts);
CREATE INDEX idx_events_workspace ON events (workspace_id);
CREATE INDEX idx_events_type ON events (type);
CREATE INDEX idx_events_tool_use ON events (session_id, tool_use_id);
CREATE INDEX idx_events_session_type ON events (session_id, type);

CREATE TABLE sessions (
  id ${T} PRIMARY KEY,
  workspace_id ${T} NOT NULL,
  cwd ${T},
  started_at BIGINT,
  last_active_at BIGINT,
  ai_title ${T},
  first_user_message ${T},
  user_set_name ${T}
);
CREATE INDEX idx_sessions_workspace ON sessions (workspace_id);

CREATE TABLE broker_sessions (
  workspace_id ${T} NOT NULL,
  broker_session_id ${T} NOT NULL,
  claude_session_id ${T} NOT NULL,
  learned_at BIGINT NOT NULL,
  verified BIGINT NOT NULL DEFAULT 0,
  pending_claude_session_id ${T},
  PRIMARY KEY (workspace_id, broker_session_id)
);
CREATE INDEX idx_broker_sessions_claude ON broker_sessions (claude_session_id);

CREATE TABLE errors (
  id ${ID},
  ts BIGINT NOT NULL,
  workspace_id ${T},
  session_id ${T},
  source ${T} NOT NULL,
  level ${T} NOT NULL,
  type ${T} NOT NULL,
  message ${T} NOT NULL,
  stack ${T},
  extra ${T}
);
CREATE INDEX idx_errors_workspace_ts ON errors (workspace_id, ts);
CREATE INDEX idx_errors_session ON errors (session_id);

CREATE TABLE embeddings (
  id ${ID},
  workspace_id ${T} NOT NULL,
  session_id ${T} NOT NULL,
  kind ${T} NOT NULL,
  ref_event_id BIGINT,
  ts BIGINT,
  text ${T} NOT NULL,
  model_id ${T} NOT NULL,
  dim BIGINT NOT NULL,
  vec vector(384) NOT NULL,
  dedup_key ${T} NOT NULL,
  UNIQUE (session_id, kind, dedup_key)
);
CREATE INDEX idx_emb_workspace ON embeddings (workspace_id);
CREATE INDEX idx_emb_session ON embeddings (session_id);
CREATE INDEX idx_emb_ref_event ON embeddings (ref_event_id);
CREATE INDEX idx_emb_vec ON embeddings USING hnsw (vec vector_cosine_ops) WHERE text <> '';

CREATE TABLE session_summaries (
  id ${ID},
  session_id ${T} NOT NULL,
  workspace_id ${T} NOT NULL,
  summary ${T} NOT NULL,
  tags ${T},
  source_max_event_id BIGINT NOT NULL,
  from_ts BIGINT,
  to_ts BIGINT,
  model ${T},
  generated_at BIGINT NOT NULL,
  UNIQUE (session_id, source_max_event_id)
);
CREATE INDEX idx_session_summaries_session ON session_summaries (session_id, generated_at);

CREATE TABLE session_tags (
  workspace_id ${T} NOT NULL,
  session_id ${T} NOT NULL,
  tag ${T} NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX idx_session_tags_workspace ON session_tags (workspace_id, tag);

CREATE TABLE usage_events (
  id ${ID},
  ts BIGINT NOT NULL,
  workspace_id ${T} NOT NULL,
  session_id ${T},
  kind ${T} NOT NULL,
  detail ${T}
);
CREATE INDEX idx_usage_events_session ON usage_events (session_id, kind);
CREATE INDEX idx_usage_events_workspace_ts ON usage_events (workspace_id, ts);

CREATE TABLE usage_anchors (
  id ${ID},
  ts BIGINT NOT NULL,
  workspace_id ${T},
  session_id ${T},
  kind ${T} NOT NULL,
  http_status BIGINT,
  scope ${T},
  reset_at BIGINT,
  window_start BIGINT,
  message ${T},
  rate_limits ${T},
  dedup_key ${T} NOT NULL,
  UNIQUE (dedup_key)
);
CREATE INDEX idx_usage_anchors_ts ON usage_anchors (ts);

CREATE TABLE perf_events (
  id ${ID},
  ts BIGINT NOT NULL,
  kind ${T} NOT NULL,
  workspace_id ${T},
  session_id ${T},
  name ${T},
  dur_ms DOUBLE PRECISION,
  trace_id ${T},
  span_id ${T},
  meta ${T}
);
CREATE INDEX idx_perf_events_ts ON perf_events (ts);
CREATE INDEX idx_perf_events_kind_ts ON perf_events (kind, ts);

CREATE TABLE session_costs (
  session_id ${T} NOT NULL,
  workspace_id ${T} NOT NULL,
  model ${T} NOT NULL DEFAULT '',
  service_tier ${T} NOT NULL DEFAULT '',
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_input_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0,
  event_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, workspace_id, model, service_tier)
);
CREATE INDEX idx_session_costs_workspace ON session_costs (workspace_id);

CREATE TABLE session_stats (
  session_id ${T} PRIMARY KEY,
  max_context_tokens BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE session_tool_counts (
  session_id ${T} NOT NULL,
  tool_name ${T} NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, tool_name)
);
`;
```

`src/main/store/migrations/inboxPg.ts`:

```ts
// Postgres DDL for inbox.db's schema at INBOX_SCHEMA_VERSION 5.
// Byte-order text, as SQLite compares it: sort order must not follow the server locale.
const T = 'TEXT COLLATE "C"';

export const INBOX_PG_BASELINE_VERSION = 5;

export const INBOX_PG_BASELINE = `
CREATE TABLE todos (
  id ${T} PRIMARY KEY,
  title ${T} NOT NULL,
  body ${T},
  status ${T} NOT NULL CHECK (status IN ('open','done','dismissed')),
  priority ${T} NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
  source_kind ${T} NOT NULL CHECK (source_kind IN ('user','workspace','automation')),
  source_id ${T},
  source_run_id ${T},
  via_workspace ${T},
  dedupe_key ${T},
  seen_count BIGINT NOT NULL DEFAULT 1,
  recurred BIGINT NOT NULL DEFAULT 0,
  workspace_id ${T},
  session_id ${T},
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  closed_at BIGINT
);
CREATE UNIQUE INDEX todos_dedupe ON todos (source_kind, COALESCE(source_id, ''), dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX todos_open ON todos (status, priority, last_seen_at);
CREATE TABLE tags (
  entity_kind ${T} NOT NULL,
  entity_id ${T} NOT NULL,
  tag ${T} NOT NULL,
  PRIMARY KEY (entity_kind, entity_id, tag)
);
CREATE TABLE todo_events (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  todo_id ${T} NOT NULL,
  ts BIGINT NOT NULL,
  kind ${T} NOT NULL,
  actor_kind ${T} NOT NULL,
  actor_id ${T},
  run_id ${T},
  detail ${T}
);
CREATE INDEX todo_events_todo ON todo_events (todo_id, id);

CREATE TABLE notifications (
  id ${T} PRIMARY KEY,
  ts BIGINT NOT NULL,
  kind ${T} NOT NULL,
  title ${T} NOT NULL,
  body ${T},
  priority ${T} NOT NULL,
  source_kind ${T} NOT NULL,
  source_id ${T},
  todo_id ${T},
  workspace_id ${T},
  dedupe_key ${T},
  tags ${T},
  delivered BIGINT NOT NULL,
  held_reason ${T},
  channel ${T},
  cleared_at BIGINT,
  digested BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX notifications_ts ON notifications (ts);
CREATE TABLE notification_rules (
  id ${T} PRIMARY KEY,
  scope_kind ${T} NOT NULL CHECK (scope_kind IN ('key','source','tag','global')),
  scope_value ${T} NOT NULL,
  level ${T} NOT NULL CHECK (level IN ('all','high','urgent','off')),
  snooze_until BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (scope_kind, scope_value)
);
CREATE TABLE downtimes (
  id ${T} PRIMARY KEY,
  name ${T} NOT NULL,
  enabled BIGINT NOT NULL,
  days_mask BIGINT NOT NULL,
  start_min BIGINT NOT NULL,
  end_min BIGINT NOT NULL,
  bypass ${T} NOT NULL CHECK (bypass IN ('none','urgent','urgent+input')),
  created_at BIGINT NOT NULL
);
CREATE TABLE notify_state (k ${T} PRIMARY KEY, v ${T} NOT NULL);

CREATE TABLE automations (
  id ${T} PRIMARY KEY,
  name ${T} NOT NULL UNIQUE,
  enabled BIGINT NOT NULL,
  version BIGINT NOT NULL,
  definition ${T} NOT NULL,
  created_by_kind ${T} NOT NULL,
  created_by_id ${T},
  origin ${T},
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_scheduled_at BIGINT,
  next_run_at BIGINT,
  next_run_by ${T}
);
CREATE TABLE automation_versions (
  automation_id ${T} NOT NULL,
  version BIGINT NOT NULL,
  definition ${T} NOT NULL,
  created_at BIGINT NOT NULL,
  created_by_kind ${T} NOT NULL,
  created_by_id ${T},
  PRIMARY KEY (automation_id, version)
);
CREATE TABLE automation_state (automation_id ${T} PRIMARY KEY, state ${T} NOT NULL);
CREATE TABLE runs (
  id ${T} PRIMARY KEY,
  automation_id ${T} NOT NULL,
  version BIGINT NOT NULL,
  trigger ${T} NOT NULL,
  args ${T} NOT NULL,
  status ${T} NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  error ${T},
  reschedule ${T}
);
CREATE INDEX runs_automation ON runs (automation_id, started_at);
CREATE INDEX runs_status ON runs (status);
CREATE TABLE step_runs (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  run_id ${T} NOT NULL,
  step_id ${T} NOT NULL,
  kind ${T} NOT NULL,
  status ${T} NOT NULL,
  workspace_id ${T},
  broker_session_id ${T},
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  error ${T},
  detail ${T}
);
CREATE INDEX step_runs_run ON step_runs (run_id, id);

CREATE TABLE proposals (
  id ${T} PRIMARY KEY,
  kind ${T} NOT NULL CHECK (kind IN ('new','change','batch')),
  proposer_kind ${T} NOT NULL,
  proposer_id ${T},
  rationale ${T},
  status ${T} NOT NULL,
  items ${T} NOT NULL,
  note ${T},
  created_at BIGINT NOT NULL,
  decided_at BIGINT
);
CREATE INDEX proposals_status ON proposals (status, created_at);
`;
```

- [ ] **Step 4: Open both stores on Postgres, and add the tests to the suite**

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit, add_pg_suite
edit('src/main/db.ts', [
    ("""import { sqliteKysely, num, chunked } from './store/kysely.js';
""", """import { sqliteKysely, num, chunked } from './store/kysely.js';
import type pg from 'pg';
import { postgresKysely, schemaOf, type PostgresKyselyOptions } from './store/postgres.js';
import { migratePostgres, ensureVector } from './store/pgMigrate.js';
import { STATE_PG_BASELINE, STATE_PG_BASELINE_VERSION } from './store/migrations/statePg.js';
import { decodeVector } from './vectors.js';
""", 1),
    ("""/** Close state.db. Waits for any in-flight query or transaction on the
 *  connection mutex (an ingest chunk, a mapping write) before closing. */
export async function closeDb(): Promise<void> {
  if (!db || !kdb) return;
  const raw = db;
  const k = kdb;
  db = null;
  kdb = null;""", """let dialect: 'sqlite' | 'postgres' = 'sqlite';

/** Open state.db's tables on a Postgres store pool: pgvector
 *  check, migrations, then the same pending-remap rehydrate as openDb. */
export async function openDbPostgres(pool: pg.Pool, opts: PostgresKyselyOptions = {}): Promise<void> {
  if (kdb) return;
  summaryCache.clear();
  spendCache.clear();
  const k = postgresKysely<StateDb>(pool, opts);
  await ensureVector(k);
  await migratePostgres(k, schemaOf(pool), {
    track: 'state', baselineVersion: STATE_PG_BASELINE_VERSION, baseline: STATE_PG_BASELINE, steps: [],
  });
  const rows = await k.selectFrom('broker_sessions').select(['workspace_id', 'pending_claude_session_id'])
    .where('pending_claude_session_id', 'is not', null).execute();
  pendingClaudeIds.clear();
  for (const r of rows) pendingClaudeIds.add(pendingKey(r.workspace_id, r.pending_claude_session_id as string));
  dialect = 'postgres';
  kdb = k;
}

/** Close state.db. Waits for any in-flight query or transaction on the
 *  connection mutex (an ingest chunk, a mapping write) before closing. */
export async function closeDb(): Promise<void> {
  if (!kdb) return;
  const raw = db;
  const k = kdb;
  db = null;
  kdb = null;
  dialect = 'sqlite';""", 1),
    ("""  await k.destroy();
  if (raw.open) raw.close();""", """  await k.destroy();
  if (raw?.open) raw.close();""", 1),
    ("""  if (!db) {
    pendingClaudeIds.clear();""", """  if (!kdb) {
    pendingClaudeIds.clear();""", 1),
    ("""            vec: row.vec,""", """            vec: dialect === 'postgres' ? sql<Buffer>`${pgVectorLiteral(decodeVector(row.vec))}::vector` : row.vec,""", 1),
    ("""// ── Helpers ───""", """/** pgvector's text form. Float32 → number → string round-trips exactly. */
function pgVectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(',')}]`;
}

// ── Helpers ───""", 1),
])
edit('src/main/inbox/inboxDb.ts', [
    ("""import { chunked, num, sqliteKysely } from '../store/kysely.js';
""", """import { chunked, num, sqliteKysely } from '../store/kysely.js';
import type pg from 'pg';
import { postgresKysely, schemaOf, type PostgresKyselyOptions } from '../store/postgres.js';
import { migratePostgres } from '../store/pgMigrate.js';
import { INBOX_PG_BASELINE, INBOX_PG_BASELINE_VERSION } from '../store/migrations/inboxPg.js';
""", 1),
    ("""  private constructor(private readonly raw: Database.Database, readonly kysely: Kysely<InboxDb>) {}
""", """  private constructor(private readonly raw: Database.Database | null, readonly kysely: Kysely<InboxDb>) {}

  /** The inbox tables on a Postgres store pool. No file
   *  backup: the migration is one transaction, and the database is the operator's. */
  static async openPostgres(pool: pg.Pool, opts: PostgresKyselyOptions = {}): Promise<InboxStore> {
    const k = postgresKysely<InboxDb>(pool, opts);
    await migratePostgres(k, schemaOf(pool), {
      track: 'inbox', baselineVersion: INBOX_PG_BASELINE_VERSION, baseline: INBOX_PG_BASELINE, steps: [],
    });
    return new InboxStore(null, k);
  }
""", 1),
    ("""    if (this.raw.open) this.raw.close();""", """    if (this.raw?.open) this.raw.close();""", 1),
])
add_pg_suite('src/main/store/pgMigrate.test.ts', 'src/main/store/schemaParity.test.ts')
PYEOF
```

- `closeDb()` now keys off `kdb`, so it also closes a Postgres-opened `state.db` (`raw` is null there).
- Its final clear checks `kdb`, which a reopen sets again, instead of `db`.
- On SQLite both were set and cleared together, so nothing changes there.

- [ ] **Step 5: Run the tests on both dialects**

Run: `CI=true npm run test:unit:pg`
Expected: PASS. 13 tests in 3 files. The parity test proves each baseline has the same tables, columns, NOT NULL, primary keys and unique keys as SQLite at v14 / v5. The migration test proves concurrent migrators run the baseline once, a failing step rolls back, and a missing schema is refused.

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src`
Expected: exit 0. PASS. The new files' Postgres-only tests skip on SQLite.

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add src/main/store src/main/db.ts src/main/inbox/inboxDb.ts vitest.pg.config.ts
git -C "$WT" commit -m "feat(store): Postgres baselines and migration tracks; state.db and inbox open on Postgres

Baselines mirror state v14 / inbox v5 (pinned by schemaParity.test.ts):
BIGINT, TEXT COLLATE \"C\", identity ids, vector(384) embeddings.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Result-order parity (#491 cost-row order, latest-session tiebreak) and snapshot reads

**Files:**
- Modify: `src/main/store/kysely.ts`, `src/main/store/kysely.test.ts`, `src/main/db.ts`, `src/main/dbSessionsList.test.ts`, `src/main/dbReadCharacterization.test.ts`, `src/main/__snapshots__/dbReadCharacterization.test.ts.snap`, `vitest.pg.config.ts`

**Interfaces:**
- Consumes: `openTestState` (Task 2).
- Produces: `readTransaction<DB, T>(k, fn): Promise<T>` in `store/kysely.ts`.

- [ ] **Step 1: Write the failing tests**

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit
edit('src/main/store/kysely.test.ts', [
    ("import { sqliteKysely, num, chunked } from './kysely.js';",
     "import { sqliteKysely, num, chunked, readTransaction } from './kysely.js';", 1),
])
open('src/main/store/kysely.test.ts', 'a').write('''
describe('readTransaction', () => {
  it('runs the callback in one transaction on SQLite and returns its value', async () => {
    const { k } = fresh();
    await k.insertInto('t').values({ v: 1 }).execute();
    expect(await readTransaction(k, (trx) => trx.selectFrom('t').select('v').execute())).toEqual([{ v: 1 }]);
    await k.destroy();
  });
});
''')
s = open('src/main/dbSessionsList.test.ts').read()
assert s.rstrip().endswith('});')
s = s.rstrip()[:-3] + '''
  it('orders sessions tied on last_active_at by id', async () => {
    for (const id of ['s-b', 's-a', 's-c']) {
      await ingestLine('ws-tie', id, JSON.stringify({ type: 'ai-title', aiTitle: id, sessionId: id }));
    }
    expect((await listSessions('ws-tie')).map((s) => s.id)).toEqual(['s-a', 's-b', 's-c']);
    expect((await listSessionIds()).filter((id) => id.startsWith('s-'))).toEqual(['s-a', 's-b', 's-c']);
    expect(await latestSessionId('ws-tie')).toBe('s-a');
  });
});
'''
open('src/main/dbSessionsList.test.ts', 'w').write(s)
PYEOF
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true npx vitest run src/main/store/kysely.test.ts src/main/dbSessionsList.test.ts`
Expected: FAIL.
- `readTransaction` is not exported.
- The tie test gets `['s-b', 's-a', 's-c']`: insertion order, the old SQLite tiebreak.

- [ ] **Step 3: Implement the order fixes and the read transaction; record the #491 snapshot change**

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit, add_pg_suite
edit('src/main/store/kysely.ts', [
    ("import { Kysely, SqliteDialect, type SqliteDatabase } from 'kysely';",
     "import { Kysely, SqliteDialect, type SqliteDatabase, type Transaction } from 'kysely';", 1),
])
open('src/main/store/kysely.ts', 'a').write('''
/** A multi-query read on one snapshot: REPEATABLE READ, READ ONLY on Postgres
 *  (no write lock, no serialization failures); a plain transaction on SQLite,
 *  whose driver ignores the settings. */
export function readTransaction<DB, T>(k: Kysely<DB>, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return k.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(fn);
}
''')
LATEST = ".orderBy((eb) => eb.fn.coalesce('last_active_at', eb.lit(0)), 'desc')"
edit('src/main/db.ts', [
    ("import { sqliteKysely, num, chunked } from './store/kysely.js';",
     "import { sqliteKysely, num, chunked, readTransaction } from './store/kysely.js';", 1),
    (f"""    {LATEST}
    .limit(1)""", f"""    {LATEST}
    .orderBy('id', 'asc')
    .limit(1)""", 1),
    (f"""      {LATEST}
      .execute();""", f"""      {LATEST}
      .orderBy('id', 'asc')
      .execute();""", 1),
    (f"""    {LATEST}
    .execute();
  return rows.map((r) => r.id);""", f"""    {LATEST}
    .orderBy('id', 'asc')
    .execute();
  return rows.map((r) => r.id);""", 1),
    ("""  summaryRecomputes++;
  return kyselyOrThrow().transaction().execute(async (trx) => {""", """  summaryRecomputes++;
  return readTransaction(kyselyOrThrow(), async (trx) => {""", 1),
    ("""  const scoped = workspaceId !== undefined && workspaceId !== '';
  return kyselyOrThrow().transaction().execute(async (trx) => {""", """  const scoped = workspaceId !== undefined && workspaceId !== '';
  return readTransaction(kyselyOrThrow(), async (trx) => {""", 1),
    ("""    .groupBy(['workspace_id', 'model', 'service_tier'])
    .execute();""", """    .groupBy(['workspace_id', 'model', 'service_tier'])
    .orderBy('workspace_id')
    .orderBy('model', (ob) => ob.asc().nullsFirst())
    .orderBy('service_tier', (ob) => ob.asc().nullsFirst())
    .execute();""", 1),
    ("""    .$if(workspaceId !== undefined, (qb) => qb.where('workspace_id', '=', workspaceId as string));
}""", """    .$if(workspaceId !== undefined, (qb) => qb.where('workspace_id', '=', workspaceId as string))
    .orderBy(['session_id', 'workspace_id', 'session_costs.model', 'session_costs.service_tier']);
}""", 1),
])
edit('src/main/__snapshots__/dbReadCharacterization.test.ts.snap', [
    ('"usd": 0.7534357500000001,', '"usd": 0.75343575,', 1),
])
edit('src/main/dbReadCharacterization.test.ts', [
    ("""import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
""", "", 1),
    ("""import { WS, S, FIXTURE } from './state/ingestFixture.js';
""", """import { WS, S, FIXTURE } from './state/ingestFixture.js';
import { openTestState, type TestState } from './store/testStore.js';
""", 1),
    ("""let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cf-read-char-'));
  db.openDb(dir);""", """let st: TestState;
beforeEach(async () => {
  st = await openTestState('cf-read-char-');""", 1),
    ("""afterEach(async () => {
  await db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});""", """afterEach(() => st.close());""", 1),
    ("""  const raw = db.openDb(dir);
  raw.prepare(`
    INSERT INTO broker_sessions (workspace_id, broker_session_id, claude_session_id, learned_at, verified)
    VALUES (?, ?, ?, ?, 0)
  `).run(WS, 'tab-unverified', S, Date.now());""", """  await db.stateKysely().insertInto('broker_sessions')
    .values({ workspace_id: WS, broker_session_id: 'tab-unverified', claude_session_id: S, learned_at: Date.now(), verified: 0 })
    .execute();""", 1),
])
add_pg_suite('src/main/dbReadCharacterization.test.ts')
# Raw key columns, not the nullif(…) output aliases: '' sorts first on both
# dialects, where NULL sorts first on SQLite and last on Postgres.
edit('src/main/db.ts', [
    ("""    .where('session_id', '=', sessionId)
    .orderBy('workspace_id')
    .orderBy('model')
    .orderBy('service_tier')
    .execute();""", """    .where('session_id', '=', sessionId)
    .orderBy(['workspace_id', 'session_costs.model', 'session_costs.service_tier'])
    .execute();""", 1),
    ("""    .groupBy(['model', 'service_tier'])
    .orderBy('model')
    .orderBy('service_tier')
    .execute();""", """    .groupBy(['model', 'service_tier'])
    .orderBy(['session_costs.model', 'session_costs.service_tier'])
    .execute();""", 1),
])
PYEOF
```

The snapshot edit is the one deliberate change (D26). Check it is the only one:

```bash
git -C "$WT" diff --stat -- src/main/__snapshots__/
```

Expected: `dbReadCharacterization.test.ts.snap | 2 +-`.

- [ ] **Step 4: Run both dialects**

Run: `CI=true npx vitest run src/main/store/kysely.test.ts src/main/dbSessionsList.test.ts src/main/dbReadCharacterization.test.ts src/main/dbSessionCosts.test.ts src/main/dbSessionStats.test.ts src/main/db.planUsage.test.ts`
Expected: PASS. The read snapshot passes with the one updated line. The `EXPLAIN QUERY PLAN` pins in `dbSessionCosts`/`dbSessionStats` are unchanged.

Run: `CI=true npm run test:unit:pg`
Expected: PASS. 15 tests in 4 files. Both read snapshots pass on Postgres against the SQLite-recorded `.snap` (D27).

Mutation check (Postgres): revert only the `listSessionCostsQuery` `.orderBy([...])` line and re-run `CI=true npm run test:unit:pg`.
Expected: FAIL on `listSessions` `usd`, with `0.7534357500000001` or a re-ordered cost sum. Restore the line.

- [ ] **Step 5: Full gate and commit**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src`
Expected: exit 0, PASS.

```bash
git -C "$WT" add src/main/store/kysely.ts src/main/store/kysely.test.ts src/main/db.ts src/main/dbSessionsList.test.ts \
  src/main/dbReadCharacterization.test.ts src/main/__snapshots__/dbReadCharacterization.test.ts.snap vitest.pg.config.ts
git -C "$WT" commit -m "fix(state): canonical cost-row order, latest-session tiebreak, snapshot read transactions

listSessionCostsQuery orders by its key (#491): listSessions usd for the read
fixture becomes 0.75343575 (was 0.7534357500000001), the one deliberate
snapshot change. Latest-session ties break by id; planUsageRows and the
cost readers order by raw key columns. Summary and listSessions run in
readTransaction (REPEATABLE READ, READ ONLY on Postgres).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The `state.db` test suite on both dialects

**Files:**
- Modify:
  - `src/main/state/ingestFixture.ts`, `vitest.pg.config.ts`;
  - the tests `src/main/db.test.ts`, `db.ingestAnchor.test.ts`, `db.planUsage.test.ts`, `db.usageAnchors.test.ts`, `dbEmbeddings.test.ts`, `dbIngestBatch.test.ts`, `dbReadCache.test.ts`, `dbSessionCosts.test.ts`, `dbSessionStats.test.ts`, `dbSessionsList.test.ts`, `dbSummaries.test.ts`, `perfStore.test.ts`, `transcriptIndex.test.ts` (all in `src/main/`).

**Interfaces:**
- Consumes: `openTestState`, `queryRows`, `isPg` (Task 2).
- Produces: `dump(): Promise<Record<string, unknown[]>>` (async, no argument).

- [ ] **Step 1: Save the converter**

```bash
cat > /tmp/conv-pg-tests.py <<'PYEOF'
#!/usr/bin/env python3
"""Mechanical dual-dialect conversion of state.db tests (async store part 3).

usage: python3 /tmp/conv-pg-tests.py file1.test.ts [file2.test.ts ...]

1. `dir = mkdtempSync(join(tmpdir(), 'p')); [raw = |db = ][db.]openDb(dir);`
   -> `st = await openTestState('p'); dir = st.dir;` (+ `let st: TestState;`).
2. `await [db.]closeDb(); rmSync(dir, { recursive: true, force: true });` -> `await st.close();`
3. On a raw handle (`openDb(dir)`, `db.openDb(dir)`, or a name assigned from one):
   `.prepare(SQL).get(ARGS)` -> `(await queryRows(SQL, [ARGS]))[0]`,
   `.prepare(SQL).all|run(ARGS)` -> `(await queryRows(SQL, [ARGS]))`, `.exec(SQL)` -> `await queryRows(SQL)`.
4. `function f(d: Database.Database): void {` -> `async function f(): Promise<void> {`; `f(d);` -> `await f();`.
5. `const X = [db.]openDb(dir);` is dropped when X is unused before the next `it(`.
6. `dump(raw)` -> `await dump()`.
7. Adds `import { openTestState, queryRows, type TestState } from '<rel>/store/testStore.js';` (names used).
Anything else that now awaits is left for tsc (TS1308), as in parts 2a/2b.
"""
import os, re, sys

def match_paren(s, i):
    depth, j, in_str = 0, i, None
    while j < len(s):
        ch = s[j]
        if in_str:
            if ch == '\\': j += 2; continue
            if ch == in_str: in_str = None
        elif ch in '\'"`': in_str = ch
        elif ch == '(': depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0: return j
        j += 1
    raise ValueError('unbalanced at %d' % i)

def convert_calls(s, names):
    recv = re.compile(r'((?:db\.)?openDb\(dir\)|\b(?:' + '|'.join(map(re.escape, names or ['__none__'])) + r'))\s*$')
    out, i = [], 0
    while True:
        hits = [h for h in (s.find('.prepare(', i), s.find('.exec(', i)) if h >= 0]
        if not hits: out.append(s[i:]); break
        k = min(hits)
        m = recv.search(s[:k])
        if not m or m.start(1) < i:
            out.append(s[i:k + 1]); i = k + 1; continue
        start = m.start(1)
        if s.startswith('.exec(', k):
            e_close = match_paren(s, k + len('.exec'))
            out.append(s[i:start]); out.append(f"await queryRows({s[k + len('.exec('):e_close]})")
            i = e_close + 1
            continue
        p_open = k + len('.prepare')
        p_close = match_paren(s, p_open)
        sql_text = s[p_open + 1:p_close]
        mm = re.match(r'\s*\.(get|all|run)\(', s[p_close + 1:])
        if not mm: out.append(s[i:k + 1]); i = k + 1; continue
        a_open = p_close + mm.end()
        a_close = match_paren(s, a_open)
        args = s[a_open + 1:a_close].strip()
        call = f"queryRows({sql_text}, [{args}])" if args else f"queryRows({sql_text})"
        out.append(s[i:start]); out.append(f"(await {call})[0]" if mm.group(1) == 'get' else f"(await {call})")
        i = a_close + 1
    return ''.join(out)

for path in sys.argv[1:]:
    src = open(path).read()
    s = src
    names = sorted(set(re.findall(r'\b(\w+)\s*=\s*(?:db\.)?openDb\(dir\)', s)))
    s = re.sub(r"dir = mkdtempSync\(join\(tmpdir\(\), ('[^']*')\)\);(\s*)(?:\w+ = )?(?:db\.)?openDb\(dir\);",
               r"st = await openTestState(\1);\2dir = st.dir;", s)
    s = re.sub(r"await (?:db\.)?closeDb\(\);(\s*)rmSync\(dir, \{ recursive: true, force: true \}\);", r"await st.close();", s)
    for h in re.findall(r'function (\w+)\(\w+: Database\.Database\): void \{', s):
        s = re.sub(r'function ' + h + r'\(\w+: Database\.Database\): void \{', f'async function {h}(): Promise<void> {{', s)
        s = re.sub(r'(?<![\w.])' + h + r'\(\w+\);', f'await {h}();', s)
    s = convert_calls(s, names)
    s = s.replace('dump(raw)', 'await dump()')
    lines, keep = s.split('\n'), []
    for idx, line in enumerate(lines):
        m = re.match(r'\s*const (\w+) = (?:db\.)?openDb\(dir\);\s*$', line)
        if m:
            used = False
            for nxt in lines[idx + 1:]:
                if re.match(r"\s*it\(|\s*test\(|^\}\);", nxt): break
                if re.search(r'\b' + re.escape(m.group(1)) + r'\b', nxt): used = True; break
            if not used: continue
        keep.append(line)
    s = '\n'.join(keep)
    if 'openTestState(' in s and 'let st: TestState;' not in s:
        s = re.sub(r'\n([ \t]*)(beforeEach|describe)\(', r'\n\1let st: TestState;\n\1\2(', s, count=1)
    if s != src:
        rel = os.path.relpath('src/main/store/testStore.js', os.path.dirname(path))
        if not rel.startswith('.'): rel = './' + rel
        used = [n for n in ('openTestState', 'queryRows') if re.search(r'\b' + n + r'\(', s)]
        if 'TestState;' in s: used.append('type TestState')
        last = list(re.finditer(r"^import [^;]+;\n", s, flags=re.M))[-1]
        s = s[:last.end()] + f"import {{ {', '.join(used)} }} from '{rel}';\n" + s[last.end():]
        open(path, 'w').write(s)
        print('converted', path)
PYEOF
cat > /tmp/hand-state.py <<'PYEOF'
#!/usr/bin/env python3
"""Hand edits after conv-pg-tests.py (async store part 3, Task 4). Exact replacements."""
import re
def edit(path, pairs):
    s = open(path).read()
    for old, new, count in pairs:
        n = s.count(old)
        assert n == count, f'{path}: expected {count} of {old!r}, found {n}'
        s = s.replace(old, new)
    open(path, 'w').write(s)

edit('src/main/db.test.ts', [
    ("\nlet st: TestState;\ndescribe('recordError'", "\ndescribe('recordError'", 1),
    ("""function freshDb() {
  const st = await openTestState('cf-db-');
  dir = st.dir;
  return dir;
}""", """let st: TestState | null = null;
async function freshDb(): Promise<string> {
  st = await openTestState('cf-db-');
  return st.dir;
}""", 1),
    ("    const dir = freshDb();", "    const dir = await freshDb();", 23),
    ("afterEach(() => closeDb());", "afterEach(async () => {\n  await st?.close();\n  st = null;\n});", 1),
    ("""      await closeDb();
      openDb(dir); // reopen — in-memory pending set must rehydrate from the row""",
     """      await st!.reopen(); // in-memory pending set must rehydrate from the row""", 1),
    ("""      const closing = closeDb();
      // Reopen before closeDb's post-await clears run: rehydrate repopulates
      // the pending set from the row, still committed, on disk.
      openDb(dir);
      await closing;""",
     """      const closing = closeDb();
      // Reopen before closeDb's post-await clears run: rehydrate repopulates
      // the pending set from the row, still committed.
      const reopened = st!.open();
      await closing;
      await reopened;""", 1),
])

edit('src/main/db.test.ts', [
    ("import { SqliteDriver } from 'kysely';", "import { PostgresDriver, SqliteDriver } from 'kysely';", 1),
    ("import { openTestState, queryRows, type TestState } from './store/testStore.js';",
     "import { openTestState, queryRows, isPg, type TestState } from './store/testStore.js';\n\n"
     "/** The driver whose commitTransaction the store's transactions end in. */\n"
     "const driverProto: Pick<SqliteDriver, 'commitTransaction'> = isPg ? PostgresDriver.prototype : SqliteDriver.prototype;", 1),
    (".spyOn(SqliteDriver.prototype, 'commitTransaction')", ".spyOn(driverProto, 'commitTransaction')", 2),
])
edit('src/main/dbSessionCosts.test.ts', [
    ("(await queryRows(`INSERT OR IGNORE INTO sessions (id, workspace_id) VALUES (?,?)`, [SES_A, WS1]));",
     "await queryRows(`INSERT INTO sessions (id, workspace_id) VALUES (?,?) ON CONFLICT DO NOTHING`, [SES_A, WS1]);", 1),
    ("(await queryRows(`INSERT OR IGNORE INTO sessions (id, workspace_id) VALUES (?,?)`, [SES_B, WS2]));",
     "await queryRows(`INSERT INTO sessions (id, workspace_id) VALUES (?,?) ON CONFLICT DO NOTHING`, [SES_B, WS2]);", 1),
])
edit('src/main/dbIngestBatch.test.ts', [
    ("    raw = db.openDb(dir); // afterEach closes it again\n", "    await st.open(); // afterEach closes it again\n", 1),
])
edit('src/main/perfStore.test.ts', [
    ("import { openTestState, queryRows, type TestState } from './store/testStore.js';",
     "import { openTestState, queryRows, isPg, type TestState } from './store/testStore.js';", 1),
    ("  it('migration creates perf_events with the expected columns'", "  it.skipIf(isPg)('migration creates perf_events with the expected columns'", 1),
])
edit('src/main/dbEmbeddings.test.ts', [
    ("dim: 3,", "dim: EMBED_DIM,", 3),
    ("encodeVector(Float32Array.from([1, 0, 0]))", "encodeVector(unitVec())", 3),
    ("const SES = 'ses-1';\n", "const SES = 'ses-1';\n/** Postgres stores vector(EMBED_DIM), so test vectors are full-width. */\nconst unitVec = (): Float32Array => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; };\n", 1),
])
PYEOF
```

The hand edits handle:
- `db.test.ts`'s `freshDb()` helper and its two reopen tests (`st.reopen()`, and `st.open()` racing `closeDb()`);
- the commit-failure spy, which follows the dialect's driver;
- one `INSERT OR IGNORE`;
- `closeDb waits` reopening;
- `perfStore`'s `PRAGMA` test (SQLite-only);
- full-width test vectors in `dbEmbeddings`.

- [ ] **Step 2: Convert, move `dump()` onto Kysely, add the files to the suite**

```bash
F="src/main/db.test.ts src/main/dbSessionCosts.test.ts src/main/dbSessionStats.test.ts src/main/dbSessionsList.test.ts src/main/dbSummaries.test.ts src/main/dbReadCache.test.ts src/main/dbEmbeddings.test.ts src/main/db.planUsage.test.ts src/main/db.usageAnchors.test.ts src/main/db.ingestAnchor.test.ts src/main/transcriptIndex.test.ts src/main/perfStore.test.ts src/main/dbIngestBatch.test.ts"
python3 /tmp/conv-pg-tests.py $F
python3 /tmp/hand-state.py
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit, add_pg_suite
edit('src/main/state/ingestFixture.ts', [
    ("import type Database from 'better-sqlite3';\n", "import { sql } from 'kysely';\nimport { stateKysely } from '../db.js';\n", 1),
    ("""export function dump(raw: Database.Database): Record<string, unknown[]> {
  const q = (sqlText: string): unknown[] => raw.prepare(sqlText).all();
  return {
    events: q(`""", """export async function dump(): Promise<Record<string, unknown[]>> {
  const q = async (sqlText: string): Promise<unknown[]> => (await sql.raw(sqlText).execute(stateKysely())).rows as unknown[];
  return {
    events: await q(`""", 1),
    ("    sessions: q(`", "    sessions: await q(`", 1),
    ("    session_costs: q(`", "    session_costs: await q(`", 1),
    ("    session_stats: q(`", "    session_stats: await q(`", 1),
    ("    session_tool_counts: q(`", "    session_tool_counts: await q(`", 1),
    ("    session_summaries: q(`", "    session_summaries: await q(`", 1),
    ("    session_tags: q(`", "    session_tags: await q(`", 1),
    ("    usage_anchors: q(`", "    usage_anchors: await q(`", 1),
])
add_pg_suite(*'''src/main/db.test.ts src/main/dbSessionCosts.test.ts src/main/dbSessionStats.test.ts src/main/dbSessionsList.test.ts
src/main/dbSummaries.test.ts src/main/dbReadCache.test.ts src/main/dbEmbeddings.test.ts src/main/db.planUsage.test.ts
src/main/db.usageAnchors.test.ts src/main/db.ingestAnchor.test.ts src/main/transcriptIndex.test.ts src/main/perfStore.test.ts
src/main/dbIngestBatch.test.ts'''.split())
PYEOF
```

Expected: 13 `converted …` lines and no assertion error.

- [ ] **Step 3: Typecheck, and check for missing awaits**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: exit 0.

Run: `/usr/bin/grep -nE "^\s+(queryRows|freshDb|dump|expectRollupMatchesEvents|expectRollupsMatchEvents)\(" $F`
Expected: no output.

- [ ] **Step 4: Run both dialects**

Run: `CI=true npx vitest run $F src/main/dbReadCharacterization.test.ts`
Expected: PASS. Every test passes on SQLite, and 2a's ingest snapshot is unmodified (`git -C "$WT" diff --stat -- src/main/__snapshots__/dbIngestBatch.test.ts.snap` prints nothing).

Run: `CI=true npm run test:unit:pg`
Expected: PASS, about 120 tests in 17 files. One skips: `perfStore`'s PRAGMA test. The ingest snapshot passes on Postgres, event ids included.

- [ ] **Step 5: Full gate and commit**

Run: `npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src`
Expected: exit 0, PASS.

```bash
git -C "$WT" add $F src/main/state/ingestFixture.ts vitest.pg.config.ts
git -C "$WT" commit -m "test(state): state.db store tests run on SQLite and Postgres

openTestState/queryRows replace raw-handle fixtures; the ingest and read
characterization snapshots arbitrate both dialects.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The inbox store test suite on both dialects

**Files:**
- Modify:
  - `src/main/store/testStore.ts` (replaced), `vitest.pg.config.ts`;
  - the tests `src/main/inbox/inboxDb.test.ts`, `notifyStore.test.ts`, `inboxService.test.ts`, `notifyService.test.ts`, and `src/main/automations/automationStore.test.ts`, `automationService.test.ts`, `loadoutInstaller.test.ts`, `proposalService.test.ts`, `runner.test.ts`.

**Interfaces:**
- Consumes: `openTestInbox` (Task 2).
- Produces:
  - `countQueries(store: InboxStore): { count(): number }`, which replaces the four local copies;
  - `settle(store): Promise<void>`.

- [ ] **Step 1: Replace `src/main/store/testStore.ts`**

```ts
// Test support: open state.db / inbox on the dialect STORE_TEST_DIALECT names.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type Database from 'better-sqlite3';
import { CompiledQuery, type Kysely } from 'kysely';
import { createPgPool } from './postgres.js';
import * as db from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';

export const isPg = process.env.STORE_TEST_DIALECT === 'postgres';
const POOL_MAX = Number(process.env.PG_TEST_POOL_MAX ?? 4);
/** Tests that need concurrent connections skip on a single-connection server. */
export const pgMultiConnection = isPg && POOL_MAX > 1;

export interface TestPg { pool: pg.Pool; schema: string; drop(): Promise<void> }

/** A fresh schema on PG_TEST_URL; drop() removes it and ends the pool. */
export async function testPgSchema(): Promise<TestPg> {
  const url = process.env.PG_TEST_URL;
  if (!url) throw new Error('STORE_TEST_DIALECT=postgres needs PG_TEST_URL');
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const pool = createPgPool({ connectionString: url, schema, max: POOL_MAX });
  await pool.query(`CREATE SCHEMA ${schema}`);
  return {
    pool, schema,
    async drop() {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}

export interface TestState {
  dir: string;
  pg: TestPg | null;
  /** Open the same database again (after, or racing, a closeDb). */
  open(): Promise<void>;
  /** closeDb, then open(). */
  reopen(): Promise<void>;
  close(): Promise<void>;
}

/** openDb on a fresh tmpdir (SQLite) or openDbPostgres on a fresh schema. */
export async function openTestState(prefix = 'cf-state-'): Promise<TestState> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const t = isPg ? await testPgSchema() : null;
  const open = async () => { if (t) await db.openDbPostgres(t.pool); else db.openDb(dir); };
  await open();
  return {
    dir, pg: t, open,
    async reopen() { await db.closeDb(); await open(); },
    async close() {
      await db.closeDb();
      await t?.drop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const inboxPools = new WeakMap<InboxStore, pg.Pool>();

/** InboxStore.memory() (SQLite) or a fresh-schema store whose close() drops it. */
export async function openTestInbox(): Promise<InboxStore> {
  if (!isPg) return InboxStore.memory();
  const t = await testPgSchema();
  const store = await InboxStore.openPostgres(t.pool);
  inboxPools.set(store, t.pool);
  const close = store.close.bind(store);
  store.close = async () => { await close(); await t.drop(); };
  return store;
}

/** Raw SQL with `?` placeholders on either dialect (state.db by default). */
export async function queryRows<T = Record<string, unknown>>(
  text: string, params: readonly unknown[] = [], k: Kysely<unknown> = db.stateKysely() as Kysely<unknown>,
): Promise<T[]> {
  let n = 0;
  const q = isPg ? text.replace(/\?/g, () => `$${++n}`) : text;
  return (await k.executeQuery<T>(CompiledQuery.raw(q, [...params]))).rows;
}

/** Counts the statements an inbox store sends from now on (SQLite: prepares on
 *  its connection; Postgres: client queries), to pin "constant round trips, not N+1". */
export function countQueries(s: InboxStore): { count(): number } {
  let n = 0;
  const pool = inboxPools.get(s);
  if (!pool) {
    const raw = (s as unknown as { raw: Database.Database }).raw;
    const orig = raw.prepare.bind(raw);
    raw.prepare = ((text: string) => { n++; return orig(text); }) as typeof raw.prepare;
    return { count: () => n };
  }
  const seen = new WeakSet<pg.PoolClient>();
  const connect = pool.connect.bind(pool) as (cb?: unknown) => Promise<pg.PoolClient>;
  // pool.query() passes a callback; only the promise form is Kysely's.
  pool.connect = ((cb?: unknown) => (cb ? connect(cb) : counted())) as typeof pool.connect;
  const counted = async (): Promise<pg.PoolClient> => {
    const c = await connect();
    if (!seen.has(c)) {
      seen.add(c);
      const q = c.query.bind(c) as (...a: unknown[]) => unknown;
      (c as { query: unknown }).query = (...a: unknown[]) => {
        if (!/^SET search_path/.test(String(a[0]))) n++;
        return q(...a);
      };
    }
    return c;
  };
  return { count: () => n };
}

const turn = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** Let timer-started store work finish: three macrotask turns (SQLite does no
 *  I/O), then on Postgres until every pooled client is idle for two checks. */
export async function settle(s: InboxStore): Promise<void> {
  for (let i = 0; i < 3; i++) await turn();
  const pool = inboxPools.get(s);
  if (!pool) return;
  for (let quiet = 0; quiet < 2;) {
    await new Promise<void>((r) => setTimeout(r, 5));
    quiet = pool.waitingCount === 0 && pool.idleCount === pool.totalCount ? quiet + 1 : 0;
    await turn();
  }
}
```

- [ ] **Step 2: Save the converter and the hand edits**

```bash
cat > /tmp/conv-pg-inbox.py <<'PYEOF'
#!/usr/bin/env python3
"""Mechanical dual-dialect conversion of inbox-store tests (async store part 3).

usage: python3 /tmp/conv-pg-inbox.py file1.test.ts [file2.test.ts ...]

1. `InboxStore.memory()` -> `(await openTestInbox())`.
2. A `function NAME(` whose body now awaits becomes `async function NAME(`, and
   every call `NAME(` becomes `await NAME(` (repeats until stable).
3. it/test/hook callbacks of the form `() => {` become async.
4. A local `function countQueries(...) {...}` is deleted; testStore's is imported.
5. Adds `import { openTestInbox[, countQueries] } from '<rel>/store/testStore.js';`.
"""
import os, re, sys

def match(s, j, o, c):
    depth, in_str = 0, None
    while j < len(s):
        ch = s[j]
        if in_str:
            if ch == '\\': j += 2; continue
            if ch == in_str: in_str = None
        elif ch in '\'"`': in_str = ch
        elif ch == o: depth += 1
        elif ch == c:
            depth -= 1
            if depth == 0: return j
        j += 1
    raise ValueError(j)

def block_end(s, i):
    """End of the body of the function declared at i (skips params and a return type)."""
    p_close = match(s, s.index('(', i), '(', ')')
    m = re.compile(r'\s*(?::\s*(?:\{[^{}]*\}|[^{=]+?))?\s*\{').match(s, p_close + 1)
    return match(s, m.end() - 1, '{', '}')

for path in sys.argv[1:]:
    src = open(path).read()
    s = src.replace('InboxStore.memory()', '(await openTestInbox())')
    m = re.search(r'\n(?:/\*\*(?:(?!\*/)[\s\S])*\*/\n)?function countQueries\([\s\S]*?\n\}\n', s)
    had_counter = bool(m)
    if m:
        s = s[:m.start()] + '\n' + s[m.end():]
    changed = True
    while changed:
        changed = False
        for fm in re.finditer(r'(?<!async )\bfunction (\w+)\(', s):
            end = block_end(s, fm.start())
            if 'await ' in s[fm.start():end]:
                name = fm.group(1)
                s = s[:fm.start()] + 'async ' + s[fm.start():]
                s = re.sub(r'(?<![\w.])(?<!await )(?<!function )' + name + r'\(', 'await ' + name + '(', s)
                changed = True
                break
    s = re.sub(r"\b(it|test|beforeEach|afterEach|beforeAll|afterAll)\((['\"`][^\n]*?['\"`]\s*,\s*)?\(\) => \{",
               lambda mm: f"{mm.group(1)}({mm.group(2) or ''}async () => {{", s)
    if s != src:
        rel = os.path.relpath('src/main/store/testStore.js', os.path.dirname(path))
        if not rel.startswith('.'): rel = './' + rel
        names = ['openTestInbox'] + (['countQueries'] if had_counter else [])
        last = list(re.finditer(r"^import [^;]+;\n", s, flags=re.M))[-1]
        s = s[:last.end()] + f"import {{ {', '.join(names)} }} from '{rel}';\n" + s[last.end():]
        open(path, 'w').write(s)
        print('converted', path)
PYEOF
cat > /tmp/hand-inbox.py <<'PYEOF'
#!/usr/bin/env python3
"""Hand edits after conv-pg-inbox.py (async store part 3, Task 5). Exact replacements."""
def edit(path, pairs):
    s = open(path).read()
    for old, new, count in pairs:
        n = s.count(old)
        assert n == count, f'{path}: expected {count} of {old!r}, found {n}'
        s = s.replace(old, new)
    open(path, 'w').write(s)

edit('src/main/inbox/notifyService.test.ts', [
    ("const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r)); };",
     "const flush = () => settle(inbox);", 1),
    ("import { openTestInbox, countQueries } from '../store/testStore.js';",
     "import { openTestInbox, countQueries, settle } from '../store/testStore.js';", 1),
])
edit('src/main/inbox/inboxDb.test.ts', [
    ("import { openTestInbox, countQueries } from '../store/testStore.js';",
     "import { openTestInbox, countQueries, isPg } from '../store/testStore.js';", 1),
    ("describe('InboxStore.open', () => {", "describe.skipIf(isPg)('InboxStore.open', () => {", 1),
])
PYEOF
```

- [ ] **Step 3: Convert and add the files to the suite**

```bash
G="src/main/inbox/inboxDb.test.ts src/main/inbox/notifyStore.test.ts src/main/inbox/inboxService.test.ts src/main/inbox/notifyService.test.ts src/main/automations/automationStore.test.ts src/main/automations/automationService.test.ts src/main/automations/loadoutInstaller.test.ts src/main/automations/proposalService.test.ts src/main/automations/runner.test.ts"
python3 /tmp/conv-pg-inbox.py $G
python3 /tmp/hand-inbox.py
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import add_pg_suite
add_pg_suite(*'''src/main/inbox/inboxDb.test.ts src/main/inbox/notifyStore.test.ts src/main/inbox/inboxService.test.ts
src/main/inbox/notifyService.test.ts src/main/automations/automationStore.test.ts src/main/automations/automationService.test.ts
src/main/automations/loadoutInstaller.test.ts src/main/automations/proposalService.test.ts src/main/automations/runner.test.ts'''.split())
PYEOF
```

Expected: 9 `converted …` lines.

- [ ] **Step 4: Typecheck, and check for missing awaits**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: exit 0.

Run: `/usr/bin/grep -nE "^\s+(setup|setupWithNotify)\(|= setup\(|= setupWithNotify\(" $G`
Expected: no output. Every call is `await setup(…)`.

- [ ] **Step 5: Run both dialects**

Run: `CI=true npx vitest run $G`
Expected: PASS, 100 tests.

Run: `CI=true npm run test:unit:pg`
Expected: PASS, about 215 tests in 26 files. Three skip: the `InboxStore.open` file tests. The N+1 guards hold on Postgres (`≤ 3` statements).

- [ ] **Step 6: Full gate and commit**

Run: `npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src`
Expected: exit 0, PASS.

```bash
git -C "$WT" add $G src/main/store/testStore.ts vitest.pg.config.ts
git -C "$WT" commit -m "test(inbox): inbox, notify, automation and proposal store tests run on SQLite and Postgres

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `searchEmbeddings`: brute force on SQLite, pgvector HNSW on Postgres

**Files:**
- Create: `src/main/dbSearchEmbeddings.test.ts` (and its recorded snapshot)
- Modify: `src/main/db.ts`, `vitest.pg.config.ts`

**Interfaces:**
- Consumes: the `embeddings` baseline with `vector(384)` and the partial HNSW index (Task 2), and `pgVectorLiteral` (Task 2).
- Produces:
  - `searchEmbeddings(qvec: Float32Array, scope: readonly string[], opts: { limit: number; kind?: 'turn' | 'summary' }): Promise<EmbeddingHit[]>`;
  - `EmbeddingHit = { sessionId, workspaceId, kind, ts, text, score }`, the same shape as `SearchHit`.
  - Part 4 and c3 call `searchEmbeddings`; `searchTranscripts` (MCP, SQLite) is unchanged (D30).

- [ ] **Step 1: Write the failing test**

`src/main/dbSearchEmbeddings.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as db from './db.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from './vectors.js';
import { openTestState, type TestState } from './store/testStore.js';

let st: TestState;
beforeEach(async () => { st = await openTestState('cf-search-emb-'); });
afterEach(() => st.close());

function unit(seed: number): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < EMBED_DIM; i++) { x = (x * 9301 + 49297) % 233280; v[i] = x / 233280 - 0.5; }
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
}

it('ranks the allowed workspaces by similarity, recorded across dialects', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    workspaceId: i % 3 === 0 ? 'W-OTHER' : 'W-A', sessionId: `s${i % 7}`, kind: (i % 5 === 0 ? 'summary' : 'turn') as 'turn' | 'summary',
    refEventId: i, ts: 1000 + i, text: i % 11 === 0 ? '' : `text ${i}`, modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
    vec: encodeVector(unit(i)), dedupKey: `t${i}`,
  }));
  await db.insertEmbeddings(rows);
  const hits = await db.searchEmbeddings(unit(4), ['W-A'], { limit: 5 });
  expect(hits.map((h) => ({ ...h, score: Math.round(h.score * 1e5) / 1e5 }))).toMatchSnapshot();
  const kinds = await db.searchEmbeddings(unit(10), ['W-A', 'W-OTHER'], { limit: 3, kind: 'summary' });
  expect(kinds.map((h) => h.text)).toMatchSnapshot();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `CI=true npx vitest run src/main/dbSearchEmbeddings.test.ts`
Expected: FAIL. `db.searchEmbeddings is not a function`.

- [ ] **Step 3: Implement**

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit, add_pg_suite
edit('src/main/db.ts', [
    ("import { decodeVector } from './vectors.js';", "import { EMBED_MODEL_ID, decodeVector, topK } from './vectors.js';", 1),
    ("""/** pgvector's text form.""", """export interface EmbeddingHit {
  sessionId: string;
  workspaceId: string;
  kind: 'turn' | 'summary';
  ts: number | null;
  text: string;
  score: number;
}

/** Top `limit` embeddings in `scope` by similarity to the unit-length `qvec`,
 *  current model only, placeholders excluded. SQLite: brute-force dot product;
 *  Postgres: pgvector HNSW on cosine (1 - distance = dot for unit vectors). */
export async function searchEmbeddings(
  qvec: Float32Array, scope: readonly string[], opts: { limit: number; kind?: 'turn' | 'summary' },
): Promise<EmbeddingHit[]> {
  if (scope.length === 0) return [];
  const k = kyselyOrThrow();
  if (dialect === 'sqlite') {
    const rows = await k.selectFrom('embeddings')
      .select(['session_id as sessionId', 'workspace_id as workspaceId', 'kind', 'ts', 'text', 'vec'])
      .where('workspace_id', 'in', [...scope]).where('model_id', '=', EMBED_MODEL_ID).where('text', '<>', '')
      .$if(opts.kind !== undefined, (qb) => qb.where('kind', '=', opts.kind as 'turn' | 'summary'))
      .execute();
    return topK(qvec, rows.map((r) => ({ vec: decodeVector(r.vec) })), opts.limit)
      .map(({ index, score }) => { const { vec: _vec, ...hit } = rows[index]; return { ...hit, score }; });
  }
  const q = pgVectorLiteral(qvec);
  return k.transaction().setAccessMode('read only').execute(async (trx) => {
    // Without iterative scans the WHERE filters apply after the index's
    // candidate list and can return fewer than `limit` rows.
    await sql`SET LOCAL hnsw.iterative_scan = strict_order`.execute(trx);
    return trx.selectFrom('embeddings')
      .select(['session_id as sessionId', 'workspace_id as workspaceId', 'kind', 'ts', 'text',
        sql<number>`1 - (vec <=> ${q}::vector)`.as('score')])
      .where('workspace_id', 'in', [...scope]).where('model_id', '=', EMBED_MODEL_ID).where('text', '<>', '')
      .$if(opts.kind !== undefined, (qb) => qb.where('kind', '=', opts.kind as 'turn' | 'summary'))
      .orderBy(sql`vec <=> ${q}::vector`).orderBy('id')
      .limit(opts.limit)
      .execute();
  });
}

/** pgvector's text form.""", 1),
])
add_pg_suite('src/main/dbSearchEmbeddings.test.ts')
PYEOF
```

- [ ] **Step 4: Record the snapshot on SQLite, then hold Postgres to it**

Run (without `CI=true`, so the new snapshot is written once): `npx vitest run src/main/dbSearchEmbeddings.test.ts`
Expected: PASS, `2 written`. Open `src/main/__snapshots__/dbSearchEmbeddings.test.ts.snap` and check it. The first hit is `text 4` with score `1` (the query is row 4's own vector). No hit has empty text or workspace `W-OTHER`. The `kind: 'summary'` list holds only summary rows, which are the indices divisible by 5.

Run: `CI=true npm run test:unit:pg`
Expected: PASS. pgvector returns the same rows, in the same order, with scores equal to the brute-force dot product at 5 decimals.

- [ ] **Step 5: Full gate and commit**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src`
Expected: exit 0, PASS.

```bash
git -C "$WT" add src/main/db.ts src/main/dbSearchEmbeddings.test.ts src/main/__snapshots__/dbSearchEmbeddings.test.ts.snap vitest.pg.config.ts
git -C "$WT" commit -m "feat(state): searchEmbeddings: brute-force on SQLite, pgvector HNSW cosine on Postgres

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Concurrency on Postgres: invalidate-during-recompute, one-snapshot summaries, latest-wins pushes

**Files:**
- Create: `src/main/dbPgConcurrency.test.ts`
- Modify: `src/main/observabilityBroadcast.ts`, `src/main/observabilityBroadcast.test.ts`, `src/main/ipc.ts`, `vitest.pg.config.ts`

**Interfaces:**
- Consumes: `readTransaction` (Task 3), `asyncKeyedCache`'s D11 rules (2b), and `pgMultiConnection` (Task 1).
- Produces: `latestWins(): { begin(key: string): () => boolean }`.

- [ ] **Step 1: Write the Postgres-backed race tests**

`gateQuery` holds one chosen query in flight. That is how a recompute is pinned mid-transaction while a write commits on another pooled connection, which the SQLite driver can't do.

`src/main/dbPgConcurrency.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import * as db from './db.js';
import { WS, S, FIXTURE } from './state/ingestFixture.js';
import { openTestState, pgMultiConnection, type TestState } from './store/testStore.js';

/** Holds the first query whose SQL matches `re` until release(); resolves `reached` when it gets there. */
function gateQuery(pool: pg.Pool, re: RegExp) {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((r) => { release = r; });
  const hit = new Promise<void>((r) => { reached = r; });
  let armed = true;
  const connect = pool.connect.bind(pool);
  (pool as { connect: unknown }).connect = async () => {
    const client = await connect();
    const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as { query: unknown }).query = async (...a: unknown[]) => {
      if (armed && typeof a[0] === 'string' && re.test(a[0])) { armed = false; reached(); await open; }
      return query(...a);
    };
    return client;
  };
  return { reached: hit, release: () => { (pool as { connect: unknown }).connect = connect; release(); } };
}

describe.skipIf(!pgMultiConnection)('Postgres concurrency', () => {
  let st: TestState;
  beforeEach(async () => {
    st = await openTestState('cf-pg-conc-');
    for (const line of FIXTURE) await db.ingestLine(WS, S, line);
  });
  afterEach(() => st.close());

  it('an invalidation that commits during a summary recompute wins (D11)', async () => {
    const gate = gateQuery(st.pg!.pool, /from "session_stats"/);
    const stale = db.summaryForSession(S);
    await gate.reached;
    await db.deleteSession(S);
    gate.release();
    expect(await stale).not.toBeNull();
    expect(await db.summaryForSession(S)).toBeNull();
  });

  it('a summary recompute reads one snapshot while ingest commits mid-way (D12)', async () => {
    const before = await db.summaryForSession(S, 3);
    const gate = gateQuery(st.pg!.pool, /from "session_stats"/);
    const during = db.summaryForSession(S, 3);
    await gate.reached;
    await db.ingestLine(WS, S, JSON.stringify({ type: 'assistant', uuid: 'conc-1', timestamp: '2026-07-01T12:00:00.000Z',
      message: { model: 'claude-opus-4-1', usage: { input_tokens: 7, output_tokens: 7 }, content: [{ type: 'tool_use', id: 'tu-c', name: 'Bash', input: {} }] } }));
    gate.release();
    expect(await during).toEqual(before);
  });
});
```

- [ ] **Step 2: Run them, then prove each one bites**

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import add_pg_suite
add_pg_suite('src/main/dbPgConcurrency.test.ts')
PYEOF
CI=true npm run test:unit:pg
```

Expected: PASS. The two tests pin behaviour that 2b (D11) and Task 3 (`readTransaction`) already implement.

**Mutation 1 (D11).** In `src/main/asyncCache.ts`, change `if (!flight.dropped) {` to `if (true) {` and run `CI=true npm run test:unit:pg`.
Expected: FAIL. `an invalidation that commits during a summary recompute wins`: the deleted session's summary was stored and served.

**Mutation 2 (D12 on Postgres).** In `src/main/db.ts` `summaryForSessionUncached`, change `readTransaction(kyselyOrThrow(), async (trx) => {` to `kyselyOrThrow().transaction().execute(async (trx) => {` and re-run.
Expected: both tests FAIL (timeout). A read-write transaction takes the write lock, so the paused summary blocks the writer.

Restore both: `git -C "$WT" checkout -- src/main/asyncCache.ts src/main/db.ts`.

- [ ] **Step 3: Write the failing latest-wins test**

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit
edit('src/main/observabilityBroadcast.test.ts', [
    ("""  broadcastObservabilitySummary,
  type BroadcastTarget,""", """  broadcastObservabilitySummary,
  latestWins,
  type BroadcastTarget,""", 1),
])
open('src/main/observabilityBroadcast.test.ts', 'a').write('''
describe('latestWins', () => {
  it('drops a push that resolves after a later one for the same key began', () => {
    const pushes = latestWins();
    const first = pushes.begin('ws');
    const second = pushes.begin('ws');
    const other = pushes.begin('ws2');
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    expect(other()).toBe(true);
  });
  it('a push is latest until another begins', () => {
    const pushes = latestWins();
    const only = pushes.begin('ws');
    expect(only()).toBe(true);
    pushes.begin('ws');
    expect(only()).toBe(false);
  });
});
''')
PYEOF
```

Run: `CI=true npx vitest run src/main/observabilityBroadcast.test.ts`
Expected: FAIL. `latestWins is not a function`.

- [ ] **Step 4: Implement `latestWins` and use it for both summary pushes**

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit, add_pg_suite
edit('src/main/observabilityBroadcast.ts', [
    ("""export function broadcastObservabilitySummary(""", """/** Per-key push ordering: `begin(key)` returns a check that is true only while
 *  no later push for that key has begun, so an older push that resolves late
 *  is dropped instead of overwriting a newer one. */
export function latestWins(): { begin(key: string): () => boolean } {
  const seq = new Map<string, number>();
  return {
    begin(key) {
      const n = (seq.get(key) ?? 0) + 1;
      seq.set(key, n);
      return () => seq.get(key) === n;
    },
  };
}

export function broadcastObservabilitySummary(""", 1),
])
edit('src/main/ipc.ts', [
    ("import { broadcastObservabilitySummary } from './observabilityBroadcast.js';",
     "import { broadcastObservabilitySummary, latestWins } from './observabilityBroadcast.js';", 1),
    ("""  const trailingRebroadcast = makeTrailingRebroadcast(""", """  // Both pushes share one ordering: on pooled Postgres reads two summaries for
  // one workspace can resolve out of order.
  const summaryPushes = latestWins();
  const trailingRebroadcast = makeTrailingRebroadcast(""", 1),
    ("""        async () => {
          const summary = await summaryForWorkspace(workspaceId);
          broadcastObservabilitySummary(""", """        async () => {
          const isLatest = summaryPushes.begin(workspaceId);
          const summary = await summaryForWorkspace(workspaceId);
          if (!isLatest()) return;
          broadcastObservabilitySummary(""", 2),
])
add_pg_suite('src/main/dbPgConcurrency.test.ts')
PYEOF
```

(`add_pg_suite` is idempotent; Step 2 already added the file.)

- [ ] **Step 5: Full gate and commit**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src && CI=true npm run test:unit:pg`
Expected: all PASS.

```bash
git -C "$WT" add src/main/dbPgConcurrency.test.ts src/main/observabilityBroadcast.ts src/main/observabilityBroadcast.test.ts src/main/ipc.ts vitest.pg.config.ts
git -C "$WT" commit -m "feat(observability): latest-wins summary pushes; Postgres-backed cache race tests

An older summary push that resolves after a newer one began is dropped.
dbPgConcurrency pins D11 (invalidate during recompute wins) and one-snapshot
summaries on real concurrent connections (#491).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Connection config: password providers (`aws-rds-iam`), verify-full TLS, the RDS CA bundle

**Files:**
- Create: `src/main/store/passwordProvider.ts`, `src/main/store/passwordProvider.test.ts`, `src/main/store/pgSsl.ts`, `src/main/store/pgSsl.test.ts`, `src/main/store/storeConfig.ts`, `src/main/store/storeConfig.test.ts`, `docker/scripts/rds-ca-bundle.sh`
- Modify: `package.json`, `package-lock.json`, `docker/versions.yaml`

**Interfaces:**
- Produces:
  - `PasswordSource = { kind: 'static'; value } | { kind: 'env'; name } | { kind: 'aws-rds-iam'; region? }`;
  - `passwordProvider(src, { host, port, user }, env?): () => Promise<string>`;
  - `pgSsl(mode: 'disable' | 'require' | 'verify-full' | undefined, caFile?)`;
  - `StoreConfig = { kind: 'sqlite' } | PostgresStoreConfig`;
  - `PostgresStoreConfig = { kind: 'postgres'; connection: PgConnection; schema; poolMax }`;
  - `parseStoreConfig(v: unknown, { allowStaticSecrets }): StoreConfig` (throws `StoreConfigError`);
  - `pgPoolConfig(cfg, env?): PgPoolConfig`.

- [ ] **Step 1: Add the AWS SDK, pinned**

```bash
npm install --ignore-scripts --no-audit --no-fund --save-exact @aws-sdk/rds-signer@3.1162.0 @aws-sdk/credential-providers@3.1162.0
```

Expected: both appear in `dependencies` without a caret.

- [ ] **Step 2: Write the failing tests**

`src/main/store/passwordProvider.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passwordProvider } from './passwordProvider.js';

const TARGET = { host: 'fleet.cluster-abc.us-east-1.rds.amazonaws.com', port: 5432, user: 'fleet_agent' };

describe('passwordProvider', () => {
  it('static returns the value; env reads the variable on every call', async () => {
    expect(await passwordProvider({ kind: 'static', value: 's3' }, TARGET)()).toBe('s3');
    const env: NodeJS.ProcessEnv = { PGPW: 'one' };
    const p = passwordProvider({ kind: 'env', name: 'PGPW' }, TARGET, env);
    expect(await p()).toBe('one');
    env.PGPW = 'two';
    expect(await p()).toBe('two');
    delete env.PGPW;
    await expect(p()).rejects.toThrow(/PGPW is not set/);
  });

  // The default chain loads and probes lazily; first calls can be slow under load.
  describe('aws-rds-iam via the container (EKS Pod Identity) credential endpoint', { timeout: 20_000 }, () => {
    const saved = { ...process.env };
    let server: Server;
    let dir: string;
    let calls: Array<string | undefined>;
    beforeEach(async () => {
      calls = [];
      server = createServer((req, res) => {
        calls.push(req.headers.authorization);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          AccessKeyId: 'AKIDPODIDENTITY', SecretAccessKey: 'secret', Token: 'sessiontoken',
          Expiration: new Date(Date.now() + 3600_000).toISOString(),
        }));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      dir = mkdtempSync(join(tmpdir(), 'cf-podid-'));
      writeFileSync(join(dir, 'token'), 'pod-identity-token');
      for (const k of Object.keys(process.env)) if (k.startsWith('AWS_')) delete process.env[k];
      process.env.AWS_CONFIG_FILE = join(dir, 'none');
      process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'none');
      process.env.AWS_EC2_METADATA_DISABLED = 'true';
      const port = (server.address() as { port: number }).port;
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${port}/v1/credentials`;
      process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = join(dir, 'token');
    });
    afterEach(async () => {
      process.env = { ...saved };
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    });

    it('signs a connect token for the exact host, port and user with the pod credentials', async () => {
      const token = await passwordProvider({ kind: 'aws-rds-iam', region: 'us-east-1' }, TARGET)();
      expect(token.startsWith(`${TARGET.host}:5432/?`)).toBe(true);
      const q = new URLSearchParams(token.slice(token.indexOf('?') + 1));
      expect(q.get('Action')).toBe('connect');
      expect(q.get('DBUser')).toBe('fleet_agent');
      expect(q.get('X-Amz-Credential')).toMatch(/^AKIDPODIDENTITY\/\d{8}\/us-east-1\/rds-db\/aws4_request$/);
      expect(q.get('X-Amz-Security-Token')).toBe('sessiontoken');
      expect(q.get('X-Amz-Expires')).toBe('900');
      expect(calls).toContain('pod-identity-token');
    });

    it('mints a fresh token per call (one per new pool connection)', async () => {
      const p = passwordProvider({ kind: 'aws-rds-iam', region: 'us-east-1' }, TARGET);
      const a = await p();
      await new Promise((r) => setTimeout(r, 1100));
      expect(await p()).not.toBe(a);
    });

    it('needs a region', () => {
      expect(() => passwordProvider({ kind: 'aws-rds-iam' }, TARGET, {})).toThrow(/region/);
    });
  });
});
```

`src/main/store/pgSsl.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { pgSsl } from './pgSsl.js';

let hasOpenssl = true;
try { execFileSync('openssl', ['version']); } catch { hasOpenssl = false; }

/** A fake Postgres that accepts SSLRequest, completes TLS with `cert`, then hangs up. */
function fakeTlsPostgres(key: string, cert: string): Promise<{ server: Server; port: number }> {
  const server = createServer((sock) => {
    sock.once('data', () => {
      sock.write('S');
      const tls = new TLSSocket(sock, { isServer: true, key, cert });
      tls.on('secure', () => tls.destroy());
      tls.on('error', () => sock.destroy());
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as { port: number }).port })));
}

describe('pgSsl', () => {
  it('maps modes', () => {
    expect(pgSsl(undefined)).toBe(false);
    expect(pgSsl('disable')).toBe(false);
    expect(pgSsl('require')).toEqual({ rejectUnauthorized: false });
    expect(() => pgSsl('verify-full')).toThrow(/caFile/);
  });

  describe.skipIf(!hasOpenssl)('verify-full against a TLS server', () => {
    let dir: string;
    let fake: { server: Server; port: number };
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'cf-pgssl-'));
      const o = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
      o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=test-ca', '-keyout', 'ca.key', '-out', 'ca.pem']);
      o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=other-ca', '-keyout', 'other.key', '-out', 'other.pem']);
      o(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'srv.key', '-out', 'srv.csr']);
      writeFileSync(join(dir, 'ext'), 'subjectAltName=DNS:localhost\n');
      o(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext', '-out', 'srv.pem']);
      fake = await fakeTlsPostgres(readFileSync(join(dir, 'srv.key'), 'utf8'), readFileSync(join(dir, 'srv.pem'), 'utf8'));
    });
    afterAll(() => { fake.server.close(); rmSync(dir, { recursive: true, force: true }); });

    const attempt = async (host: string, ca: string): Promise<string> => {
      const c = new pg.Client({ host, port: fake.port, user: 'u', database: 'd', ssl: pgSsl('verify-full', join(dir, ca)) });
      try {
        await c.connect();
        return 'connected';
      } catch (e) {
        return (e as Error & { code?: string }).code ?? (e as Error).message;
      }
    };

    it('accepts a cert that chains to caFile and names the host', async () => {
      expect(await attempt('localhost', 'ca.pem')).not.toMatch(/CERT|SELF_SIGNED|ALTNAME|verify/i);
    });
    it('rejects a cert from another CA', async () => {
      expect(await attempt('localhost', 'other.pem')).toMatch(/UNABLE_TO_VERIFY|SELF_SIGNED|unable to verify/i);
    });
    it('rejects a hostname the cert does not name', async () => {
      expect(await attempt('127.0.0.1', 'ca.pem')).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    });
  });
});
```

`src/main/store/storeConfig.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStoreConfig, pgPoolConfig, StoreConfigError, type PostgresStoreConfig } from './storeConfig.js';

const DESKTOP = { allowStaticSecrets: false };
const HOST = { allowStaticSecrets: true };

describe('parseStoreConfig', () => {
  it('absent or sqlite is SQLite', () => {
    expect(parseStoreConfig(undefined, DESKTOP)).toEqual({ kind: 'sqlite' });
    expect(parseStoreConfig({ kind: 'sqlite' }, DESKTOP)).toEqual({ kind: 'sqlite' });
  });

  it('parses the three connection forms with defaults', () => {
    expect(parseStoreConfig({ kind: 'postgres', connectionString: 'postgres://u@db.local:5432/fleet?sslmode=verify-full' }, DESKTOP))
      .toEqual({ kind: 'postgres', schema: 'fleet', poolMax: 4, connection: { connectionString: 'postgres://u@db.local:5432/fleet?sslmode=verify-full' } });
    expect(parseStoreConfig({ kind: 'postgres', env: 'DATABASE_URL', schema: 'mine', poolMax: 8 }, DESKTOP))
      .toEqual({ kind: 'postgres', schema: 'mine', poolMax: 8, connection: { env: 'DATABASE_URL' } });
    expect(parseStoreConfig({
      kind: 'postgres', host: 'w.cluster-x.us-east-1.rds.amazonaws.com', database: 'fleet', user: 'fleet_agent',
      password: { kind: 'aws-rds-iam', region: 'us-east-1' }, caFile: '/ca.pem',
    }, HOST)).toEqual({
      kind: 'postgres', schema: 'fleet', poolMax: 4,
      connection: {
        host: 'w.cluster-x.us-east-1.rds.amazonaws.com', port: 5432, database: 'fleet', user: 'fleet_agent',
        password: { kind: 'aws-rds-iam', region: 'us-east-1' }, ssl: 'verify-full', caFile: '/ca.pem',
      },
    });
  });

  it.each([
    [{ kind: 'mysql' }, /kind must be/],
    [{ kind: 'postgres', schema: 'Bad-Name', env: 'X' }, /schema must match/],
    [{ kind: 'postgres', poolMax: 0, env: 'X' }, /poolMax/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'env', name: 'P' }, ssl: 'verify-full' }, /needs caFile/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'aws-rds-iam' }, ssl: 'require' }, /aws-rds-iam needs ssl "verify-full"/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'magic' }, ssl: 'disable' }, /password.kind/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'static', value: 'pw' }, ssl: 'disable' }, /"static" is not allowed in config.json/],
    [{ kind: 'postgres', connectionString: 'postgres://u:pw@h/d' }, /must not embed a password/],
  ])('rejects %j on the desktop', (v, re) => {
    expect(() => parseStoreConfig(v, DESKTOP)).toThrow(StoreConfigError);
    expect(() => parseStoreConfig(v, DESKTOP)).toThrow(re);
  });

  it('fleet-host may use static secrets', () => {
    expect(parseStoreConfig({ kind: 'postgres', connectionString: 'postgres://u:pw@h/d' }, HOST))
      .toMatchObject({ connection: { connectionString: 'postgres://u:pw@h/d' } });
  });
});

describe('pgPoolConfig', () => {
  it('resolves an env connection string at open time', () => {
    const cfg = parseStoreConfig({ kind: 'postgres', env: 'DATABASE_URL' }, DESKTOP) as PostgresStoreConfig;
    expect(pgPoolConfig(cfg, { DATABASE_URL: 'postgres://u@h/d' })).toEqual({ schema: 'fleet', max: 4, connectionString: 'postgres://u@h/d' });
    expect(() => pgPoolConfig(cfg, {})).toThrow(/DATABASE_URL is not set/);
  });

  it('fields get a per-connection password function and verify-full TLS on the CA file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-storecfg-'));
    try {
      writeFileSync(join(dir, 'ca.pem'), 'CA-PEM');
      const cfg = parseStoreConfig({
        kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'env', name: 'PGPW' }, caFile: join(dir, 'ca.pem'),
      }, DESKTOP) as PostgresStoreConfig;
      const opts = pgPoolConfig(cfg, { PGPW: 'secret' });
      expect(opts).toMatchObject({ schema: 'fleet', max: 4, host: 'h', port: 5432, database: 'd', user: 'u', ssl: { ca: 'CA-PEM', rejectUnauthorized: true } });
      expect(await (opts.password as () => Promise<string>)()).toBe('secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `CI=true npx vitest run src/main/store/passwordProvider.test.ts src/main/store/pgSsl.test.ts src/main/store/storeConfig.test.ts`
Expected: FAIL. `Failed to resolve import "./passwordProvider.js"` (and `./pgSsl.js`, `./storeConfig.js`).

- [ ] **Step 4: Implement**

`src/main/store/passwordProvider.ts`:

```ts
import { Signer } from '@aws-sdk/rds-signer';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

export type PasswordSource =
  | { kind: 'static'; value: string }
  | { kind: 'env'; name: string }
  | { kind: 'aws-rds-iam'; region?: string };

export interface PasswordTarget { host: string; port: number; user: string }

/** pg's async `password` option: called for every new physical connection. */
export type PasswordProvider = () => Promise<string>;

export function passwordProvider(src: PasswordSource, target: PasswordTarget, env: NodeJS.ProcessEnv = process.env): PasswordProvider {
  switch (src.kind) {
    case 'static':
      return async () => src.value;
    case 'env':
      return async () => {
        const v = env[src.name];
        if (!v) throw new Error(`store password env var ${src.name} is not set`);
        return v;
      };
    case 'aws-rds-iam': {
      const region = src.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
      if (!region) throw new Error('aws-rds-iam needs a region (password.region or AWS_REGION)');
      // Signed for the exact configured hostname: an alias would not verify.
      const signer = new Signer({
        hostname: target.host, port: target.port, username: target.user, region,
        credentials: fromNodeProviderChain(),
      });
      return () => signer.getAuthToken();
    }
  }
}
```

`src/main/store/pgSsl.ts`:

```ts
import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

export type SslMode = 'disable' | 'require' | 'verify-full';

/** pg `ssl` for a mode. verify-full = chain to `caFile` + hostname check
 *  (Node's default checkServerIdentity against the connect host). */
export function pgSsl(mode: SslMode | undefined, caFile?: string): false | ConnectionOptions {
  if (!mode || mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (!caFile) throw new Error('ssl verify-full needs caFile (the server CA bundle)');
  return { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
}
```

`src/main/store/storeConfig.ts`:

```ts
// The store choice (config.json `store`; fleet-host's `db:`). Pure: parsing
// and pg pool options only, no I/O beyond reading a configured CA file.
import type pg from 'pg';
import { passwordProvider, type PasswordSource } from './passwordProvider.js';
import { pgSsl, type SslMode } from './pgSsl.js';
import type { PgPoolConfig } from './postgres.js';

export type PgConnection =
  | { connectionString: string }
  | { env: string }
  | { host: string; port: number; database: string; user: string; password: PasswordSource; ssl: SslMode; caFile?: string };

export interface PostgresStoreConfig {
  kind: 'postgres';
  connection: PgConnection;
  /** Default 'fleet'. Must already exist; the store never creates it. */
  schema: string;
  /** Default 4. */
  poolMax: number;
}

export type StoreConfig = { kind: 'sqlite' } | PostgresStoreConfig;

export class StoreConfigError extends Error {}

export interface ParseOptions {
  /** fleet-host only: a desktop config.json is not a secret store. */
  allowStaticSecrets: boolean;
}

const fail = (m: string): never => { throw new StoreConfigError(`store: ${m}`); };
const str = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  return typeof v === 'string' && v.trim() ? v.trim() : fail(`${k} must be a non-empty string`);
};

function parsePassword(v: unknown, opts: ParseOptions): PasswordSource {
  if (!v || typeof v !== 'object') return fail('password must be { kind: "static" | "env" | "aws-rds-iam" }');
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case 'static':
      if (!opts.allowStaticSecrets) fail('password kind "static" is not allowed in config.json; use "env" or "aws-rds-iam"');
      return { kind: 'static', value: str(o, 'value') };
    case 'env':
      return { kind: 'env', name: str(o, 'name') };
    case 'aws-rds-iam':
      return o.region === undefined ? { kind: 'aws-rds-iam' } : { kind: 'aws-rds-iam', region: str(o, 'region') };
    default:
      return fail('password.kind must be "static", "env" or "aws-rds-iam"');
  }
}

function parseConnection(o: Record<string, unknown>, opts: ParseOptions): PgConnection {
  if (o.connectionString !== undefined) {
    const cs = str(o, 'connectionString');
    let url: URL;
    try { url = new URL(cs); } catch { return fail('connectionString is not a URL'); }
    if (url.password && !opts.allowStaticSecrets) fail('connectionString must not embed a password in config.json; use "env" or the discrete fields');
    return { connectionString: cs };
  }
  if (o.env !== undefined) return { env: str(o, 'env') };
  const port = o.port === undefined ? 5432 : o.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) fail('port must be an integer 1-65535');
  const ssl = o.ssl === undefined ? 'verify-full' : o.ssl;
  if (ssl !== 'disable' && ssl !== 'require' && ssl !== 'verify-full') fail('ssl must be "disable", "require" or "verify-full"');
  const password = parsePassword(o.password, opts);
  if (password.kind === 'aws-rds-iam' && ssl !== 'verify-full') fail('aws-rds-iam needs ssl "verify-full"');
  const conn: PgConnection = {
    host: str(o, 'host'), port: port as number, database: str(o, 'database'), user: str(o, 'user'),
    password, ssl: ssl as SslMode,
  };
  if (o.caFile !== undefined) conn.caFile = str(o, 'caFile');
  if (conn.ssl === 'verify-full' && !conn.caFile) fail('ssl "verify-full" needs caFile (the server CA bundle)');
  return conn;
}

/** Validate an untrusted `store` value. Absent ⇒ SQLite. */
export function parseStoreConfig(v: unknown, opts: ParseOptions): StoreConfig {
  if (v === undefined || v === null) return { kind: 'sqlite' };
  if (typeof v !== 'object') return fail('must be an object');
  const o = v as Record<string, unknown>;
  if (o.kind === 'sqlite') return { kind: 'sqlite' };
  if (o.kind !== 'postgres') return fail('kind must be "sqlite" or "postgres"');
  const schema = o.schema === undefined ? 'fleet' : str(o, 'schema');
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail('schema must match [a-z_][a-z0-9_]*');
  const poolMax = o.poolMax === undefined ? 4 : o.poolMax;
  if (typeof poolMax !== 'number' || !Number.isInteger(poolMax) || poolMax < 1 || poolMax > 32) fail('poolMax must be an integer 1-32');
  return { kind: 'postgres', connection: parseConnection(o, opts), schema, poolMax: poolMax as number };
}

/** pg pool options for a parsed Postgres store. */
export function pgPoolConfig(cfg: PostgresStoreConfig, env: NodeJS.ProcessEnv = process.env): PgPoolConfig {
  const base = { schema: cfg.schema, max: cfg.poolMax };
  const c = cfg.connection;
  if ('connectionString' in c) return { ...base, connectionString: c.connectionString };
  if ('env' in c) {
    const cs = env[c.env];
    if (!cs) throw new StoreConfigError(`store: env var ${c.env} is not set`);
    return { ...base, connectionString: cs };
  }
  const out: PgPoolConfig & pg.PoolConfig = {
    ...base, host: c.host, port: c.port, database: c.database, user: c.user,
    password: passwordProvider(c.password, { host: c.host, port: c.port, user: c.user }, env),
    ssl: pgSsl(c.ssl, c.caFile),
  };
  return out;
}
```

- [ ] **Step 5: Run the tests**

Run: `CI=true npx vitest run src/main/store/passwordProvider.test.ts src/main/store/pgSsl.test.ts src/main/store/storeConfig.test.ts`
Expected: PASS, 21 tests:
- **The fake Pod Identity endpoint:** it was called with the token file's contents. The signed token is for `fleet.cluster-abc…:5432`, `DBUser=fleet_agent`, `rds-db` in `us-east-1`, expiring in 900 s, carrying the session token. A second call mints a fresh token.
- **TLS:** verify-full accepts the right CA and hostname, and rejects another CA and a hostname mismatch (`ERR_TLS_CERT_ALTNAME_INVALID`).
- **Config:** every desktop rejection holds.

This is the "verify the minimum at implementation" step for the SDK pin: `3.1162.0` supports Pod Identity, proven by the fake endpoint test. Record it in SPEC §4 (Task 10).

Mutation check: in `pgSsl.ts` change `rejectUnauthorized: true` to `false` and re-run `pgSsl.test.ts`.
Expected: the two `rejects …` tests FAIL. Restore.

- [ ] **Step 6: The RDS CA bundle**

`docker/scripts/rds-ca-bundle.sh`:

```bash
#!/usr/bin/env bash
# Install the AWS RDS global CA bundle at <dest>, verified against the sha256
# pinned in docker/versions.yaml. Used by images that connect with verify-full.
#   docker/scripts/rds-ca-bundle.sh /usr/local/share/fleet-host/rds-global-bundle.pem
set -euo pipefail
dest=${1:?usage: rds-ca-bundle.sh <dest.pem>}
versions="$(cd "$(dirname "$0")/.." && pwd)/versions.yaml"
url=$(awk '$1 == "rds_ca_bundle_url:" { print $2 }' "$versions")
sum=$(awk '$1 == "rds_ca_bundle_sha256:" { print $2 }' "$versions")
[ -n "$url" ] && [ -n "$sum" ] || { echo "rds_ca_bundle_* missing from $versions" >&2; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL -o "$tmp" "$url"
echo "$sum  $tmp" | sha256sum -c --quiet -
install -D -m 0644 "$tmp" "$dest"
```

```bash
chmod +x docker/scripts/rds-ca-bundle.sh
python3 - <<'PYEOF'
open('docker/versions.yaml', 'a').write('''
# AWS RDS CA bundle for sslmode=verify-full (docker/scripts/rds-ca-bundle.sh).
# AWS rotates it; bump the sha256 deliberately.
rds_ca_bundle_url: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
rds_ca_bundle_sha256: 90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b
''')
PYEOF
docker/scripts/rds-ca-bundle.sh /tmp/rds-ca-check/global-bundle.pem && sha256sum /tmp/rds-ca-check/global-bundle.pem
```

Expected: `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`. If AWS has rotated the bundle since 2026-11-04, the script exits 1 with `FAILED`. Then re-pin to the new sha256 after checking the download is the AWS truststore file, and say so in the PR.

- [ ] **Step 7: Full gate and commit**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src`
Expected: exit 0, PASS.

```bash
git -C "$WT" add package.json package-lock.json docker/scripts/rds-ca-bundle.sh docker/versions.yaml \
  src/main/store/passwordProvider.ts src/main/store/passwordProvider.test.ts src/main/store/pgSsl.ts src/main/store/pgSsl.test.ts \
  src/main/store/storeConfig.ts src/main/store/storeConfig.test.ts
git -C "$WT" commit -m "feat(store): store config, password providers (static/env/aws-rds-iam), verify-full TLS, RDS CA bundle

aws-rds-iam signs per new connection with @aws-sdk/rds-signer on the default
Node chain (Pod Identity container credentials), pinned at 3.1162.0. The
desktop refuses plaintext secrets in config.json.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The store factory and the app wiring

**Files:**
- Create: `src/main/store/pgStores.ts`, `src/main/store/pgStores.test.ts`
- Modify: `src/main/config.ts`, `src/main/config.test.ts`, `src/main/mcpServer.ts`, `src/main/mcpServer.test.ts`, `src/main/index.ts`, `vitest.pg.config.ts`

**Interfaces:**
- Consumes: `parseStoreConfig`, `pgPoolConfig` (Task 8); `openDbPostgres`, `InboxStore.openPostgres` (Task 2); `WriteHook` (Task 1).
- Produces:
  - `openPgStores(cfg: PostgresStoreConfig, { state, env?, afterBeginWrite?, onPoolError }): Promise<PgStores>`, where `PgStores = { pool, inbox, end() }`;
  - `getStoreConfig(): Promise<StoreConfig>`;
  - `startMcpServer(dir, opts?: { stateDb?: boolean })`.

- [ ] **Step 1: Write the failing tests**

`src/main/store/pgStores.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import * as db from '../db.js';
import { openPgStores, type PgStores } from './pgStores.js';
import { isPg } from './testStore.js';

describe.skipIf(!isPg)('openPgStores', () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  let stores: PgStores | null = null;
  const admin = () => new pg.Client({ connectionString: process.env.PG_TEST_URL });
  afterEach(async () => {
    await stores?.inbox.close();
    await db.closeDb();
    await stores?.end();
    stores = null;
    const c = admin();
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await c.end();
  });

  it('opens state.db and the inbox on one pool, from a DATABASE_URL-style env config', async () => {
    const c = admin();
    await c.connect();
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.end();
    stores = await openPgStores({ kind: 'postgres', schema, poolMax: 2, connection: { env: 'FLEET_DB' } },
      { state: true, env: { FLEET_DB: process.env.PG_TEST_URL }, onPoolError: () => undefined });
    await db.recordUsageEvent({ workspaceId: 'W', sessionId: null, kind: 'resumed' });
    const { todo } = await stores.inbox.post({ kind: 'user', id: null }, { title: 'pg' }, 1);
    expect(await stores.inbox.get(todo.id)).toMatchObject({ title: 'pg' });
    const tracks = await stores.pool.query(`SELECT track, version FROM ${schema}.schema_migrations ORDER BY track`);
    expect(tracks.rows).toEqual([{ track: 'inbox', version: 5 }, { track: 'state', version: 14 }]);
  });

  it('fails cleanly, leaving nothing open, when the schema is missing', async () => {
    await expect(openPgStores({ kind: 'postgres', schema, poolMax: 2, connection: { connectionString: process.env.PG_TEST_URL! } },
      { state: true, onPoolError: () => undefined })).rejects.toThrow(/does not exist/);
    expect(() => db.stateKysely()).toThrow(/db not opened/);
  });
});
```

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit
edit('src/main/config.test.ts', [
    ("""  getGithubClientIdConfig
} = await import('./config.js');""", """  getGithubClientIdConfig,
  getStoreConfig
} = await import('./config.js');""", 1),
])
open('src/main/config.test.ts', 'a').write('''
describe('getStoreConfig', () => {
  it('defaults to SQLite and keeps a hand-edited store block across unrelated writes', async () => {
    expect(await getStoreConfig()).toEqual({ kind: 'sqlite' });
    const store = { kind: 'postgres', env: 'DATABASE_URL' };
    await writeFile(configPath(), JSON.stringify({ store }));
    _resetConfigCacheForTests();
    expect(await getStoreConfig()).toEqual({ kind: 'postgres', schema: 'fleet', poolMax: 4, connection: { env: 'DATABASE_URL' } });
    await setKeepRunningInTray(true);
    expect(JSON.parse(await readFile(configPath(), 'utf8')).store).toEqual(store);
  });

  it('throws on an invalid store block instead of falling back to SQLite', async () => {
    await writeFile(configPath(), JSON.stringify({ store: { kind: 'postgres', connectionString: 'postgres://u:pw@h/d' } }));
    _resetConfigCacheForTests();
    await expect(getStoreConfig()).rejects.toThrow(/must not embed a password/);
  });
});
''')
open('src/main/mcpServer.test.ts', 'a').write('''
// ---------------------------------------------------------------------------
// Postgres store: the server starts without the state.db connection
// ---------------------------------------------------------------------------

import { startMcpServer, stopMcpServer } from './mcpServer.js';

describe('startMcpServer({ stateDb: false })', () => {
  afterEach(() => stopMcpServer());

  it('history tools return an unavailable error; tools that do not read state.db still run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-mcp-pg-'));
    try {
      startMcpServer(dir, { stateDb: false });
      const hist = (await callTool({ name: 'list_sessions', arguments: {} }, WS_A)) as { isError?: boolean; content: Array<{ text: string }> };
      expect(hist.isError).toBe(true);
      expect(hist.content[0].text).toBe('Error: list_sessions is unavailable on the Postgres store');
      setConfigResolver(() => ({ probe: true }));
      const cfg = (await callTool({ name: 'get_config', arguments: {} }, WS_A)) as { isError?: boolean; content: Array<{ text: string }> };
      expect(cfg.isError).toBeUndefined();
      expect(JSON.parse(cfg.content[0].text)).toEqual({ probe: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
''')
PYEOF
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CI=true npx vitest run src/main/config.test.ts src/main/mcpServer.test.ts src/main/store/pgStores.test.ts`
Expected: FAIL.
- `getStoreConfig` is not a function.
- `startMcpServer` with `{ stateDb: false }` throws, because `state.db` doesn't exist (`fileMustExist`).
- `./pgStores.js` doesn't resolve.

- [ ] **Step 3: Implement the factory and wire it in**

`src/main/store/pgStores.ts`:

```ts
// Opens state.db's and the inbox's Postgres stores on one shared pool.
import type pg from 'pg';
import { closeDb, openDbPostgres } from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { createPgPool, type WriteHook } from './postgres.js';
import { pgPoolConfig, type PostgresStoreConfig } from './storeConfig.js';

export interface PgStores {
  pool: pg.Pool;
  inbox: InboxStore;
  /** Ends the pool; close the inbox and state.db (closeDb) first. */
  end(): Promise<void>;
}

export interface OpenPgStoresOptions {
  /** Open state.db too (false in mock mode, as for SQLite). */
  state: boolean;
  env?: NodeJS.ProcessEnv;
  afterBeginWrite?: WriteHook;
  /** An idle pooled client's error; without a listener pg would crash the process. */
  onPoolError: (e: Error) => void;
}

export async function openPgStores(cfg: PostgresStoreConfig, o: OpenPgStoresOptions): Promise<PgStores> {
  const pool = createPgPool(pgPoolConfig(cfg, o.env));
  pool.on('error', o.onPoolError);
  const hook = { afterBeginWrite: o.afterBeginWrite };
  try {
    const inbox = await InboxStore.openPostgres(pool, hook);
    try {
      if (o.state) await openDbPostgres(pool, hook);
    } catch (e) {
      await inbox.close();
      throw e;
    }
    return { pool, inbox, end: () => pool.end() };
  } catch (e) {
    await closeDb();
    await pool.end();
    throw e;
  }
}
```

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit, add_pg_suite
edit('src/main/config.ts', [
    ("""import { toggleFavorite } from './ociCore.js';""", """import { toggleFavorite } from './ociCore.js';
import { parseStoreConfig, type StoreConfig } from './store/storeConfig.js';""", 1),
    ("""  identity?: { github?: { clientId?: string } };
}""", """  identity?: { github?: { clientId?: string } };
  /** Hand-edited only: the store choice, kept verbatim and validated by
   *  getStoreConfig (store/storeConfig.ts). Absent ⇒ SQLite. */
  store?: unknown;
}""", 1),
    ("""      identity: parseIdentityConfig(parsed.identity)
    };""", """      identity: parseIdentityConfig(parsed.identity),
      store: parsed.store
    };""", 1),
    ("""/** config.json identity.github.clientId, or null.""", """/** The validated store choice. Throws StoreConfigError on an invalid `store`
 *  rather than falling back to SQLite, which would split the data. */
export async function getStoreConfig(): Promise<StoreConfig> {
  return parseStoreConfig((await read()).store, { allowStaticSecrets: false });
}

/** config.json identity.github.clientId, or null.""", 1),
])
edit('src/main/mcpServer.ts', [
    ("""let userDataDir: string | null = null;
let rodb: Database.Database | null = null;""", """let userDataDir: string | null = null;
let rodb: Database.Database | null = null;
/** Started without state.db (the Postgres store): STATE_DB_TOOLS report unavailable. */
let storeless = false;
/** Tools that read the read-only state.db connection. */
const STATE_DB_TOOLS = new Set([
  'list_sessions', 'get_session', 'get_cost', 'list_events', 'search_transcripts', 'session_summary',
  'list_errors', 'query', 'mark_useful',
]);""", 1),
    ("""export function startMcpServer(dir: string): void {
  if (rodb) return;
  const dbPath = join(dir, 'state.db');
  rodb = new Database(dbPath, { readonly: true, fileMustExist: true });
  userDataDir = dir;""", """export function startMcpServer(dir: string, opts: { stateDb?: boolean } = {}): void {
  if (userDataDir) return;
  if (opts.stateDb === false) {
    storeless = true;
  } else {
    rodb = new Database(join(dir, 'state.db'), { readonly: true, fileMustExist: true });
  }
  userDataDir = dir;""", 1),
    ("""export function ensureWorkspaceSocket(id: string): void {
  if (!rodb || !userDataDir) return;""", """export function ensureWorkspaceSocket(id: string): void {
  if (!userDataDir) return;""", 1),
    ("""  rodb = null;
  userDataDir = null;
}""", """  rodb = null;
  storeless = false;
  userDataDir = null;
}""", 1),
    ("""  if (!rodb) throw new RpcError(-32603, 'Database not open');""", """  if (!rodb && !storeless) throw new RpcError(-32603, 'Database not open');""", 1),
    ("""    stage = 'run-tool';
    const result = await tool.run(rodb, args, { callerId, allowedWorkspaces });""", """    stage = 'run-tool';
    if (!rodb && STATE_DB_TOOLS.has(name)) throw new Error(`${name} is unavailable on the Postgres store`);
    const result = await tool.run(rodb as Database.Database, args, { callerId, allowedWorkspaces });""", 1),
])
edit('src/main/index.ts', [
    ("import { app, BrowserWindow, shell, ipcMain } from 'electron';", "import { app, BrowserWindow, dialog, shell, ipcMain } from 'electron';", 1),
    ("import { getKeepRunningInTray, setKeepRunningInTray } from './config.js';",
     "import { getKeepRunningInTray, setKeepRunningInTray, getStoreConfig } from './config.js';\nimport { openPgStores, type PgStores } from './store/pgStores.js';", 1),
    ("""let inboxStore: InboxStore | null = null;
""", """let inboxStore: InboxStore | null = null;
// The Postgres store's shared pool when config.json chooses it.
let pgStores: PgStores | null = null;
""", 1),
    ("""  // Authoritative inbox (#407): opens in mock AND real mode. state.db is a
  // droppable cache gated on the JSONL watcher; the inbox is neither.
  try {
    inboxStore = InboxStore.open(app.getPath('userData'));
  } catch (e) {""", """  // A configured Postgres store that cannot open stops the launch: silently
  // using SQLite instead would split the history and inbox in two.
  try {
    const storeCfg = await getStoreConfig();
    if (storeCfg.kind === 'postgres') {
      pgStores = await openPgStores(storeCfg, {
        state: jsonlWatcher !== null,
        onPoolError: (e) => logError({ source: 'main', type: 'store-pool-error', level: 'warn', message: String(e) }),
      });
    }
  } catch (e) {
    logError({ source: 'main', type: 'store-open-failed', level: 'error', message: String(e) });
    dialog.showErrorBox('Postgres store unavailable',
      `${String(e)}\\n\\nRemove the "store" key from ${join(app.getPath('userData'), 'config.json')} to use the built-in SQLite store.`);
    app.exit(1);
    return;
  }

  // Authoritative inbox (#407): opens in mock AND real mode. state.db is a
  // droppable cache gated on the JSONL watcher; the inbox is neither.
  try {
    inboxStore = pgStores ? pgStores.inbox : InboxStore.open(app.getPath('userData'));
  } catch (e) {""", 1),
    ("""  if (jsonlWatcher) {
    openDb(app.getPath('userData'));""", """  if (jsonlWatcher) {
    if (!pgStores) openDb(app.getPath('userData'));""", 1),
    ("""    perfSpan('claude_fleet.boot.mcp_server', () => startMcpServer(app.getPath('userData')));""",
     """    perfSpan('claude_fleet.boot.mcp_server', () => startMcpServer(app.getPath('userData'), { stateDb: !pgStores }));""", 1),
    ("""  await shutdownPerf();
  await closeDb();
});""", """  await shutdownPerf();
  await closeDb();
  await pgStores?.end();
  pgStores = null;
});""", 1),
])
add_pg_suite('src/main/store/pgStores.test.ts')
PYEOF
```

What changes in `index.ts`, and what doesn't:
- **Without a `store` key (or `{ kind: 'sqlite' }`):**
  - Startup runs exactly as before: `InboxStore.open`, `openDb`, `startMcpServer(dir, { stateDb: true })`.
  - `getStoreConfig()` reads the `config.json` that `runStartupMigration`'s readers already loaded.
- **With Postgres:** `openPgStores` replaces both opens, and the MCP server starts without `state.db` (D34).
- **Failure:** a Postgres that fails stops the launch with the dialog (D33).
- **Shutdown:** the pool ends last in `before-quit`.

- [ ] **Step 4: Run the tests**

Run: `CI=true npx vitest run src/main/config.test.ts src/main/mcpServer.test.ts src/main/observabilityBroadcast.test.ts`
Expected: PASS. The MCP contract tests are unchanged, since `tools/list` is the same.

Run: `CI=true npm run test:unit:pg`
Expected: PASS, 29 files. `openPgStores` opens both stores on one pool from an env connection string. `schema_migrations` holds `inbox 5` and `state 14`. A missing schema leaves nothing open.

- [ ] **Step 5: Smoke the main bundle**

Run: `npm run build 2>&1 | tail -5`
Expected: the main bundle builds with `pg` and `@aws-sdk/*` external. If `npm run build` is env-blocked in the container (@xterm addons, per memory), say so in the PR; CI's build job is the gate.

- [ ] **Step 6: Full gate and commit**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src`
Expected: exit 0, PASS.

```bash
git -C "$WT" add src/main/store/pgStores.ts src/main/store/pgStores.test.ts src/main/config.ts src/main/config.test.ts \
  src/main/mcpServer.ts src/main/mcpServer.test.ts src/main/index.ts vitest.pg.config.ts
git -C "$WT" commit -m "feat(store): config.json store choice opens state.db and the inbox on one Postgres pool

Hand-edited store key (no UI yet). A configured Postgres that cannot open
stops the launch; MCP history tools report unavailable on Postgres.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Perf gate, SPEC.md, the c3 outline, PR

**Files:**
- Modify: `docs/SPEC.md`, `docs/superpowers/plans/2026-11-04-remote-c-3-host-store.md`

- [ ] **Step 1: Run the A/B perf gate (SQLite, D37)**

Compare `origin/main` (with 2b's bench) against HEAD, alternating three times each in one session:

```bash
BASE=/tmp/async-store-p3-base
git -C "$WT" worktree add --detach "$BASE" origin/main
ln -s "$WT/node_modules" "$BASE/node_modules"
for i in 1 2 3; do
  (cd "$BASE" && STATE_BENCH=1 STATE_BENCH_OUT=/tmp/ab3-a$i.json npx vitest run src/main/state/stateBench.test.ts >/dev/null)
  (cd "$WT"   && STATE_BENCH=1 STATE_BENCH_OUT=/tmp/ab3-b$i.json npx vitest run src/main/state/stateBench.test.ts >/dev/null)
done
cd "$WT"
STATE_BENCH=1 STATE_BENCH_BASELINE=/tmp/ab3-a1.json,/tmp/ab3-a2.json,/tmp/ab3-a3.json \
  STATE_BENCH_CANDIDATE=/tmp/ab3-b1.json,/tmp/ab3-b2.json,/tmp/ab3-b3.json \
  npx vitest run src/main/state/stateBench.test.ts --reporter=verbose 2>&1 | tee /tmp/ab3-compare.txt
git -C "$WT" worktree remove --force "$BASE"
```

Expected: PASS. **Acceptance:** every `GATE` metric satisfies `candidate ≤ baseline × (1 + tol) + slack` (D18).

The prototype of this plan measured, in this container on 2026-11-04 (median of 3 A/B pairs, while another `npm ci` ran):

| metric | before → after | limit |
|---|---|---|
| ingest_fresh_us_per_line | 69.7 → 74.8 (+7%) | +25% |
| ingest_replay_us_per_line | 23.0 → 24.3 (+6%) | +25% |
| summary_uncached_ms | 2.37 → 2.43 (+3%) | +25% |
| summary_cached_us | 7.7 → 9.6 (+25%) | +25% +15 |
| lookup_mapping_us | 8.4 → 10.8 (+29%) | +25% +15 |
| events_page_ms | 1.64 → 1.65 (0%) | +25% |
| list_sessions_ms | 0.65 → 0.84 (+29%) | +25% +0.15 |
| read_round_stall_ms | 3.8 → 4.8 (+26%) | +25% +1 |
| search_ms | 32.4 → 35.8 (+10%) | +25% |
| embed_insert_us_per_row | 77.0 → 80.5 (+4%) | +25% |
| stall_p50_ms | 18.9 → 20.1 (+7%) | +25% +2 |
| stall_max_ms | 40.4 → 40.1 (−1%) | +50% +5 |
| record_mapping_us | 162 → 154 (−5%) | +25% |
| record_error_us | 131 → 144 (+9%) | +25% |
| perf_flush_ms | 17.8 → 17.3 (−3%) | +25% |

- **`list_sessions_ms`** is the one SQLite query that really grew. The canonical cost-row `ORDER BY` adds a sort when the query is workspace-scoped, and the session list gains a tiebreak key: about +0.1–0.2 ms per Sessions-list IPC, inside D18's 0.15 ms slack plus 25%.
- **The µs metrics** (`summary_cached_us`, `lookup_mapping_us`) run code this plan doesn't touch on SQLite. They moved with the concurrent `npm ci`.
- **If a metric fails,** re-run the whole loop once; it's a regression only if it fails twice. A real regression on `list_sessions_ms` beyond the slack means a per-session query crept in. On `summary_*`, it means the summary lost the statement cache or gained a query.

- [ ] **Step 2: Update SPEC.md and the c3 outline**

```bash
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit
edit('docs/SPEC.md', [
    ("""Postgres is a second dialect of the same queries. |
""", """Postgres is a second dialect of the same queries (`src/main/store/postgres.ts`): one `pg` pool shared by both stores, `int8`/`numeric` parsed as numbers, `search_path` set per connection, in-process writes serialized per store (read-write transactions and bare writes) while reads and read-only transactions run concurrently, and multi-query reads in `readTransaction` (REPEATABLE READ, READ ONLY on Postgres; a plain transaction on SQLite). |
| Postgres driver | `pg` | The `pg` pool behind the Postgres store (§7 *JSONL→SQLite cache*, *Postgres store*). Pure JS, externalized like every main dependency. Tests run on PG 16 with pgvector 0.8.7 (CI service `pgvector/pgvector:0.8.7-pg16`; `scripts/pg-test-server.sh` where Docker is unavailable). |
| RDS IAM auth | `@aws-sdk/rds-signer` + `@aws-sdk/credential-providers` | The `aws-rds-iam` password provider: a 15-minute token per new connection, signed for the configured host and port, credentials from the default Node chain (including EKS Pod Identity container credentials). Pinned at exactly `3.1162.0`, the release verified against a fake container-credentials endpoint (`passwordProvider.test.ts`). |
""", 1),
    ("""- `config:get()` → `{ fleetRoot, sharedDir,""", """- **store** — hand-edited only (no setter channel, not in `config:get`). Absent or `{ kind: 'sqlite' }` ⇒ the SQLite files. `{ kind: 'postgres', … }` puts `state.db`'s and the inbox's tables in one Postgres schema: a connection as `connectionString`, `env` (a variable holding one, e.g. `DATABASE_URL`) or `host`/`port`/`database`/`user` + `password: { kind: 'env', name } | { kind: 'aws-rds-iam', region? }` + `ssl: 'disable' | 'require' | 'verify-full'` (default; needs `caFile`), plus `schema` (default `fleet`; must already exist) and `poolMax` (default 4). Validated by `store/storeConfig.ts:parseStoreConfig`. The desktop refuses plaintext secrets here (a `static` password, or a password inside `connectionString`) because `config.json` is not secret storage. An invalid block is a startup error, never a silent SQLite fallback. `aws-rds-iam` requires `verify-full`.
- `config:get()` → `{ fleetRoot, sharedDir,""", 1),
    ("""**Schema (v13, current):**""", """**Postgres store.** With `store: { kind: 'postgres' }` (§6 *Settings*) the same queries run on Postgres (`openDbPostgres(pool)`; `store/pgStores.ts:openPgStores` opens both stores on one pool):
- **Schema:** a baseline equal to the final SQLite schema (`store/migrations/statePg.ts`, state v14). Types: `BIGINT` for every integer, `DOUBLE PRECISION` for real, `TEXT COLLATE "C"` for every text column (byte order, as SQLite compares), identity ids, and `embeddings.vec vector(384)` with an HNSW `vector_cosine_ops` index on rows with non-empty text.
- **Migrations:** recorded in `schema_migrations(track, version)`, one transaction per run under an advisory lock (`store/pgMigrate.ts`). A later schema change ships a `{ version, postgres }` step beside its SQLite `migrate()` step. `schemaParity.test.ts` pins each baseline to the SQLite schema.
- **Ownership:** the store never creates its schema. The schema must exist, and pgvector ≥ 0.8.0 must be installed (created when the role may).
- **Order:** every list read has a total `ORDER BY` with NULLs first, so results match SQLite. The 2a/2b characterization snapshots run unchanged on both dialects.
- **Search:** `searchEmbeddings(qvec, scope, { limit, kind })` searches per dialect: brute-force dot product on SQLite, pgvector HNSW cosine (iterative `strict_order` scan) on Postgres.

**Schema (v13, current):**""", 1),
    ("""```sql
CREATE TABLE todos (id TEXT PRIMARY KEY /* ULID */""", """On the Postgres store the inbox tables live in the same schema as `state.db`'s, from a baseline equal to `MIGRATIONS` 1–5 (`store/migrations/inboxPg.ts`, track `inbox`), with the same Postgres type mapping. There is no file backup: the migration is one transaction, and backups are the database operator's.

```sql
CREATE TABLE todos (id TEXT PRIMARY KEY /* ULID */""", 1),
    ("""

### Create a workspace""", """
5. **Store choice.** Before the inbox opens, main reads `config.json` `store` (§6 *Settings*). SQLite (the default) opens `inbox.db` and, when the JSONL watcher runs, `state.db`, as before. Postgres opens both stores on one pool (`openPgStores`) and starts the MCP server without the read-only `state.db` connection (§11). A configured Postgres that can't open (unreachable, missing schema, missing pgvector, invalid config) stops the launch with an error dialog naming the key to remove. Pool errors are logged as `store-pool-error`.

### Create a workspace""", 1),
    ("""Postgres gets its own isolation path (role + RLS) instead of a ported snapshot.""", """Postgres gets its own isolation path (role + RLS) instead of a ported snapshot. On the Postgres store the server starts without this connection (`startMcpServer(dir, { stateDb: false })`): the tools that read it (`list_sessions`, `get_session`, `get_cost`, `list_events`, `search_transcripts`, `session_summary`, `list_errors`, `query`, `mark_useful`) return `<tool> is unavailable on the Postgres store` as a tool error, and every other tool works.""", 1),
])
PYEOF
python3 - <<'PYEOF'
import sys; sys.path.insert(0, '/tmp'); from p3_edit import edit
edit('docs/superpowers/plans/2026-11-04-remote-c-3-host-store.md', [
    ("""Async-store **part 3** (`pg`, `src/main/store/postgres.ts`, per-dialect migrations, the CI `pgvector/pgvector:pg17` service with `PG_TEST_URL`). Also part 4's `src/main/store/passwordProvider.ts`: if part 4 hasn't merged, C3-2 creates that file at that path with that name, and part 4 adopts it.""",
     """Async-store **part 3** (`docs/superpowers/plans/2026-11-04-async-store-part3.md`, D36). That covers `pg`; `src/main/store/postgres.ts` with the `afterBeginWrite` hook; `storeConfig.ts`, `passwordProvider.ts`, `pgSsl.ts` and `pgStores.ts`; per-dialect migrations with a `migratePostgres` track per store; `docker/scripts/rds-ca-bundle.sh`; and the CI `pgvector/pgvector:0.8.7-pg16` service with `PG_TEST_URL`.""", 1),
    ("""  - Files: `src/host/hostDb.ts` (+ test) and `src/main/store/passwordProvider.ts` (if part 4 hasn't made it).
  - Pin `@aws-sdk/rds-signer` and `@aws-sdk/credential-providers` at a release whose default chain includes the container (Pod Identity) provider, and record the minimum version in SPEC §4.""",
     """  - Files: `src/host/hostDb.ts` (+ test), on part 3's `parseStoreConfig(…, { allowStaticSecrets: true })` and `openPgStores(…, { afterBeginWrite })`.
  - The SDK pins and the Pod Identity test are in part 3 (`3.1162.0`, SPEC §4). The host image runs `docker/scripts/rds-ca-bundle.sh /usr/local/share/fleet-host/rds-global-bundle.pem`.""", 1),
])
PYEOF
```

Run: `/usr/bin/grep -n "pgvector/pgvector:pg17\|if part 4 hasn't made it" docs/superpowers/plans/2026-11-04-remote-c-3-host-store.md`
Expected: no output.

- [ ] **Step 3: Final verification**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json \
  && CI=true npx vitest run src && CI=true npm run test:unit:pg && npm run build
git -C "$WT" diff --stat origin/main -- src/main/__snapshots__/
```

Expected:
- All PASS. The Postgres suite has 29 files and about 225 tests.
- The snapshot diff shows `dbReadCharacterization.test.ts.snap | 2 +-` and the new `dbSearchEmbeddings.test.ts.snap`, nothing else.
- If `npm run build` is env-blocked in the container, say so in the PR; CI builds.

- [ ] **Step 4: Commit, push, PR**

```bash
git -C "$WT" add docs/SPEC.md docs/superpowers/plans/2026-11-04-remote-c-3-host-store.md
git -C "$WT" commit -m "docs(spec): Postgres store dialect, store config key, MCP on Postgres (async store 3)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$WT" push -u origin feat/async-store-p3
COMPARE=$(sed -n '/STATE_BENCH_COMPARE/,/^\]/p' /tmp/ab3-compare.txt | sed '1s/^.*STATE_BENCH_COMPARE //')
BODY=$(cat <<'EOF2'
Part 3 of the async store layer (plan: docs/superpowers/plans/2026-11-04-async-store-part3.md).

- Postgres dialect for the existing async stores: one pg pool for state.db's and the inbox's tables; int8/numeric as numbers; per-store in-process write lock, concurrent reads; REPEATABLE READ snapshot reads.
- Per-dialect migrations: Postgres baselines equal to state v14 / inbox v5 (BIGINT, TEXT COLLATE "C", identity ids, vector(384) + HNSW), schema_migrations tracks; SQLite migrate()/MIGRATIONS untouched.
- config.json `store` (hand-edited): connection string / env / fields with static|env|aws-rds-iam passwords and verify-full TLS; RDS CA bundle script pinned in docker/versions.yaml.
- #491: canonical cost-row order (read snapshot 0.7534357500000001 → 0.75343575, the only snapshot change), latest-session id tiebreak, latest-wins summary pushes, searchEmbeddings on pgvector, Postgres-backed invalidate-during-recompute test.
- The store test suite (29 files) runs on SQLite and on PG16+pgvector; CI adds a pgvector/pgvector:0.8.7-pg16 service to the unit job.
- On the Postgres store the MCP history tools report unavailable (part 4 brings role + RLS); everything else unchanged.

Perf gate (SQLite A/B, median of 3 pairs, this container; pass = candidate ≤ baseline × (1 + tol) + slack):
EOF2
)
FOOT=$(cat <<'EOF2'
Gate: typecheck (node + web) + unit (SQLite and Postgres) + build + e2e in CI. SQLite users see no change; Troy to eyeball the Sessions list and observability rail on the host. Postgres on the desktop is a hand-edited preview (see SPEC §6 store).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF2
)
gh pr create --repo ImIOImI/claude-fleet --head feat/async-store-p3 \
  --title "feat(store): async store part 3: the Postgres dialect" \
  --body "$(printf '%s\n\n%s\n\n%s\n' "$BODY" "$COMPARE" "$FOOT")"
gh pr merge --auto --squash "$(gh pr view feat/async-store-p3 --repo ImIOImI/claude-fleet --json url -q .url)"
```

---

## Self-review notes

- **Requirements coverage:**
  - The dialect: Task 1 (`postgres.ts`, D21, D24, D25).
  - Per-dialect DDL and migrations from one list: Task 2 (D22, D23), pinned by `schemaParity.test.ts`.
  - The store factory chosen by config: Task 8 (`storeConfig.ts`) and Task 9 (`pgStores.ts`, `getStoreConfig`, `index.ts`).
  - Password providers, including `aws-rds-iam` and the CA bundle: Task 8 (D32). The fake container-credentials endpoint test is design-state's required unit test.
  - #491, all five items: cost-row order (Task 3), latest-wins pushes (Task 7), the `latestSessionId` tiebreak (Task 3), `searchEmbeddings` on pgvector (Task 6), and a Postgres-backed invalidate-during-recompute test (Task 7, with mutation checks).
  - The whole store suite on Postgres: Tasks 2–7 and 9 (29 files), locally (D29) and in CI (Task 1).
  - No SQLite behaviour change: the two characterization snapshots are unchanged on both dialects except the one #491 line (Task 3, D26, D27). Task 10 Step 3 checks the snapshot diff.
  - SQLite perf gate: Task 10 Step 1 (D37). SPEC.md: Task 10 Step 2. The c3 seam: D36, with the c3 outline corrected in Task 10.
- **Type consistency:**
  - `postgresKysely(pool, { afterBeginWrite })` is defined in Task 1. It is used by `openDbPostgres` and `InboxStore.openPostgres` (Task 2) and forwarded by `openPgStores` (Task 9).
  - `migratePostgres(k, schema, track)` and `schemaOf(pool)` come from Tasks 2 and 1.
  - `testStore.ts` is replaced whole in Tasks 2 and 5. Each version is a superset of the one before, and the Task 1 tests use only `isPg`, `pgMultiConnection` and `testPgSchema`.
  - `dump()` is async with no argument from Task 4 on. Its only callers are `dbIngestBatch.test.ts` and the converter's rewrite.
  - `pgVectorLiteral` is defined in Task 2 and reused by `searchEmbeddings` in Task 6.
  - `PostgresStoreConfig.connection` is the parsed shape. `config.json` keeps the flat on-disk shape, and `parseStoreConfig` maps between them.
- **Deliberately not done here (part 4):** the managed container, any Settings UI or IPC for `store`, the inbox copy on switch, the degraded banner, MCP on Postgres, and a Postgres perf gate.

---

## Part 4 outline (written in full when part 3 has merged)

**Goal:** users pick Postgres locally in Settings, and everything works on it: the app-managed container, the first-switch copy, the Docker-down state, and the MCP server, typed tools and `query` included, with structural isolation. That completes sub-project (a).

- **Managed local Postgres** (`src/main/store/managedPostgres.ts` on `docker.ts`):
  - A pinned `pgvector/pgvector:0.8.7-pg16` image (digest in `docker/versions.yaml`), a labelled container `claude-fleet-postgres`, a named volume, and a loopback-only random host port.
  - `initdb` with `--locale=C.UTF-8`. Bootstrap creates role `fleet_app`, schema `fleet` and `CREATE EXTENSION vector` as the superuser. The app then connects as `fleet_app`, the same no-DDL-outside-the-schema shape as `fleet_agent` (D23).
  - The generated superuser and app passwords live in the vault's app bag. `store: { kind: 'postgres', managed: true }` resolves to a vault-held connection string (spec §7), so no secret is in `config.json` (D31).
  - Start, health and stop sit in the startup ordering before `openPgStores`.
- **Setup choice:**
  - Settings → *Storage* (SQLite | local Postgres | external Postgres), with `config:getStore` / `config:setStore` IPC. Restart to apply.
  - The external option edits the same shapes as D31, with secrets in the vault: a new `password: { kind: 'vault', key }` source.
  - A one-shot copy of `inbox.db` into Postgres on the first switch, verified by row counts before `inbox.db` is renamed `inbox.db.migrated-<epochMs>`. `state.db` isn't copied: it is re-ingested from JSONL (the watcher's normal cold start).
  - The copy inserts explicit ids into identity columns (`todo_events`, `step_runs`), so it must `setval(pg_get_serial_sequence(table, 'id'), max(id))` on each afterwards, or the next insert collides.
- **Docker-down / unreachable degraded state:**
  - It replaces part 3's startup dialog (D33). History and inbox are unavailable, with a banner reusing #380's `unreachable` pattern.
  - IPC handlers return the empty or degraded shapes the renderer already handles. The watcher retries the store open on a backoff, and ingest resumes from JSONL offsets.
- **MCP on Postgres** (old part 5; `src/main/store/mcpIsolation.ts`, `mcpServer.ts`):
  - **Typed tools:** the typed read tools move onto a `ReadSource`. The SQLite implementation is today's read-only connection, unchanged. The Postgres one is Kysely on a role-scoped connection.
  - **`search_transcripts`:** it calls `searchEmbeddings` on Postgres (D30).
  - **Roles:** one read-only role per caller workspace, plus an `_raw` sibling that also gets `raw_jsonl`.
  - **Row-level security:** RLS on `events`, `sessions` and `broker_sessions` via `query_scope(role, workspace_id)`, rewritten whenever grants change.
  - **Each call:** `BEGIN READ ONLY; SET LOCAL ROLE …; SET LOCAL statement_timeout …`. The single-statement, row-cap and result-cap guards stay.
  - **Contract tests:** `mcpServer.test.ts` and `tests/mcp-*.spec.ts` (memory: MCP contract tests) run on both dialects.
  - **Host:** this is the same isolation (d) needs on the host.
- **Perf:** a Postgres bench, the 2b metrics on the managed container over loopback, gated against SQLite with stated tolerances (ingest is expected to be slower per line; reads must stay within one IPC frame).
- **SPEC:** §4 (the managed image), §6 (*Settings* channels and the Storage section), §8 *Startup* (managed start and the degraded state), §9 (DB credentials in the vault), §11 (role + RLS isolation).

**Open questions for Troy (part 4):** none blocking. The managed container's image tag and volume naming follow `docker.ts` conventions.

## Open items for the Work workspace / infra (from part 3)

1. On the Aurora PG16 writer:
   - Is the `vector` extension (≥ 0.8.0) installed in the fleet database by an admin? `fleet_agent` can't create it, and the host refuses to start without it (D23).
   - Does schema `fleet` exist, with `fleet_agent` holding `CREATE` and `USAGE` on it?
