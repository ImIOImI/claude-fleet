# Async store layer, part 4a: the fleet-state MCP server on Postgres — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Postgres store, every fleet-state MCP history tool works: the typed read tools, `search_transcripts` on pgvector, and `query` isolated per workspace by a database role and row-level security. The tools read through a `ReadSource` seam that c3b and (d) build on. SQLite behaviour is unchanged.

**Architecture:**
- **The seam.** The MCP history tools stop taking a better-sqlite3 handle and take a `ReadSource`:
  - `sqliteReadSource(db)` is today's read-only connection and `query` snapshot, moved verbatim.
  - `pgReadSource()` runs the same reads on the store's own pool, filtered by the caller's scope as on SQLite.
- **`query` on Postgres.** It goes through `PgQueryIsolation`:
  - Each caller workspace gets its own LOGIN role, created lazily, with a password minted per process.
  - Row-level security on the seven exposed tables admits only the workspaces listed for `session_user` in `mcp_grants`. That list is rewritten on every call.
  - The caller's SQL runs as a cursor over temp views, in a read-only transaction under that role.

**Tech Stack:** TypeScript, Electron main, better-sqlite3 13, kysely 0.28, `pg` 8.23 (`queryMode: 'extended'`), `pg-connection-string`, Postgres 16 + pgvector 0.8.7, vitest 4.

**Spec and inputs:**
- `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md`: §7 *MCP `query` isolation on Postgres* and §11 sub-project (a).
- The *Part 4 outline* at the end of `docs/superpowers/plans/2026-11-04-async-store-part3.md`, and its D20–D38.
- The c3b outline at the end of `docs/superpowers/plans/2026-11-04-remote-c-3-host-store.md`: it is gated on this plan's `ReadSource`.
- GitHub issue #491's last open item: `searchEmbeddings` has no app caller.
- `docs/SPEC.md`: §7 *Postgres store*, §9 *Security model* and §11 *In-container SQLite access via MCP*.

**Part 4 is two plans.**
- **This plan, 4a: MCP on Postgres.** One PR.
  - *Ships:* on a Postgres store configured by hand (part 3's preview), every fleet-state tool works. `query` is isolated by role + RLS when the store role has `CREATEROLE`; otherwise it reports why. `ReadSource` is the seam c3b and (d) build on. Closes #491. SQLite is unchanged.
- **`2026-11-05-async-store-part4b.md`: the managed container.** It covers the managed Postgres container, Settings → *Storage*, the first-switch copy and the degraded banner.
  - *Ships:* users pick Postgres in Settings, which completes sub-project (a).
  - It depends on this plan.

## Global Constraints

From the spec (§7, §11 (a)), verbatim:

- "Each MCP caller gets its own **read-only role**: `SELECT` only, no `raw_jsonl` column unless `include_raw`, which uses a sibling role."
- "**Row-level security** on `events`, `sessions` and `broker_sessions` limits rows to the caller's allowed scope (`workspace_id IN (SELECT … FROM query_scope WHERE role = current_user)`). `query_scope` is rewritten whenever grants change, so revocation is instant." This plan covers all seven tables `query` exposes and keys on `session_user` (D42).
- "Each `query` runs in a `READ ONLY` transaction under `SET LOCAL ROLE`, with `statement_timeout`."
- "The existing guards still apply: single statement, row cap, result cap."
- "MCP `query` isolation on local Postgres (role + RLS) ships here, because the local Postgres choice needs it." / "*Ships:* users can pick Postgres locally. SQLite behaviour is unchanged."

From parts 2a–3, still binding:

- **SQLite behaviour is unchanged.**
  - The MCP server's `{ readonly: true }` connection, `buildSnapshot` and `searchTranscripts(…, db)` keep their SQL byte for byte. They move to `src/main/sqliteReadSource.ts` (D1, D14).
  - Every tool's arguments, results and error text on SQLite stay the same. The only changed text is the no-store message (Task 1).
  - The 2a/2b characterization snapshots are untouched. **Never run `vitest -u`.**
- **Isolation is a security feature.** Every guard in `pgQueryIsolation.ts` has a test that fails when that guard alone is removed. Task 3 lists the mutations and their results, measured while validating this plan.
- **Desktop config refuses plaintext secrets.** This plan adds no config; the caller roles' passwords are never stored (D42).
- **TLS rules from part 3 apply.** The caller roles connect exactly as the store pool does (`rolePoolConfig`), with the same `ssl` object.
- **Local workspaces' env stays scrubbed of store credentials** (`storeSecretEnvNames`, unchanged).
- **Dialect branches** live only in `src/main/store/*` and the two vector spots in `db.ts` (D30). `sqliteReadSource.ts` is the SQLite MCP path, which was already SQLite-only.
- **Transactions await only `trx`**; **check-then-act stays atomic**; **no `.then(onFulfilled, onRejected)`**; **no N+1**.
- **Typecheck every config separately:** `npx tsc --noEmit -p tsconfig.node.json`, `npx tsc --noEmit -p tsconfig.web.json`, `npm run typecheck:host`.
- **`tsc` cannot see a missing `await`** on a call whose result is unused. Task 1 Step 6 has the grep.
- **CI is the real gate:** `build-app.yml` runs the unit suite on both dialects, the build and e2e. The container can't run Electron; Troy eyeballs the app on the host after merge.
- **MCP contract tests** live in `mcpServer.test.ts` (unit) and `tests/mcp-*.spec.ts` (e2e, CI-only, SQLite). Keep both green.
- **Every commit message ends with** `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **SPEC.md is updated in the same PR** (Task 5).
- **Comments are terse and necessary** (`/workspace/.claude/rules/review-conventions.md`).
- **Postgres ≥ 16** for `query` isolation: it uses `GRANT … WITH INHERIT/SET` (PG 16). Aurora and the managed image are PG 16.

## Decisions

D1–D38 from parts 2a–3 still bind. Part 4a adds D39–D44, recorded in SPEC.md by Task 5. Part 4b adds D45–D52.

- **D39 — Part 4 is split in two.**
  - **4a (this plan):** the `ReadSource`, the typed tools and search on Postgres, and `query` isolation.
  - **4b:** the managed container, Settings → *Storage*, the first-switch copy, the degraded state and the Postgres perf bench.
  - **Why this order:** a user can't pick Postgres in Settings until every MCP tool works on it. The isolation code is also the security-critical half, so it gets a PR of its own. c3b is gated on the `ReadSource` alone.
- **D40 — The `ReadSource` seam** (`src/main/store/readSource.ts`).
  - **What it is:** one data-access method per read the history tools need: `listSessions`, `getSession`, `sessionWorkspace`, `tokenGroups`, `listEvents`, `summaryParts`, `listErrors`, `searchEmbeddings`, `query`, `forgetCaller`, `close`.
  - **What stays in the tools:** argument validation, scope narrowing (`workspace_id` only narrows), ISO siblings, cost derivation (`pricing.ts`), the result-size cap and usage telemetry. So a source returns rows, and both dialects share every rule a caller can observe.
  - **Implementations:**
    - `sqliteReadSource(db)` is today's SQL, moved.
    - `pgReadSource({ isolation })` is the Postgres SQL.
    - c3b serves `pgReadSource` from `fleet-host`, with `query` off until (d).
    - (d)'s `FederatedReader` fans the same methods out to `RemoteClient`s.
  - **No Electron:** `readSource.ts`, `pgReadSource.ts` and `pgQueryIsolation.ts` import nothing from Electron. c3b's import-graph test can then allowlist them.
  - **Rejected, Kysely on both dialects for the typed tools:** it would change the SQLite read path's SQL, which D1 keeps byte for byte. Instead, the shared contract suite (`mcpReadSource.test.ts`) proves the two implementations agree.
- **D41 — Typed tools on Postgres read the store's own pool, filtered by scope as on SQLite.**
  - **Scope:** every read carries the caller's `workspace_id IN (…)` filter. Session-keyed reads check `sessionWorkspace` first, as today.
  - **Snapshots:** each method runs in one `readTransaction`. That gives one snapshot and takes no write lock, since raw SQL inside a read-only transaction isn't serialized (D21).
  - **Order parity with SQLite:**
    - `list_sessions` sorts `last_active_at DESC NULLS LAST, id`; SQLite puts NULLs last under `DESC`.
    - Token groups sort `model NULLS FIRST, service_tier NULLS FIRST`, which is SQLite's `GROUP BY` order, so the USD float sum adds in the same order.
    - `DISTINCT tool_input` sorts by `COLLATE "C"`, as SQLite's binary order does.
  - **Why the typed tools don't run under the caller's role:** they are fixed, parameterized SQL, the same trust model as on SQLite. Running them under the role would also tie them to `CREATEROLE`, which the host (c3b) needn't have. The role guards the one path that runs a caller's own SQL.
- **D42 — `query` isolation on Postgres: one LOGIN role per caller, plus RLS keyed on `session_user`** (`src/main/store/pgQueryIsolation.ts`).
  - **Roles:**
    - `<schema>_mcp_reader` (NOLOGIN) holds `USAGE` on the schema, `EXECUTE` on `mcp_scope()` and `SELECT` on the seven tables. On `events` that is `SNAPSHOT_EVENT_COLS` only: no `raw_jsonl`, no `dedup_key`.
    - `<schema>_mcp_raw` holds `SELECT (raw_jsonl)`.
    - Per caller: `<schema>_mcp_<sha256(workspaceId)[:16]>`, LOGIN NOINHERIT and a member of the reader role. Its `_raw` sibling is NOLOGIN, a member of the reader and raw roles, and is reachable only by `SET ROLE` (`WITH INHERIT FALSE, SET TRUE`).
    - Names are hashed because workspace ids aren't identifier-safe. The schema name is capped at 32 characters so names stay within 63.
  - **RLS:**
    - The seven tables `query` exposes get `ENABLE ROW LEVEL SECURITY` and policy `mcp_read FOR SELECT TO <reader> USING (workspace_id IN (SELECT unnest(<schema>.mcp_scope())))`. On `perf_events` it is `workspace_id IS NULL OR …`, as the SQLite snapshot does.
    - `mcp_scope()` is `SECURITY DEFINER`, owned by the store role, with `search_path = pg_catalog`. It returns the `mcp_grants` rows for `session_user`.
    - The store role owns the tables without `FORCE`, so the app's own queries are unaffected.
  - **Why `session_user`:**
    - A caller's SQL can switch `current_user` with `set_config('role', …)`, but only to roles its login role is a member of: its own `_raw` sibling and the reader role.
    - It can't change `session_user`. `set_config('session_authorization', …)` is refused.
    - *Rejected:* one shared login role that `SET ROLE`s per caller. Validation showed `SELECT set_config('role', '<other caller>', true)` succeeds for any member role, and so does a GUC-keyed scope.
  - **Each call:**
    - Under a per-caller lock: ensure the role exists, then rewrite its `mcp_grants` rows to the caller's current allowed set (store role, one transaction). A revocation therefore applies to the next call.
    - Then on the role's own one-connection pool:
      1. `BEGIN ISOLATION LEVEL REPEATABLE READ`, `SET LOCAL ROLE <role>_raw` when `include_raw`, `SET LOCAL statement_timeout = 10000`, `SET LOCAL search_path`.
      2. Seven `CREATE TEMP VIEW`s, so `SELECT * FROM events` works without `raw_jsonl`.
      3. `SET TRANSACTION READ ONLY`.
      4. `DECLARE mcp_q NO SCROLL CURSOR FOR <sql>` over the extended protocol, then `FETCH FORWARD <maxRows>`.
      5. `ROLLBACK`, then `DISCARD ALL`.
  - **Why a cursor:** `DECLARE … CURSOR FOR` accepts only `SELECT`, `VALUES` and `WITH` without data-modifying CTEs. The extended protocol (`queryMode: 'extended'`) refuses a second statement. Validation showed the simple protocol ran `SELECT 1; SELECT 2`.
  - **Why `DISCARD ALL`:** session-level advisory locks and `LISTEN` survive a rollback. Validation showed an advisory lock held across calls without it.
  - **Passwords:** each process mints a random password per caller role. It sets it with a SCRAM-SHA-256 verifier (`scram.ts`), so the plaintext never reaches the server or its logs. Nothing is stored.
  - **Prerequisites:** Postgres ≥ 16 and a store role with `CREATEROLE`. On PG 16, `CREATEROLE` administers only the roles it created. Without them, `query` returns `query is unavailable on this Postgres store: <reason>`, and every other tool works. Provisioning is idempotent and runs on every start (`ensureIsolation`).
  - **Workspace removal:** `removeWorkspaceSocket(id)` calls `forgetCaller(id)`, which drops the caller's roles and grants.
  - **Accepted, documented:**
    - Catalog views stay visible: table names, and per-table activity counters in `pg_stat_user_tables`. These are counts, not rows.
    - `pg_stats`, which holds column values, is hidden for RLS tables. A test pins that.
    - Other catalog metadata: role names and connected state (`pg_roles`, `pg_stat_activity`), `reltuples` and relation sizes, gaps in `events.id`, and `application_name` as a signalling channel.
    - **Memory:** `set_config` can raise `work_mem` / `hash_mem_multiplier`, and no in-database block exists. This is bounded by a global cap of 2 concurrent `query` calls (8 queued, the rest busy) and `statement_timeout` 5 s.
    - **Advisory locks:** `pg_advisory_*` is PUBLIC and only a superuser can revoke it, so migrations take their lock with a bounded `lock_timeout` and retry.
    - **Policy scope:** only the reader role has policies, so any other non-owner role sees zero rows.
    - **Deployment:** one process per schema is the supported mode. Passwords are minted per process; a 28P01 re-provisions once.
  - **Not isolated here:** `fleet-host`. (d) applies the same module there.
- **D43 — `search_transcripts` on Postgres calls `db.searchEmbeddings`** (part 3's exact pgvector scan; this closes #491).
  - The tool embeds the query once and hands the vector to the source. A scope narrowed to nothing returns `[]` without embedding, as on SQLite.
  - SQLite keeps `searchTranscripts`' brute force, now split into `searchVectorsSqlite`, with the same SQL and `perfSpan`.
- **D44 — Approximate search (HNSW) is deferred to (d).** Recorded in SPEC.md.
  - **The numbers:** part 3 measured the exact scan at p50 116 ms with 100k rows in scope, and 291 ms with 250k.
  - **Why that is enough here:** `search_transcripts` is an agent tool call. The query embedding alone takes tens of ms and the caller is a model turn, so ~0.3 s at 250k rows is acceptable. A desktop's own history reaches 250k turn-embeddings only after years of heavy use.
  - **Why (d):** the corpora that grow past that are the host's, where published partitions accumulate.
  - **Trigger:** p50 above 250 ms on a real store, or more than 250k rows in one caller's scope.
  - **What it needs then:** part 3's subquery form (ANN candidates without the `id` tiebreak, re-ranked outside), `hnsw.ef_search = max(200, 4 × limit)` and `iterative_scan = relaxed_order`, plus a recall test at 20k/100k/250k before shipping.

## Validation done while writing this plan

In a scratch worktree on origin/main (`0f9366e`), against PG 16.15 + pgvector 0.8.7 from `scripts/pg-test-server.sh`. The worktree was removed afterwards.

- **Task 3's code and test file, as written below:** 17/17 tests pass. Each mutation below makes at least one test fail:

  | Mutation | Failing tests |
  |---|---|
  | M1: RLS left off `sessions` | 6 |
  | M2: policy `USING (true)` | 10 |
  | M3: `current_user` in `mcp_scope()` | 11 |
  | M4: simple protocol | 1 (multi-statement) |
  | M5: no `DISCARD ALL` | 1 (advisory lock) |
  | M6: `mcp_grants` never cleared | 11 |
  | M7: `raw_jsonl` granted to the reader | 1 |
  | M8: `SELECT ON ALL TABLES` | 2 |

- **The probe behind D42:**
  - `set_config('role', …)` to the store role or another caller's role: refused.
  - `set_config('session_authorization', …)`: refused.
  - `query_to_xml('select … from <schema>.events')`: scoped.
  - `pg_stats` for an RLS table: empty.
  - A division-by-zero predicate on another workspace's rows: never evaluated.
  - The simple protocol ran a second statement; the extended protocol refused it.
  - An advisory lock outlived `ROLLBACK`; `DISCARD ALL` released it.
- **Every task's scripts and files** were replayed in order on a fresh tree at origin/main:
  - All three typechecks pass.
  - `mcpServer.test.ts` passes 60/60.
  - The whole SQLite unit suite passes. The one failure was a known timing flake (`mcpContainerBridge` backoff), which passed on re-run.
  - The Postgres suite passes: 36 files after Task 3, then the isolation file at 19/19 after Task 4.
- **Task 2's contract suite:** passes 8/8 on both dialects. Removing the scope filter from `pgReadSource.listSessions` and `listErrors` fails 2 tests.
- **`scramVerifier`:** matches RFC 7677's test vector for both the server signature and the stored key. It also logged in over TCP against a SCRAM-only PG 16, and a wrong password got `28P01`.

## Verification environment (once, before Task 1)

```bash
git -C /workspace/claude-fleet fetch -q origin
WT=/workspace/claude-fleet/.claude/worktrees/async-store-p4a
git -C /workspace/claude-fleet worktree add -b feat/async-store-p4a "$WT" origin/main
cd "$WT"
npm ci --ignore-scripts
printf 'electron-stub' > node_modules/electron/path.txt
eval "$(scripts/pg-test-server.sh start)"         # exports PG_TEST_URL
npx tsc --noEmit -p tsconfig.node.json; echo "node tsc $?"
npx tsc --noEmit -p tsconfig.web.json;  echo "web tsc $?"
npm run typecheck:host;                  echo "host tsc $?"
```

Never `cd /workspace/claude-fleet` from inside the worktree. If a test fails with "Module did not self-register", run `(cd node_modules/better-sqlite3 && npx --yes prebuild-install)` once.

Two runs gate every task:

```bash
CI=true npx vitest run src                # SQLite: the whole unit suite
CI=true npm run test:unit:pg              # Postgres: vitest.pg.config.ts
```

Known flakes on unchanged `origin/main` in this container are `src/main/mcpLocalBridge.run.test.ts` and `src/main/jsonlWatcher.ordering.test.ts > stop() resolves only after every queued batch has finished`. If one of those is the only failure, re-run that file; three clean passes in a row mean it's the flake.

`src/main/db.ts` contains a literal U+FFFD and a NUL-escape regex, so plain `grep` calls it binary. Use `grep -a`.

## File structure

| File | Responsibility |
|---|---|
| `src/main/store/readSource.ts` (new) | The `ReadSource` interface, its filter/row types, `MCP_QUERY_TABLES`, `SNAPSHOT_EVENT_COLS`. |
| `src/main/sqliteReadSource.ts` (new) | `sqliteReadSource(db)`: today's SQLite reads and `buildSnapshot`, moved from `mcpServer.ts`. |
| `src/main/transcriptIndex.ts` | `searchVectorsSqlite` split out of `searchTranscripts` (same SQL). |
| `src/main/mcpServer.ts` | Tools take a `ReadSource`; `startMcpServer(dir, { readSource })`, `setReadSource`; `pgDescription`; `forgetCaller` on socket removal. |
| `src/main/store/pgReadSource.ts` (new) | `pgReadSource({ isolation })`, `openPgMcpReadSource`. |
| `src/main/store/pgQueryIsolation.ts` (new) | Roles, grants, RLS, per-call execution (D42). |
| `src/main/store/scram.ts` (new) | `scramVerifier`. |
| `src/main/store/pgStores.ts` | `PgStores.poolConfig`. |
| `src/main/store/testStore.ts`, `pgGlobalSetup.ts` | `testPgAppSchema()` (a non-superuser store role); stale-role cleanup. |
| `src/main/index.ts` | Starts the MCP server with the Postgres read source. |
| Tests | `mcpServer.test.ts` (async calls), `mcpReadSource.test.ts` (both dialects), `pgQueryIsolation.test.ts`, `scram.test.ts`. |
| `vitest.pg.config.ts` | Adds `mcpReadSource.test.ts`, `pgQueryIsolation.test.ts`. |
| `docs/SPEC.md`, part 3 and c3 plan outlines | Task 5. |

---

### Task 1: The `ReadSource` seam and the SQLite implementation (no behaviour change)

**Files:**
- Create: `src/main/store/readSource.ts`, `src/main/sqliteReadSource.ts`
- Modify: `src/main/transcriptIndex.ts` (split out `searchVectorsSqlite`), `src/main/mcpServer.ts` (tools on a `ReadSource`), `src/main/index.ts:222`, `src/main/mcpServer.test.ts` (calls awaited)

**Interfaces:**
- Produces:
  - `ReadSource`, `QueryRunner`, `Row`, `Scope`, `SessionListFilter`, `EventListFilter`, `ErrorListFilter`, `TokenGroup`, `SummaryParts`, `QueryArgs`, `QueryCaller`, `MCP_QUERY_TABLES` and `SNAPSHOT_EVENT_COLS`, all from `store/readSource.ts`.
  - `sqliteReadSource(db: Database.Database): ReadSource`.
  - `searchVectorsSqlite(db, qvec, ids, { limit, kind? }): SearchHit[]`.
  - `startMcpServer(dir, { readSource?: ReadSource | null })`, where `undefined` opens the SQLite read-only connection and `null` means no store yet.
  - `setReadSource(rs: ReadSource | null)`.
  - `Tool.run(rs: ReadSource | null, args, ctx)`.
- Consumes: nothing new.

- [ ] **Step 1: Write `src/main/store/readSource.ts`**

```ts
// The MCP history read seam: the fleet-state typed tools, search and `query`
// read through a ReadSource, one per dialect (SPEC §11). Data access only:
// argument validation, scope narrowing and result shaping stay in the tools.
import type { EmbeddingHit } from '../db.js';

export type Row = Record<string, unknown>;
export type Scope = ReadonlySet<string>;

/** The tables `query` exposes, on both dialects. */
export const MCP_QUERY_TABLES = [
  'events', 'sessions', 'broker_sessions', 'session_summaries', 'session_tags', 'usage_events', 'perf_events',
] as const;

/** `events` columns `query` exposes (raw_jsonl only with include_raw; dedup_key never). */
export const SNAPSHOT_EVENT_COLS =
  'id, session_id, workspace_id, ts, type, subtype, uuid, parent_uuid, model, ' +
  'input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, ' +
  'service_tier, tool_name, tool_use_id, tool_input, tool_result_is_error';

export interface SessionListFilter { workspaceId?: string; since?: number; until?: number; limit: number }
/** `columns` is a comma list already checked against the tool's allowlist. */
export interface EventListFilter { type?: string; toolName?: string; since?: number; limit: number; columns: string }
export interface ErrorListFilter { workspaceId?: string; sessionId?: string; level?: string; type?: string; since?: number; limit: number }

export interface TokenGroup {
  model: string | null;
  service_tier: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface SummaryParts {
  files: string[];
  commands: string[];
  tokens: TokenGroup[];
  span: { started_at: number | null; last_active_at: number | null };
}

export interface QueryArgs { sql: string; params: unknown[]; includeRaw: boolean; maxRows: number }
export interface QueryCaller { callerId: string; scope: Scope }

/** Runs `query` for a dialect that isolates by connection (Postgres: pgQueryIsolation.ts). */
export interface QueryRunner {
  query(caller: QueryCaller, q: QueryArgs): Promise<unknown[]>;
  forgetCaller(callerId: string): Promise<void>;
  end(): Promise<void>;
}

export interface ReadSource {
  readonly dialect: 'sqlite' | 'postgres';
  listSessions(scope: Scope, f: SessionListFilter): Promise<Row[]>;
  /** Unscoped: the tool checks the row's workspace against the caller's scope. */
  getSession(id: string): Promise<Row | null>;
  sessionWorkspace(id: string): Promise<string | null>;
  /** Assistant-event token sums per (model, service_tier), NULLs first. */
  tokenGroups(sessionId: string): Promise<TokenGroup[]>;
  listEvents(sessionId: string, f: EventListFilter): Promise<Row[]>;
  summaryParts(sessionId: string): Promise<SummaryParts>;
  listErrors(scope: Scope, f: ErrorListFilter): Promise<Row[]>;
  searchEmbeddings(qvec: Float32Array, scope: Scope, o: { limit: number; kind?: 'turn' | 'summary' }): Promise<EmbeddingHit[]>;
  /** One read-only statement, isolated to `caller.scope` by the dialect's own mechanism. At most maxRows rows. */
  query(caller: QueryCaller, q: QueryArgs): Promise<unknown[]>;
  /** A removed workspace: drop anything held for it as a caller. */
  forgetCaller(callerId: string): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Write `src/main/sqliteReadSource.ts`**

The SQL is `mcpServer.ts`'s, moved. `buildSnapshot`, the `inClause` helper and the per-tool statements are copied verbatim, minus a few comment lines that would be stale outside the tools.

```ts
// The MCP read path on SQLite (SPEC §11): the server's own read-only
// connection, and the per-call in-memory snapshot that isolates `query`.
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { searchVectorsSqlite } from './transcriptIndex.js';
import { SNAPSHOT_EVENT_COLS, type ReadSource, type Row, type Scope, type TokenGroup } from './store/readSource.js';

/** SQL `IN (?,…)` fragment + params for an allowed-workspace set (#122). */
function inClause(col: string, allowed: Scope): { sql: string; params: string[] } {
  const ids = [...allowed];
  if (ids.length === 0) return { sql: '0 = 1', params: [] }; // match nothing (self is always present, so unreachable)
  return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** Build a throwaway in-memory DB containing ONLY the caller's allowed-workspace
 *  rows, copied from the source DB at `srcPath` (the live state.db). The source
 *  is DETACHed before the caller's SQL ever runs, so isolation is structural:
 *  no subquery/UNION/sqlite_master trick can reach unfiltered rows (#146). The
 *  caller owns the returned DB and must close it. */
function buildSnapshot(srcPath: string, allowed: Scope, includeRaw: boolean): Database.Database {
  const mem = new Database(':memory:');
  try {
    const alias = 'src_' + randomBytes(6).toString('hex');
    const { sql: scope, params } = inClause('workspace_id', allowed);
    // ATTACH filename is not reliably bindable; double any single quote.
    const attached = srcPath.replace(/'/g, "''");
    mem.exec(`ATTACH DATABASE '${attached}' AS ${alias}`);
    try {
      const eventCols = includeRaw ? `${SNAPSHOT_EVENT_COLS}, raw_jsonl` : SNAPSHOT_EVENT_COLS;
      mem.prepare(
        `CREATE TABLE events AS SELECT ${eventCols} FROM ${alias}.events WHERE ${scope}`
      ).run(...params);
      mem.prepare(`CREATE TABLE sessions AS SELECT * FROM ${alias}.sessions WHERE ${scope}`).run(...params);
      mem.prepare(
        `CREATE TABLE broker_sessions AS SELECT * FROM ${alias}.broker_sessions WHERE ${scope}`
      ).run(...params);
      mem.prepare(
        `CREATE TABLE session_summaries AS SELECT * FROM ${alias}.session_summaries WHERE ${scope}`
      ).run(...params);
      mem.prepare(
        `CREATE TABLE session_tags AS SELECT * FROM ${alias}.session_tags WHERE ${scope}`
      ).run(...params);
      mem.prepare(
        `CREATE TABLE usage_events AS SELECT * FROM ${alias}.usage_events WHERE ${scope}`
      ).run(...params);
      // perf_events: app-global rows (workspace_id NULL — stalls, slow ops)
      // are host-process facts visible to every caller; workspace-tagged rows
      // (pty windows, terminal latency) are scoped like everything else.
      try {
        mem.prepare(
          `CREATE TABLE perf_events AS SELECT * FROM ${alias}.perf_events WHERE workspace_id IS NULL OR ${scope}`
        ).run(...params);
      } catch (e) {
        // Pre-v11 DB (no perf_events yet): an empty, correctly-shaped table.
        // Anything else is a real failure and must surface.
        if (!(e instanceof Error && /no such table/i.test(e.message))) throw e;
        mem.exec(`CREATE TABLE perf_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, workspace_id TEXT, session_id TEXT, name TEXT, dur_ms REAL, trace_id TEXT, span_id TEXT, meta TEXT)`);
      }
    } finally {
      mem.exec(`DETACH ${alias}`);
    }
    return mem;
  } catch (e) {
    mem.close();
    throw e;
  }
}

function tokenGroups(db: Database.Database, sessionId: string): TokenGroup[] {
  return db
    .prepare(
      `SELECT model, service_tier,
              SUM(COALESCE(input_tokens,0)) AS input,
              SUM(COALESCE(output_tokens,0)) AS output,
              SUM(COALESCE(cache_read_input_tokens,0)) AS cacheRead,
              SUM(COALESCE(cache_creation_input_tokens,0)) AS cacheCreate
       FROM events WHERE session_id = ? AND type = 'assistant'
       GROUP BY model, service_tier`
    )
    .all(sessionId) as TokenGroup[];
}

function distinctInputs(db: Database.Database, sessionId: string, names: string[]): string[] {
  const placeholders = names.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT tool_input FROM events
       WHERE session_id = ? AND tool_name IN (${placeholders}) AND tool_input IS NOT NULL
       ORDER BY tool_input`
    )
    .all(sessionId, ...names) as Array<{ tool_input: string }>;
  return rows.map((r) => r.tool_input);
}

/** `db` is the MCP server's `{ readonly: true }` connection to state.db. */
export function sqliteReadSource(db: Database.Database): ReadSource {
  return {
    dialect: 'sqlite',
    async listSessions(scope, f) {
      const where: string[] = [];
      const p: unknown[] = [];
      if (f.workspaceId !== undefined) { where.push('workspace_id = ?'); p.push(f.workspaceId); }
      if (f.since !== undefined) { where.push('last_active_at >= ?'); p.push(f.since); }
      if (f.until !== undefined) { where.push('last_active_at <= ?'); p.push(f.until); }
      const { sql: scopeSql, params } = inClause('workspace_id', scope);
      where.push(scopeSql);
      p.push(...params);
      const sql = `SELECT * FROM sessions WHERE ${where.join(' AND ')} ORDER BY last_active_at DESC LIMIT ?`;
      return db.prepare(sql).all(...p, f.limit) as Row[];
    },
    async getSession(id) {
      return (db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined) ?? null;
    },
    async sessionWorkspace(id) {
      const row = db.prepare('SELECT workspace_id FROM sessions WHERE id = ?').get(id) as { workspace_id?: unknown } | undefined;
      return typeof row?.workspace_id === 'string' ? row.workspace_id : null;
    },
    async tokenGroups(sessionId) {
      return tokenGroups(db, sessionId);
    },
    async listEvents(sessionId, f) {
      const where = ['session_id = ?'];
      const p: unknown[] = [sessionId];
      if (f.type !== undefined) { where.push('type = ?'); p.push(f.type); }
      if (f.toolName !== undefined) { where.push('tool_name = ?'); p.push(f.toolName); }
      if (f.since !== undefined) { where.push('ts >= ?'); p.push(f.since); }
      const sql = `SELECT ${f.columns} FROM events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`;
      return db.prepare(sql).all(...p, f.limit) as Row[];
    },
    async summaryParts(sessionId) {
      const span = db
        .prepare(`SELECT MIN(ts) AS started_at, MAX(ts) AS last_active_at FROM events WHERE session_id = ?`)
        .get(sessionId) as { started_at: number | null; last_active_at: number | null };
      return {
        files: distinctInputs(db, sessionId, ['Write', 'Edit', 'NotebookEdit']),
        commands: distinctInputs(db, sessionId, ['Bash']),
        tokens: tokenGroups(db, sessionId),
        span,
      };
    },
    async listErrors(scope, f) {
      const where: string[] = [];
      const p: unknown[] = [];
      // Always: own workspace(s) OR a global (NULL-workspace) crash row.
      const { sql: scopeSql, params } = inClause('workspace_id', scope);
      where.push(`(${scopeSql} OR workspace_id IS NULL)`);
      p.push(...params);
      if (f.workspaceId !== undefined) { where.push('(workspace_id = ? OR workspace_id IS NULL)'); p.push(f.workspaceId); }
      if (f.sessionId !== undefined) { where.push('session_id = ?'); p.push(f.sessionId); }
      if (f.level !== undefined) { where.push('level = ?'); p.push(f.level); }
      if (f.type !== undefined) { where.push('type = ?'); p.push(f.type); }
      if (f.since !== undefined) { where.push('ts >= ?'); p.push(f.since); }
      const sql = `SELECT * FROM errors WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...p, f.limit) as Row[];
    },
    async searchEmbeddings(qvec, scope, o) {
      return searchVectorsSqlite(db, qvec, [...scope], o);
    },
    async query(caller, q) {
      const snap = buildSnapshot(db.name, caller.scope, q.includeRaw);
      try {
        const stmt = snap.prepare(q.sql);
        if (!stmt.reader) throw new Error('read-only SELECT statements only');
        return (stmt.all(...q.params) as unknown[]).slice(0, q.maxRows);
      } finally {
        snap.close();
      }
    },
    async forgetCaller() {},
    async close() {
      if (db.open) db.close();
    },
  };
}
```

- [ ] **Step 3: Split `searchVectorsSqlite` out of `searchTranscripts`**

Save as `/tmp/p4a_ti.py` and run `python3 /tmp/p4a_ti.py` from `$WT`. The scan's SQL and `perfSpan` are unchanged. `searchTranscripts` keeps its signature (the state bench and `transcriptSearch.test.ts` call it).

```python
"""Part 4a Task 1: split the SQLite vector scan out of searchTranscripts (same SQL). Run from the worktree root."""
P = 'src/main/transcriptIndex.ts'
s = open(P).read()
start = s.index('export async function searchTranscripts(')
end = s.index('export async function indexSessionSummaries(')
s = s[:start] + '''/** Brute-force cosine scan of `ids`' current-model embeddings on a SQLite
 *  connection (the MCP server's read-only one). */
export function searchVectorsSqlite(
  db: Database.Database,
  qvec: Float32Array,
  ids: readonly string[],
  opts: { limit: number; kind?: 'turn' | 'summary' },
): SearchHit[] {
  if (ids.length === 0) return [];
  const where = [`workspace_id IN (${ids.map(() => '?').join(',')})`, `model_id = ?`, `text <> ''`];
  const params: unknown[] = [...ids, EMBED_MODEL_ID];
  if (opts.kind) { where.push('kind = ?'); params.push(opts.kind); }

  // Brute-force scan: every allowed vector is read and scored synchronously.
  // Spanned because its cost (and transient memory) grows with the corpus.
  const { rows, ranked } = perfSpan('claude_fleet.search.scan', () => {
    const rows = db
      .prepare(`SELECT session_id AS sessionId, workspace_id AS workspaceId, kind, ts, text, vec
                FROM embeddings WHERE ${where.join(' AND ')}`)
      .all(...params) as Array<{ sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string; vec: Buffer }>;
    const cands = rows.map((r) => ({ vec: decodeVector(r.vec) }));
    return { rows, ranked: topK(qvec, cands, opts.limit) };
  });
  return ranked.map(({ index, score }) => {
    const r = rows[index];
    return { sessionId: r.sessionId, workspaceId: r.workspaceId, kind: r.kind, ts: r.ts, text: r.text, score };
  });
}

export async function searchTranscripts(
  query: string,
  allowedWorkspaces: Set<string>,
  embed: EmbedFn,
  opts: { limit?: number; kind?: 'turn' | 'summary' },
  /** The MCP server's read-only connection; search stays raw better-sqlite3
   *  (SPEC §11). */
  db: Database.Database,
): Promise<SearchHit[]> {
  const ids = [...allowedWorkspaces];
  if (ids.length === 0 || query.trim().length === 0) return [];
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const [qvec] = await embed([query.trim()]);
  return searchVectorsSqlite(db, qvec, ids, { limit, kind: opts.kind });
}

''' + s[end:]
open(P, 'w').write(s)
print('ok')
```

- [ ] **Step 4: Move `mcpServer.ts`'s reads onto the `ReadSource`**

Save as `/tmp/p4a_mcp.py` and run `python3 /tmp/p4a_mcp.py` from `$WT`. Every edit asserts that its anchor occurs exactly once, so a drifted file stops the script instead of half-applying it. What it does:
- The tools take `rs: ReadSource | null`.
- The nine history tools' `run` bodies call the source.
- `aggregateSessionCost` takes token groups.
- `startMcpServer` takes `{ readSource }`, and `setReadSource` is added.
- `_setDbForTests` wraps the handle in `sqliteReadSource`.
- `removeWorkspaceSocket` calls `forgetCaller`.
- `index.ts` passes `{ readSource: null }` on Postgres.
- The no-store message becomes `<tool> is unavailable while the history store is not open`.

```python
"""Part 4a Task 1: move mcpServer.ts's state.db reads onto a ReadSource. Run from the worktree root."""
import re

P = 'src/main/mcpServer.ts'
s = open(P).read()


def sub(old, new, count=1):
    global s
    n = s.count(old)
    assert n == count, f'expected {count} of {old[:70]!r}, found {n}'
    s = s.replace(old, new)


def replace_between(start, end, new):
    """Replace s[start_marker : end_marker) (end marker kept)."""
    global s
    i = s.index(start)
    j = s.index(end, i)
    s = s[:i] + new + s[j:]


def replace_run(tool, new_run):
    """Replace the `run: ... => { ... }` of the tool named `tool` (brace-matched)."""
    global s
    i = s.index(f"name: '{tool}'")
    r = s.index('run:', i)
    b = s.index('{', s.index('=>', r))
    depth = 0
    for k in range(b, len(s)):
        if s[k] == '{':
            depth += 1
        elif s[k] == '}':
            depth -= 1
            if depth == 0:
                break
    s = s[:r] + new_run + s[k + 1:]


# Imports.
sub("import Database from 'better-sqlite3';\n", "import Database from 'better-sqlite3';\nimport { sqliteReadSource } from './sqliteReadSource.js';\nimport type { ReadSource, TokenGroup } from './store/readSource.js';\n")
sub("import { searchTranscripts, type EmbedFn } from './transcriptIndex.js';\n", "import { type EmbedFn } from './transcriptIndex.js';\n")

# Module state.
sub("""let rodb: Database.Database | null = null;
/** Started without state.db (the Postgres store): STATE_DB_TOOLS report unavailable. */
let storeless = false;
/** Tools that read the read-only state.db connection. */""", """let readSource: ReadSource | null = null;
/** Started with no history store yet: STATE_DB_TOOLS report unavailable. */
let storeless = false;
/** Tools that read the history store through the ReadSource. */""")

# startMcpServer.
sub("""export function startMcpServer(dir: string, opts: { stateDb?: boolean } = {}): void {
  if (userDataDir) return;
  if (opts.stateDb === false) {
    storeless = true;
  } else {
    rodb = new Database(join(dir, 'state.db'), { readonly: true, fileMustExist: true });
  }""", """export function startMcpServer(dir: string, opts: { readSource?: ReadSource | null } = {}): void {
  if (userDataDir) return;
  if (opts.readSource === null) {
    storeless = true;
  } else {
    readSource = opts.readSource ?? sqliteReadSource(new Database(join(dir, 'state.db'), { readonly: true, fileMustExist: true }));
  }""")
sub("""/** Ensure `id` is reachable from its container.""", """/** Attach the history store once it opens after startup (null detaches it). */
export function setReadSource(rs: ReadSource | null): void {
  readSource = rs;
  storeless = rs === null;
}

/** Ensure `id` is reachable from its container.""")

# removeWorkspaceSocket drops the caller's store-side state (Postgres roles).
sub("""export function removeWorkspaceSocket(id: string): void {
""", """export function removeWorkspaceSocket(id: string): void {
  void readSource?.forgetCaller(id).catch((e: unknown) =>
    logError({ source: 'main', type: 'mcp-forget-caller', level: 'warn', message: String(e), workspaceId: id }));
""")

# stopMcpServer.
sub("""  try {
    rodb?.close();
  } catch {
    /* ignore */
  }
  rodb = null;
  storeless = false;""", """  void readSource?.close().catch(() => undefined);
  readSource = null;
  storeless = false;""")

# tools/list: a dialect-specific description where the tool has one.
sub("""      return { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };""",
    """      return { tools: TOOLS.map((t) => ({ name: t.name, description: describe(t), inputSchema: t.inputSchema })) };""")

# Test seam + callTool.
sub("""/** Test-only: swap the read-only DB handle without a real listener. */
export function _setDbForTests(db: Database.Database | null): void {
  rodb = db;
}""", """/** Test-only: swap the read-only DB handle without a real listener. */
export function _setDbForTests(db: Database.Database | null): void {
  readSource = db ? sqliteReadSource(db) : null;
}""")
sub("""  if (!rodb && !storeless) throw new RpcError(-32603, 'Database not open');""", """  if (!readSource && !storeless) throw new RpcError(-32603, 'Database not open');""")
sub("""    if (!rodb && STATE_DB_TOOLS.has(name)) throw new Error(`${name} is unavailable on the Postgres store`);
    const result = await tool.run(rodb as Database.Database, args, { callerId, allowedWorkspaces });""",
    """    if (!readSource && STATE_DB_TOOLS.has(name)) throw new Error(`${name} is unavailable while the history store is not open`);
    const result = await tool.run(readSource, args, { callerId, allowedWorkspaces });""")

# Helpers between withIso and TOOLS: cost from token groups, the Tool type, column lists.
replace_between("/** Sum a session's assistant-event token usage", "// Exported for the cross-workspace isolation regression test", """/** Derive USD + token totals from a session's per-(model, service_tier)
 *  token groups via the pricing table. Shared by get_cost and session_summary. */
function aggregateSessionCost(rows: TokenGroup[]): {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
} {
  let usd = 0;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  for (const r of rows) {
    const tokens = {
      inputTokens: r.input,
      outputTokens: r.output,
      cacheReadInputTokens: r.cacheRead,
      cacheCreationInputTokens: r.cacheCreate
    };
    usd += costFor(r.model, r.service_tier, tokens);
    totals.inputTokens += r.input;
    totals.outputTokens += r.output;
    totals.cacheReadInputTokens += r.cacheRead;
    totals.cacheCreationInputTokens += r.cacheCreate;
  }
  return { usd, ...totals };
}

interface Tool {
  name: string;
  description: string;
  /** Replaces `description` in tools/list when the history store is Postgres. */
  pgDescription?: string;
  inputSchema: Record<string, unknown>;
  // ctx carries the host-assigned caller workspace id; `rs` is null only when
  // the history store isn't open (callTool refuses STATE_DB_TOOLS then).
  run: (rs: ReadSource | null, args: Record<string, unknown>, ctx: ToolCtx) => unknown;
}

function describe(t: Tool): string {
  return readSource?.dialect === 'postgres' && t.pgDescription ? t.pgDescription : t.description;
}

function source(rs: ReadSource | null): ReadSource {
  if (!rs) throw new Error('the history store is not open');
  return rs;
}

// Curated event columns (omit raw_jsonl by default — it's large/sensitive and
// the extract columns below cover the common needs). tool_input/tool_use_id/
// tool_result_is_error carry the parsed which-file/which-command detail (#174).
const EVENT_COLS =
  'id, session_id, workspace_id, ts, type, subtype, model, tool_name, tool_use_id, tool_input, tool_result_is_error, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, service_tier';

// Columns a caller may request via list_events `columns` projection. Excludes
// raw_jsonl by design (#146) — use the `query` tool with include_raw for that.
const EVENT_COL_ALLOWLIST = new Set(
  EVENT_COLS.split(',').map((c) => c.trim()).concat(['uuid', 'parent_uuid'])
);

const MAX_QUERY_BYTES = 50_000;

/** Whether a session's workspace is within the caller's allowed read set (#122). */
async function sessionAllowed(rs: ReadSource, sessionId: string, allowed: Set<string>): Promise<boolean> {
  const ws = await rs.sessionWorkspace(sessionId);
  return ws !== null && allowed.has(ws);
}

""")
assert 'function buildSnapshot' not in s

replace_run('list_sessions', """run: async (rs, a, ctx) => {
      // Always restricted to the caller's allowed workspaces (#146) — a
      // caller-supplied workspace_id can only narrow, never widen.
      const rows = await source(rs).listSessions(ctx.allowedWorkspaces, {
        workspaceId: typeof a.workspace_id === 'string' ? a.workspace_id : undefined,
        since: typeof a.since === 'number' ? a.since : undefined,
        until: typeof a.until === 'number' ? a.until : undefined,
        limit: clampLimit(a.limit)
      });
      return rows.map((r) => withIso(r, ['started_at', 'last_active_at']));
    }""")

replace_run('get_session', """run: async (rs, a, ctx) => {
      if (typeof a.id !== 'string') throw new Error('id is required');
      const row = await source(rs).getSession(a.id);
      if (!row) return null;
      // Hide a session outside the caller's allowed set (#146).
      if (!(typeof row.workspace_id === 'string' && ctx.allowedWorkspaces.has(row.workspace_id))) {
        return null;
      }
      // Record clickthrough if this session was recently returned by a search (#207).
      noteRead(ctx.callerId, a.id);
      return withIso(row, ['started_at', 'last_active_at']);
    }""")

replace_run('get_cost', """run: async (rs, a, ctx) => {
      if (typeof a.session_id !== 'string') throw new Error('session_id is required');
      if (!(await sessionAllowed(source(rs), a.session_id, ctx.allowedWorkspaces))) {
        throw new Error('not authorized to read this session');
      }
      // Record clickthrough if this session was recently returned by a search (#207).
      noteRead(ctx.callerId, a.session_id);
      return { session_id: a.session_id, ...aggregateSessionCost(await source(rs).tokenGroups(a.session_id)) };
    }""")

replace_run('list_events', """run: async (rs, a, ctx) => {
      if (typeof a.session_id !== 'string') throw new Error('session_id is required');
      if (!(await sessionAllowed(source(rs), a.session_id, ctx.allowedWorkspaces))) {
        throw new Error('not authorized to read this session');
      }
      // Record clickthrough if this session was recently returned by a search (#207).
      noteRead(ctx.callerId, a.session_id);
      let cols = EVENT_COLS;
      if (Array.isArray(a.columns)) {
        const names = a.columns.map((c) => String(c));
        for (const n of names) {
          if (!EVENT_COL_ALLOWLIST.has(n)) throw new Error(`unknown column: ${n}`);
        }
        if (names.length > 0) cols = names.join(', ');
      }
      const rows = await source(rs).listEvents(a.session_id, {
        type: typeof a.type === 'string' ? a.type : undefined,
        toolName: typeof a.tool_name === 'string' ? a.tool_name : undefined,
        since: typeof a.since === 'number' ? a.since : undefined,
        limit: clampLimit(a.limit),
        columns: cols
      });
      return rows.map((r) => withIso(r, ['ts']));
    }""")

replace_run('search_transcripts', """run: async (rs, a, ctx) => {
      if (typeof a.query !== 'string' || a.query.trim().length === 0) throw new Error('query is required');
      if (!queryEmbedder) throw new Error('transcript search index is unavailable');
      // A caller-supplied workspace_id can only NARROW within the allowed set.
      let allowed = ctx.allowedWorkspaces;
      if (typeof a.workspace_id === 'string') {
        allowed = allowed.has(a.workspace_id) ? new Set([a.workspace_id]) : new Set<string>();
      }
      const limit = typeof a.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(a.limit))) : 10;
      const kind = a.kind === 'turn' || a.kind === 'summary' ? a.kind : undefined;
      let hits: Array<{ sessionId: string }> = [];
      if (allowed.size > 0) {
        const [qvec] = await queryEmbedder([a.query.trim()]);
        hits = await source(rs).searchEmbeddings(qvec, allowed, { limit, kind });
      }
      // Record one search-impression per distinct result session (#207).
      noteSearchResults(ctx.callerId, a.query, hits.map((h) => h.sessionId ?? '').filter(Boolean));
      return hits;
    }""")

replace_run('session_summary', """run: async (rs, a, ctx) => {
      if (typeof a.id !== 'string') throw new Error('id is required');
      if (!(await sessionAllowed(source(rs), a.id, ctx.allowedWorkspaces))) {
        throw new Error('not authorized to read this session');
      }
      // Record clickthrough if this session was recently returned by a search (#207).
      noteRead(ctx.callerId, a.id);
      const MAX_SUMMARY_ITEMS = 100;
      const parts = await source(rs).summaryParts(a.id);
      return withIso(
        {
          session_id: a.id,
          filesEdited: parts.files.slice(0, MAX_SUMMARY_ITEMS),
          filesEditedCount: parts.files.length,
          commands: parts.commands.slice(0, MAX_SUMMARY_ITEMS),
          commandsCount: parts.commands.length,
          ...aggregateSessionCost(parts.tokens),
          started_at: parts.span.started_at,
          last_active_at: parts.span.last_active_at
        },
        ['started_at', 'last_active_at']
      );
    }""")

replace_run('list_errors', """run: async (rs, a, ctx) => {
      const rows = await source(rs).listErrors(ctx.allowedWorkspaces, {
        workspaceId: typeof a.workspace_id === 'string' ? a.workspace_id : undefined,
        sessionId: typeof a.session_id === 'string' ? a.session_id : undefined,
        level: typeof a.level === 'string' ? a.level : undefined,
        type: typeof a.type === 'string' ? a.type : undefined,
        since: typeof a.since === 'number' ? a.since : undefined,
        limit: clampLimit(a.limit)
      });
      return rows.map((r) => ({ ...r, ts_iso: new Date(r.ts as number).toISOString() }));
    }""")

replace_run('query', """run: async (rs, a, ctx) => {
      if (typeof a.sql !== 'string') throw new Error('sql is required');
      const rows = await source(rs).query(
        { callerId: ctx.callerId, scope: ctx.allowedWorkspaces },
        { sql: a.sql, params: Array.isArray(a.params) ? a.params : [], includeRaw: a.include_raw === true, maxRows: clampLimit(a.max_rows) }
      );
      const json = JSON.stringify(rows);
      if (json.length > MAX_QUERY_BYTES) {
        throw new Error(
          `result too large (${json.length} bytes > ${MAX_QUERY_BYTES}); add LIMIT or aggregate server-side`
        );
      }
      return rows;
    }""")

replace_run('mark_useful', """run: async (rs, a, ctx) => {
      if (!usageRecorder) throw new Error('usage recording is unavailable');
      if (typeof a.sessionId !== 'string') throw new Error('sessionId (string) is required');
      // Scope: the session must belong to an allowed workspace (as get_session).
      if (!(await sessionAllowed(source(rs), a.sessionId, ctx.allowedWorkspaces))) throw new Error(`session not found: ${a.sessionId}`);
      await usageRecorder({
        workspaceId: ctx.callerId,
        sessionId: a.sessionId,
        kind: 'marked-useful',
        detail: typeof a.note === 'string' && a.note ? { note: a.note.slice(0, 500) } : undefined
      });
      return { ok: true };
    }""")

# Non-DB tools typed their first parameter as Database; it is now the ReadSource.
s = s.replace('(_db: Database.Database, args: Record<string, unknown>)', '(_rs: ReadSource | null, args: Record<string, unknown>)')
open(P, 'w').write(s)

# index.ts: the Postgres store starts the server with no history store (Task 2 attaches one).
I = 'src/main/index.ts'
t = open(I).read()
old = "startMcpServer(app.getPath('userData'), { stateDb: !pgStores })"
assert t.count(old) == 1
open(I, 'w').write(t.replace(old, "startMcpServer(app.getPath('userData'), pgStores ? { readSource: null } : {})"))
print('ok')
```

- [ ] **Step 5: Make `mcpServer.test.ts` pass a `ReadSource` and await the calls**

Save as `/tmp/p4a_test.py` and run `python3 /tmp/p4a_test.py` from `$WT`. While validating this plan, the script's output passed all 60 tests unchanged. If a hand-edit has landed in the file since, a sync assertion may survive: wrap the call in `await expect(…).rejects` or `(await …)`.

```python
"""Part 4a Task 1: mcpServer.test.ts calls tools with a ReadSource and awaits them. Run from the worktree root."""
import re

P = 'src/main/mcpServer.test.ts'
s = open(P).read()

s = s.replace(
    "import { EMBED_DIM, EMBED_MODEL_ID } from './vectors.js';\n",
    "import { EMBED_DIM, EMBED_MODEL_ID } from './vectors.js';\nimport { sqliteReadSource } from './sqliteReadSource.js';\n",
    1,
)
s = s.replace(
    "function tool(name: string) {",
    "const rs = (d: Database.Database) => sqliteReadSource(d);\n\nfunction tool(name: string) {",
    1,
)
s = s.replace('.run(db,', '.run(rs(db),').replace('.run(fdb,', '.run(rs(fdb),')

CALL = r"(?:tool\('[a-z_]+'\)|t|set|statusTool)\.run\(rs\((?:db|fdb)\),[^\n]*?\)"
# expect(() => CALL).toThrow(...) / .not.toThrow()
s = re.sub(r"expect\(\(\) => (" + CALL + r")\)\.not\.toThrow\(\)", r"await expect(\1).resolves.toBeDefined()", s)
s = re.sub(r"expect\(\(\) => (" + CALL + r")\)\.toThrow\(", r"await expect(\1).rejects.toThrow(", s)
# const x = CALL as T;
s = re.sub(r"= (" + CALL + r") as ", r"= (await \1) as ", s)
# expect(CALL).matcher
s = re.sub(r"(?<!await )expect\((" + CALL + r")\)\.(?!rejects|resolves)", r"expect(await \1).", s)
# a bare statement: `  CALL;`
s = re.sub(r"^(\s+)(" + CALL + r");$", r"\1await \2;", s, flags=re.M)
# the query tests' local `run` helper
s = re.sub(r"= run\((\{[^\n]*?\})\) as ", r"= (await run(\1)) as ", s)
s = re.sub(r"expect\(\(\) => run\((\{[^\n]*?\})\)\)\.toThrow\(", r"await expect(run(\1)).rejects.toThrow(", s)

# The two multi-line calls.
s = s.replace("""    const rows = tool('list_events').run(
      db, { session_id: 'sa', tool_name: 'Edit', columns: ['tool_name', 'tool_input'] }, ctxA
    ) as Array<Record<string, unknown>>;""", """    const rows = (await tool('list_events').run(
      rs(db), { session_id: 'sa', tool_name: 'Edit', columns: ['tool_name', 'tool_input'] }, ctxA
    )) as Array<Record<string, unknown>>;""")
s = s.replace("""    expect(() =>
      tool('list_events').run(rs(db), { session_id: 'sa', columns: ['raw_jsonl; DROP TABLE events'] }, ctxA)
    ).toThrow(/unknown column/i);""", """    await expect(
      tool('list_events').run(rs(db), { session_id: 'sa', columns: ['raw_jsonl; DROP TABLE events'] }, ctxA)
    ).rejects.toThrow(/unknown column/i);""")

# No history store: the message no longer names Postgres.
s = s.replace("describe('startMcpServer({ stateDb: false })', () => {", "describe('startMcpServer({ readSource: null })', () => {")
s = s.replace("startMcpServer(dir, { stateDb: false });", "startMcpServer(dir, { readSource: null });")
s = s.replace("'Error: list_sessions is unavailable on the Postgres store'", "'Error: list_sessions is unavailable while the history store is not open'")
s = s.replace("`Error: ${name} is unavailable on the Postgres store`", "`Error: ${name} is unavailable while the history store is not open`")
open(P, 'w').write(s)
print('ok')
```

- [ ] **Step 6: Typecheck, then look for un-awaited tool calls**

```bash
npx tsc --noEmit -p tsconfig.node.json; echo "node $?"
npx tsc --noEmit -p tsconfig.web.json; echo "web $?"
npm run typecheck:host; echo "host $?"
/usr/bin/grep -nE "^\s+(tool\('[a-z_]+'\)|t)\.run\(rs\(" src/main/mcpServer.test.ts
```

Expected: all three exit 0. The grep should print nothing: a bare `tool(…).run(rs(db), …)` statement without `await` lets the test end before the call does. A hit means the script's await rule missed one; add `await`.

- [ ] **Step 7: Run the MCP tests and the whole SQLite suite**

```bash
CI=true npx vitest run src/main/mcpServer.test.ts src/main/transcriptSearch.test.ts src/main/transcriptIndex.test.ts src/main/mcpServer.planUsage.test.ts
CI=true npx vitest run src
```

Expected: PASS, with 60 tests in `mcpServer.test.ts`, the same count as on origin/main. The renamed `startMcpServer({ readSource: null })` test now expects the new message.

- [ ] **Step 8: Commit**

```bash
git -C "$WT" add src/main/store/readSource.ts src/main/sqliteReadSource.ts src/main/transcriptIndex.ts src/main/mcpServer.ts src/main/mcpServer.test.ts src/main/index.ts
git -C "$WT" commit -m "refactor(mcp): history tools read through a ReadSource; SQLite path moved verbatim

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The Postgres `ReadSource` for the typed tools and search (closes #491)

**Files:**
- Create: `src/main/store/pgReadSource.ts`, `src/main/mcpReadSource.test.ts`
- Modify: `vitest.pg.config.ts` (add the test), `src/main/index.ts` (attach the Postgres source)

**Interfaces:**
- Consumes: `ReadSource` and `QueryRunner` (Task 1); `searchEmbeddings` and `stateKysely` (`db.ts`); `readTransaction` (`store/kysely.ts`).
- Produces: `pgReadSource({ isolation: QueryRunner | null; unavailable?: string; k?: () => Kysely<StateDb> }): ReadSource`.

- [ ] **Step 1: Write the contract suite `src/main/mcpReadSource.test.ts`**

The same fixture goes through each dialect's source, with literal expected values. Equal results on both dialects are the parity proof (D41).

```ts
// The fleet-state read tools on both history stores: the same fixture through
// sqliteReadSource (the MCP read-only connection) and pgReadSource must give
// the same results, scoped to the caller's workspaces.
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as db from './db.js';
import { TOOLS, setQueryEmbedder, setUsageRecorder, type ToolCtx } from './mcpServer.js';
import { costFor } from './pricing.js';
import { sqliteReadSource } from './sqliteReadSource.js';
import { pgReadSource } from './store/pgReadSource.js';
import type { ReadSource } from './store/readSource.js';
import { isPg, openTestState, queryRows, type TestState } from './store/testStore.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from './vectors.js';

const WS_A = '01WORKSPACEAAAAAAAAAAAAAAA';
const WS_B = '01WORKSPACEBBBBBBBBBBBBBBB';
const ctxA: ToolCtx = { callerId: WS_A, allowedWorkspaces: new Set([WS_A]) };
const unit = (i: number): Float32Array => { const v = new Float32Array(EMBED_DIM); v[i] = 1; return v; };

let st: TestState;
let rs: ReadSource;

async function seed(): Promise<void> {
  await queryRows(
    'INSERT INTO sessions (id, workspace_id, started_at, last_active_at, ai_title) VALUES (?,?,?,?,?), (?,?,?,?,?), (?,?,?,?,?)',
    ['sa', WS_A, 900, 1000, 'A session', 'sa-old', WS_A, 100, null, 'A untouched', 'sb', WS_B, 1900, 2000, 'B secret'],
  );
  const ev = 'INSERT INTO events (session_id, workspace_id, ts, type, model, service_tier, input_tokens, output_tokens, tool_name, tool_input, raw_jsonl, dedup_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';
  await queryRows(ev, ['sa', WS_A, 1000, 'assistant', 'claude-x', 'standard', 10, 20, null, null, '{}', 'a1']);
  await queryRows(ev, ['sa', WS_A, 1100, 'assistant', 'claude-x', 'standard', 0, 0, 'Bash', 'npm test', '{}', 'a2']);
  await queryRows(ev, ['sa', WS_A, 1200, 'assistant', 'claude-x', 'standard', 0, 0, 'Edit', '/workspace/foo.ts', '{}', 'a3']);
  await queryRows(ev, ['sa', WS_A, 1300, 'assistant', null, null, 5, 7, null, null, '{}', 'a4']);
  await queryRows(ev, ['sb', WS_B, 2000, 'assistant', 'claude-x', 'standard', 99, 99, 'Bash', 'cat secret', '{}', 'b1']);
  const err = "INSERT INTO errors (ts, workspace_id, session_id, source, level, type, message) VALUES (?, ?, ?, 'main', ?, 'x', ?)";
  await queryRows(err, [1, WS_A, 'sa', 'warn', 'A degraded']);
  await queryRows(err, [2, WS_B, 'sb', 'error', 'B secret error']);
  await queryRows(err, [3, null, null, 'error', 'global crash']);
  await db.insertEmbeddings([
    { workspaceId: WS_A, sessionId: 'sa', kind: 'turn', refEventId: 1, ts: 1000, text: 'A content', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(unit(0)), dedupKey: 'ea' },
    { workspaceId: WS_B, sessionId: 'sb', kind: 'turn', refEventId: 5, ts: 2000, text: 'B secret content', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(unit(0)), dedupKey: 'eb' },
  ]);
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}
const run = (name: string, args: Record<string, unknown>, ctx: ToolCtx = ctxA) => tool(name).run(rs, args, ctx);

describe(`fleet-state read tools on ${isPg ? 'Postgres' : 'SQLite'}`, () => {
  beforeEach(async () => {
    st = await openTestState('cf-mcp-rs-');
    await seed();
    rs = isPg ? pgReadSource({ isolation: null }) : sqliteReadSource(new Database(join(st.dir, 'state.db'), { readonly: true, fileMustExist: true }));
  });
  afterEach(async () => {
    await rs.close();
    await st.close();
  });

  it('list_sessions: the caller\'s sessions, newest first, a NULL last_active_at last', async () => {
    expect(await run('list_sessions', {})).toEqual([
      { id: 'sa', workspace_id: WS_A, cwd: null, started_at: 900, last_active_at: 1000, ai_title: 'A session', first_user_message: null, user_set_name: null,
        started_at_iso: new Date(900).toISOString(), last_active_at_iso: new Date(1000).toISOString() },
      { id: 'sa-old', workspace_id: WS_A, cwd: null, started_at: 100, last_active_at: null, ai_title: 'A untouched', first_user_message: null, user_set_name: null,
        started_at_iso: new Date(100).toISOString() },
    ]);
    expect(await run('list_sessions', { workspace_id: WS_B })).toEqual([]);
    expect((await run('list_sessions', { since: 500 }) as Array<{ id: string }>).map((r) => r.id)).toEqual(['sa']);
    expect((await run('list_sessions', { limit: 1 }) as unknown[]).length).toBe(1);
  });

  it('get_session hides another workspace\'s session', async () => {
    expect(await run('get_session', { id: 'sb' })).toBeNull();
    expect(await run('get_session', { id: 'sa' })).toMatchObject({ id: 'sa', ai_title: 'A session' });
  });

  it('get_cost sums per (model, tier) and refuses another workspace', async () => {
    const usd = costFor(null, null, { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
      + costFor('claude-x', 'standard', { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(await run('get_cost', { session_id: 'sa' })).toEqual({
      session_id: 'sa', usd, inputTokens: 15, outputTokens: 27, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    await expect(run('get_cost', { session_id: 'sb' })).rejects.toThrow(/not authorized/);
  });

  it('list_events: id order, filters and projection; another workspace refused', async () => {
    expect(await run('list_events', { session_id: 'sa', columns: ['id', 'tool_name'] })).toEqual([
      { id: 1, tool_name: null }, { id: 2, tool_name: 'Bash' }, { id: 3, tool_name: 'Edit' }, { id: 4, tool_name: null },
    ]);
    expect(await run('list_events', { session_id: 'sa', tool_name: 'Bash', columns: ['tool_input', 'ts'] })).toEqual([
      { tool_input: 'npm test', ts: 1100, ts_iso: new Date(1100).toISOString() },
    ]);
    expect((await run('list_events', { session_id: 'sa', since: 1200 }) as unknown[]).length).toBe(2);
    await expect(run('list_events', { session_id: 'sb' })).rejects.toThrow(/not authorized/);
  });

  it('session_summary: files, commands, cost and span', async () => {
    const s = await run('session_summary', { id: 'sa' }) as Record<string, unknown>;
    expect(s).toMatchObject({
      session_id: 'sa', filesEdited: ['/workspace/foo.ts'], filesEditedCount: 1, commands: ['npm test'], commandsCount: 1,
      inputTokens: 15, outputTokens: 27, started_at: 1000, last_active_at: 1300,
    });
    await expect(run('session_summary', { id: 'sb' })).rejects.toThrow(/not authorized/);
  });

  it('list_errors: own and global rows, newest first; a workspace_id only narrows', async () => {
    const msgs = async (args: Record<string, unknown>) => (await run('list_errors', args) as Array<{ message: string }>).map((r) => r.message);
    expect(await msgs({})).toEqual(['global crash', 'A degraded']);
    expect(await msgs({ workspace_id: WS_B })).toEqual(['global crash']);
    expect(await msgs({ level: 'warn' })).toEqual(['A degraded']);
  });

  it('search_transcripts never returns another workspace\'s hit', async () => {
    setQueryEmbedder(async (texts) => texts.map(() => unit(0)));
    const hits = await run('search_transcripts', { query: 'anything' }) as Array<{ workspaceId: string; text: string; score: number }>;
    expect(hits.map((h) => [h.workspaceId, h.text])).toEqual([[WS_A, 'A content']]);
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(await run('search_transcripts', { query: 'anything', workspace_id: WS_B })).toEqual([]);
  });

  it('mark_useful records for an allowed session and refuses another workspace\'s', async () => {
    const events: unknown[] = [];
    setUsageRecorder((e) => { events.push(e); });
    await run('mark_useful', { sessionId: 'sa' });
    await expect(run('mark_useful', { sessionId: 'sb' })).rejects.toThrow(/not found/);
    expect(events).toEqual([{ workspaceId: WS_A, sessionId: 'sa', kind: 'marked-useful', detail: undefined }]);
    setUsageRecorder(() => {});
  });
});
```

Add it to the Postgres suite:

```bash
python3 - <<'EOF'
import re
p = 'vitest.pg.config.ts'
s = open(p).read()
m = re.search(r'(    include: \[\n)(.*?)(\n    \],)', s, flags=re.S)
have = set(re.findall(r"'([^']+)'", m.group(2))) | {'src/main/mcpReadSource.test.ts'}
body = '\n'.join(f"      '{f}'," for f in sorted(have))
open(p, 'w').write(s[:m.start()] + m.group(1) + body + m.group(3) + s[m.end():])
EOF
```

- [ ] **Step 2: Run it on both dialects to see it fail**

```bash
npx vitest run src/main/mcpReadSource.test.ts
STORE_TEST_DIALECT=postgres npx vitest run src/main/mcpReadSource.test.ts
```

Expected: SQLite passes (Task 1's source). Postgres fails to import `./store/pgReadSource.js`.

- [ ] **Step 3: Write `src/main/store/pgReadSource.ts`**

Every method runs in `readTransaction`. On Postgres that is REPEATABLE READ, READ ONLY: one snapshot, and no write lock, because raw SQL inside a read-only transaction isn't serialized (D21). The column alias `"cacheRead"` must be quoted, or Postgres folds it to lower case.

```ts
// The MCP read path on Postgres: the typed tools' SQL on the store's own pool,
// filtered by the caller's scope as on SQLite; `query` goes through the
// role + RLS isolation (pgQueryIsolation.ts).
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { searchEmbeddings, stateKysely } from '../db.js';
import { readTransaction } from './kysely.js';
import type { StateDb } from './stateSchema.js';
import type { QueryRunner, ReadSource, Row, Scope, SummaryParts, TokenGroup } from './readSource.js';

const inScope = (scope: Scope): RawBuilder<unknown> => sql`workspace_id IN (${sql.join([...scope])})`;
const and = (conds: RawBuilder<unknown>[]): RawBuilder<unknown> => sql.join(conds, sql` AND `);

export interface PgReadSourceOptions {
  /** null: `query` reports `unavailable` (why is in the message). */
  isolation: QueryRunner | null;
  unavailable?: string;
  k?: () => Kysely<StateDb>;
}

export function pgReadSource(o: PgReadSourceOptions): ReadSource {
  const k = o.k ?? stateKysely;
  const read = <T>(fn: (q: Kysely<StateDb>) => Promise<T>): Promise<T> => readTransaction(k(), fn);
  const tokenGroups = async (q: Kysely<StateDb>, sessionId: string): Promise<TokenGroup[]> =>
    (await sql<TokenGroup>`
      SELECT model, service_tier,
             SUM(COALESCE(input_tokens, 0)) AS input,
             SUM(COALESCE(output_tokens, 0)) AS output,
             SUM(COALESCE(cache_read_input_tokens, 0)) AS "cacheRead",
             SUM(COALESCE(cache_creation_input_tokens, 0)) AS "cacheCreate"
      FROM events WHERE session_id = ${sessionId} AND type = 'assistant'
      GROUP BY model, service_tier
      ORDER BY model NULLS FIRST, service_tier NULLS FIRST`.execute(q)).rows;
  const distinctInputs = async (q: Kysely<StateDb>, sessionId: string, names: string[]): Promise<string[]> =>
    (await sql<{ tool_input: string }>`
      SELECT DISTINCT tool_input FROM events
      WHERE session_id = ${sessionId} AND tool_name IN (${sql.join(names)}) AND tool_input IS NOT NULL
      ORDER BY tool_input`.execute(q)).rows.map((r) => r.tool_input);

  return {
    dialect: 'postgres',
    async listSessions(scope, f) {
      if (scope.size === 0) return [];
      const conds = [inScope(scope)];
      if (f.workspaceId !== undefined) conds.push(sql`workspace_id = ${f.workspaceId}`);
      if (f.since !== undefined) conds.push(sql`last_active_at >= ${f.since}`);
      if (f.until !== undefined) conds.push(sql`last_active_at <= ${f.until}`);
      // SQLite sorts NULL last under DESC; the id tiebreak makes the order total.
      return read(async (q) => (await sql<Row>`
        SELECT * FROM sessions WHERE ${and(conds)}
        ORDER BY last_active_at DESC NULLS LAST, id LIMIT ${f.limit}`.execute(q)).rows);
    },
    async getSession(id) {
      return read(async (q) => (await sql<Row>`SELECT * FROM sessions WHERE id = ${id}`.execute(q)).rows[0] ?? null);
    },
    async sessionWorkspace(id) {
      const r = await read(async (q) => (await sql<{ workspace_id: string }>`SELECT workspace_id FROM sessions WHERE id = ${id}`.execute(q)).rows[0]);
      return r?.workspace_id ?? null;
    },
    async tokenGroups(sessionId) {
      return read((q) => tokenGroups(q, sessionId));
    },
    async listEvents(sessionId, f) {
      const conds = [sql`session_id = ${sessionId}`];
      if (f.type !== undefined) conds.push(sql`type = ${f.type}`);
      if (f.toolName !== undefined) conds.push(sql`tool_name = ${f.toolName}`);
      if (f.since !== undefined) conds.push(sql`ts >= ${f.since}`);
      return read(async (q) => (await sql<Row>`
        SELECT ${sql.raw(f.columns)} FROM events WHERE ${and(conds)} ORDER BY id ASC LIMIT ${f.limit}`.execute(q)).rows);
    },
    async summaryParts(sessionId): Promise<SummaryParts> {
      return read(async (q) => {
        const files = await distinctInputs(q, sessionId, ['Write', 'Edit', 'NotebookEdit']);
        const commands = await distinctInputs(q, sessionId, ['Bash']);
        const span = (await sql<SummaryParts['span']>`
          SELECT MIN(ts) AS started_at, MAX(ts) AS last_active_at FROM events WHERE session_id = ${sessionId}`.execute(q)).rows[0];
        return { files, commands, tokens: await tokenGroups(q, sessionId), span };
      });
    },
    async listErrors(scope, f) {
      const conds = [sql`(${scope.size ? inScope(scope) : sql`false`} OR workspace_id IS NULL)`];
      if (f.workspaceId !== undefined) conds.push(sql`(workspace_id = ${f.workspaceId} OR workspace_id IS NULL)`);
      if (f.sessionId !== undefined) conds.push(sql`session_id = ${f.sessionId}`);
      if (f.level !== undefined) conds.push(sql`level = ${f.level}`);
      if (f.type !== undefined) conds.push(sql`type = ${f.type}`);
      if (f.since !== undefined) conds.push(sql`ts >= ${f.since}`);
      return read(async (q) => (await sql<Row>`
        SELECT * FROM errors WHERE ${and(conds)} ORDER BY id DESC LIMIT ${f.limit}`.execute(q)).rows);
    },
    searchEmbeddings(qvec, scope, opts) {
      return searchEmbeddings(qvec, [...scope], opts);
    },
    async query(caller, q) {
      if (!o.isolation) throw new Error(o.unavailable ?? 'query is unavailable on this Postgres store');
      return o.isolation.query(caller, q);
    },
    async forgetCaller(callerId) {
      await o.isolation?.forgetCaller(callerId);
    },
    async close() {
      await o.isolation?.end();
    },
  };
}
```

- [ ] **Step 4: Run the suite on both dialects**

```bash
npx vitest run src/main/mcpReadSource.test.ts
STORE_TEST_DIALECT=postgres npx vitest run src/main/mcpReadSource.test.ts
```

Expected: 8/8 on each.

- [ ] **Step 5: Mutation-check the scope filters**

In `pgReadSource.ts`, replace `const conds = [inScope(scope)];` with ``const conds = [sql`true`];``. Replace ``${scope.size ? inScope(scope) : sql`false`}`` with `true`. Run the Postgres line from Step 4.

Expected: `list_sessions: …` and `list_errors: …` fail (measured: 2 failed). Revert both edits, then re-run until green.

- [ ] **Step 6: Attach the Postgres source at startup**

In `src/main/index.ts`, change the Task 1 line
`startMcpServer(app.getPath('userData'), pgStores ? { readSource: null } : {})`
to
`startMcpServer(app.getPath('userData'), pgStores ? { readSource: pgReadSource({ isolation: null }) } : {})`
and add `import { pgReadSource } from './store/pgReadSource.js';` beside the `openPgStores` import. Until Task 4 wires isolation, `query` on Postgres answers `query is unavailable on this Postgres store`.

- [ ] **Step 7: Gate and commit**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run typecheck:host
CI=true npx vitest run src
CI=true npm run test:unit:pg
git -C "$WT" add src/main/store/pgReadSource.ts src/main/mcpReadSource.test.ts vitest.pg.config.ts src/main/index.ts
git -C "$WT" commit -m "feat(mcp): typed history tools and search_transcripts on the Postgres store

Closes the last #491 item: search_transcripts calls searchEmbeddings (pgvector) on Postgres.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `query` isolation on Postgres: roles, RLS, per-call execution

**Files:**
- Create: `src/main/store/scram.ts`, `src/main/store/scram.test.ts`, `src/main/store/pgQueryIsolation.ts`, `src/main/store/pgQueryIsolation.test.ts`
- Modify: `src/main/store/testStore.ts` (`testPgAppSchema`), `src/main/store/pgGlobalSetup.ts` (stale roles), `vitest.pg.config.ts`

**Interfaces:**
- Consumes: `QueryRunner`, `QueryArgs`, `QueryCaller`, `MCP_QUERY_TABLES` and `SNAPSHOT_EVENT_COLS` (Task 1); `pgTypes`, `writeLock` and `PgPoolConfig` (`postgres.ts`).
- Produces:
  - `scramVerifier(password, salt?, iterations?): string`.
  - `PgQueryIsolation.open(app: Kysely<DB>, schema, base: PgPoolConfig, opts?): Promise<PgQueryIsolation>`, which throws `QueryUnavailableError`. Its methods are `query(caller, q)`, `forgetCaller(id)` and `end()`.
  - `callerRole(schema, callerId)`, `isolationRoles(schema)`, `rolePoolConfig(base, user, password)`, `ensureIsolation(k, schema)` and `isolationBlocker(k, schema)`.
  - From the test store: `testPgAppSchema(): Promise<TestPgApp>`, with `appRole`, `appConfig` and `appPool`.

- [ ] **Step 1: Write the SCRAM verifier test `src/main/store/scram.test.ts`**

```ts
import { createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { scramVerifier } from './scram.js';

// RFC 7677 §3: user "user", password "pencil".
const SALT = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
const AUTH_MESSAGE =
  'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
  'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
  'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
const CLIENT_PROOF = 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=';
const SERVER_SIGNATURE = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

function parse(v: string) {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(v);
  if (!m) throw new Error(`not a verifier: ${v}`);
  return { iterations: Number(m[1]), salt: m[2], storedKey: Buffer.from(m[3], 'base64'), serverKey: Buffer.from(m[4], 'base64') };
}

it('matches the RFC 7677 test vector (server signature and stored key)', () => {
  const v = parse(scramVerifier('pencil', SALT));
  expect(v.iterations).toBe(4096);
  expect(v.salt).toBe('W22ZaJ0SNY7soEsUEjb6gQ==');
  expect(createHmac('sha256', v.serverKey).update(AUTH_MESSAGE).digest('base64')).toBe(SERVER_SIGNATURE);
  const sig = createHmac('sha256', v.storedKey).update(AUTH_MESSAGE).digest();
  const clientKey = Buffer.from(Buffer.from(CLIENT_PROOF, 'base64').map((b, i) => b ^ sig[i]));
  expect(createHash('sha256').update(clientKey).digest().equals(v.storedKey)).toBe(true);
});

it('uses a fresh salt by default and never contains the password', () => {
  const a = scramVerifier('s3cret-value');
  expect(a).not.toBe(scramVerifier('s3cret-value'));
  expect(a).not.toContain('s3cret-value');
  expect(a).not.toContain("'");
});
```

Run `npx vitest run src/main/store/scram.test.ts`. Expected: FAIL (no `./scram.js`).

- [ ] **Step 2: Write `src/main/store/scram.ts` and re-run**

```ts
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/** A SCRAM-SHA-256 verifier in Postgres's stored form. `ALTER ROLE … PASSWORD
 *  '<verifier>'` sets a password without the plaintext reaching the server, its
 *  logs or a process argument list. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
```

Expected: 2/2 PASS.

- [ ] **Step 3: Write the isolation test `src/main/store/pgQueryIsolation.test.ts`**

It runs on Postgres only, as a non-superuser store role (superusers bypass RLS). Every test reads as caller `W-A` and must never see a row of `W-B`.

```ts
// `query` isolation on Postgres (role + RLS). Postgres only: SQLite isolates
// with the in-memory snapshot (mcpServer.test.ts). Every test reads as caller
// A and must never see a row of workspace B.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql } from 'kysely';
import * as db from '../db.js';
import { callerRole, isolationRoles, PgQueryIsolation, QueryUnavailableError, rolePoolConfig } from './pgQueryIsolation.js';
import { MCP_QUERY_TABLES } from './readSource.js';
import { isPg, queryRows, testPgAppSchema, type TestPgApp } from './testStore.js';

const A = 'W-A';
const B = 'W-B';
const scopeA = new Set([A]);
const q = (sqlText: string, o: { params?: unknown[]; includeRaw?: boolean; maxRows?: number; scope?: Set<string>; caller?: string } = {}) =>
  iso.query({ callerId: o.caller ?? A, scope: o.scope ?? scopeA }, { sql: sqlText, params: o.params ?? [], includeRaw: o.includeRaw ?? false, maxRows: o.maxRows ?? 200 });

let t: TestPgApp;
let iso: PgQueryIsolation;

async function seed(): Promise<void> {
  for (const [ws, s] of [[A, 'sa'], [B, 'sb']] as const) {
    await queryRows('INSERT INTO sessions (id, workspace_id, last_active_at) VALUES (?, ?, ?)', [s, ws, 1000]);
    for (let i = 0; i < 3; i++) {
      await queryRows(
        'INSERT INTO events (session_id, workspace_id, ts, type, tool_input, raw_jsonl, dedup_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [s, ws, i, 'assistant', `input-${ws}`, `raw-${ws}`, `${s}-${i}`],
      );
    }
    await queryRows('INSERT INTO broker_sessions (workspace_id, broker_session_id, claude_session_id, learned_at) VALUES (?, ?, ?, ?)', [ws, `b-${s}`, s, 1]);
    await queryRows('INSERT INTO session_summaries (session_id, workspace_id, summary, source_max_event_id, generated_at) VALUES (?, ?, ?, ?, ?)', [s, ws, `summary-${ws}`, 1, 1]);
    await queryRows('INSERT INTO session_tags (workspace_id, session_id, tag) VALUES (?, ?, ?)', [ws, s, `tag-${ws}`]);
    await queryRows('INSERT INTO usage_events (ts, workspace_id, session_id, kind) VALUES (?, ?, ?, ?)', [1, ws, s, 'search-impression']);
    await queryRows('INSERT INTO perf_events (ts, kind, workspace_id, name) VALUES (?, ?, ?, ?)', [1, 'span', ws, `perf-${ws}`]);
    await queryRows("INSERT INTO errors (ts, workspace_id, source, level, type, message) VALUES (?, ?, 'main', 'error', 'x', ?)", [1, ws, `err-${ws}`]);
  }
  await queryRows("INSERT INTO perf_events (ts, kind, workspace_id, name) VALUES (1, 'stall', NULL, 'global')");
}

describe.skipIf(!isPg)('query isolation on Postgres (role + RLS)', () => {
  beforeEach(async () => {
    t = await testPgAppSchema();
    await db.openDbPostgres(t.appPool);
    await seed();
    iso = await PgQueryIsolation.open(db.stateKysely(), t.schema, t.appConfig);
  });
  afterEach(async () => {
    await iso.end();
    await db.closeDb();
    await t.drop();
  });

  it('every exposed table returns only the caller\'s workspaces', async () => {
    for (const table of MCP_QUERY_TABLES) {
      const rows = (await q(`SELECT DISTINCT workspace_id FROM ${table} ORDER BY 1 NULLS FIRST`)) as Array<{ workspace_id: string | null }>;
      const ids = rows.map((r) => r.workspace_id);
      expect(ids, table).toEqual(table === 'perf_events' ? [null, A] : [A]);
    }
  });

  it('a schema-qualified table, a join or a subquery stays scoped', async () => {
    expect(await q(`SELECT count(*) AS n FROM ${t.schema}.events`)).toEqual([{ n: 3 }]);
    expect(await q(`SELECT count(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id`)).toEqual([{ n: 3 }]);
    expect(await q(`SELECT (SELECT count(*) FROM ${t.schema}.sessions) AS n`)).toEqual([{ n: 1 }]);
  });

  it('a query run from inside the statement (query_to_xml) is scoped too', async () => {
    const [row] = (await q(`SELECT query_to_xml('select count(*) as n from ${t.schema}.events', true, true, '') AS x`)) as Array<{ x: string }>;
    expect(row.x).toContain('<n>3</n>');
  });

  it('cannot switch to the store role or another caller\'s role', async () => {
    await q('SELECT 1', { caller: B, scope: new Set([B]) });
    await expect(q(`SELECT set_config('role', '${t.appRole}', true)`)).rejects.toThrow(/permission denied to set role/);
    await expect(q(`SELECT set_config('role', '${callerRole(t.schema, B)}', true)`)).rejects.toThrow(/permission denied to set role/);
    await expect(q(`SELECT set_config('session_authorization', '${t.appRole}', true)`)).rejects.toThrow(/permission denied/);
  });

  it('tables outside the exposed set are unreadable', async () => {
    const all = (await sql<{ t: string }>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ${t.schema}`.execute(db.stateKysely())).rows.map((r) => r.t);
    const hidden = all.filter((n) => !(MCP_QUERY_TABLES as readonly string[]).includes(n));
    expect(hidden).toEqual(expect.arrayContaining(['errors', 'embeddings', 'mcp_grants', 'schema_migrations', 'session_costs']));
    for (const n of hidden) await expect(q(`SELECT * FROM ${t.schema}.${n}`), n).rejects.toThrow(/permission denied/);
  });

  it('mcp_scope() returns only the caller\'s own scope', async () => {
    await q('SELECT 1', { caller: B, scope: new Set([B]) });
    expect(await q(`SELECT ${t.schema}.mcp_scope() AS s`)).toEqual([{ s: [A] }]);
  });

  it('column statistics are hidden and a failing predicate cannot probe other rows', async () => {
    await sql`ANALYZE events`.execute(db.stateKysely());
    expect(await q(`SELECT attname FROM pg_stats WHERE schemaname = '${t.schema}' AND tablename = 'events'`)).toEqual([]);
    expect(await q(`SELECT count(*) AS n FROM ${t.schema}.events WHERE 1 / (CASE WHEN workspace_id = '${B}' THEN 0 ELSE 1 END) = 1`)).toEqual([{ n: 3 }]);
  });

  it('raw_jsonl only with include_raw, and then only the caller\'s rows', async () => {
    await expect(q('SELECT raw_jsonl FROM events')).rejects.toThrow(/raw_jsonl/);
    await expect(q(`SELECT raw_jsonl FROM ${t.schema}.events`)).rejects.toThrow(/permission denied/);
    expect(await q('SELECT DISTINCT raw_jsonl FROM events', { includeRaw: true })).toEqual([{ raw_jsonl: `raw-${A}` }]);
    expect(await q(`SELECT DISTINCT raw_jsonl FROM ${t.schema}.events`, { includeRaw: true })).toEqual([{ raw_jsonl: `raw-${A}` }]);
  });

  it('accepts one SELECT only: writes, DDL, utility statements and a second statement are refused', async () => {
    await expect(q('SELECT 1; SELECT 2')).rejects.toThrow(/multiple commands/);
    await expect(q(`DELETE FROM ${t.schema}.events`)).rejects.toThrow(/syntax error/);
    await expect(q(`WITH d AS (DELETE FROM ${t.schema}.events RETURNING 1) SELECT * FROM d`)).rejects.toThrow(/data-modifying/);
    await expect(q('SET ROLE NONE')).rejects.toThrow(/syntax error/);
    await expect(q('SELECT 1) AS x')).rejects.toThrow(/syntax error/);
    expect(await q('SELECT 1 AS x;')).toEqual([{ x: 1 }]);
    expect(await sql<{ n: number }>`SELECT count(*) AS n FROM events`.execute(db.stateKysely())).toMatchObject({ rows: [{ n: 6 }] });
  });

  it('binds $n params and caps rows at maxRows', async () => {
    expect(await q('SELECT id FROM sessions WHERE id = $1', { params: ['sa'] })).toEqual([{ id: 'sa' }]);
    expect(await q('SELECT id FROM sessions WHERE id = $1', { params: ['sb'] })).toEqual([]);
    expect(await q('SELECT g FROM generate_series(1, 50) g', { maxRows: 3 })).toEqual([{ g: 1 }, { g: 2 }, { g: 3 }]);
  });

  it('session-level effects do not outlive a call', async () => {
    await q('SELECT pg_advisory_lock(7340211) AS l');
    await q(`SELECT set_config('search_path', 'pg_catalog', false) AS s`);
    const held = await sql<{ n: number }>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'`.execute(db.stateKysely());
    expect(held.rows[0].n).toBe(0);
    expect(await q('SELECT count(*) AS n FROM sessions')).toEqual([{ n: 1 }]);
  });

  it('a grant applies on the next call and a revocation stops it on the next call', async () => {
    expect(await q('SELECT DISTINCT workspace_id FROM sessions ORDER BY 1', { scope: new Set([A, B]) })).toEqual([{ workspace_id: A }, { workspace_id: B }]);
    expect(await q('SELECT DISTINCT workspace_id FROM sessions ORDER BY 1')).toEqual([{ workspace_id: A }]);
  });

  it('concurrent callers each see only their own scope', async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => {
      const ws = i % 2 === 0 ? A : B;
      return q('SELECT DISTINCT workspace_id FROM events', { caller: ws, scope: new Set([ws]) }).then((r) => [ws, r] as const);
    }));
    for (const [ws, rows] of runs) expect(rows).toEqual([{ workspace_id: ws }]);
  });

  it('a long statement hits the statement timeout', async () => {
    await iso.end();
    iso = await PgQueryIsolation.open(db.stateKysely(), t.schema, t.appConfig, { statementTimeoutMs: 200 });
    await expect(q('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/);
  });

  it('forgetCaller drops the caller\'s roles and grants', async () => {
    await q('SELECT 1');
    await iso.forgetCaller(A);
    const roles = await sql<{ n: number }>`SELECT count(*) AS n FROM pg_roles WHERE rolname LIKE ${callerRole(t.schema, A) + '%'}`.execute(db.stateKysely());
    expect(roles.rows[0].n).toBe(0);
    expect(await q('SELECT count(*) AS n FROM sessions')).toEqual([{ n: 1 }]);
  });

  it('the caller role cannot log in with a guessed password', async () => {
    await q('SELECT 1');
    const c = new pg.Client(rolePoolConfig(t.appConfig, callerRole(t.schema, A), 'wrong'));
    const login = c.connect().then(() => 'connected', (e: { code?: string }) => e.code);
    // The local socket server trusts every login; CI's TCP service checks SCRAM.
    expect(['28P01', 'connected']).toContain(await login);
    await c.end().catch(() => undefined);
  });

  it('a store role without CREATEROLE leaves query unavailable', async () => {
    await t.pool.query(`ALTER ROLE ${t.appRole} NOCREATEROLE`);
    await expect(PgQueryIsolation.open(db.stateKysely(), t.schema, t.appConfig)).rejects.toThrow(QueryUnavailableError);
    expect(isolationRoles(t.schema).reader).toBe(`${t.schema}_mcp_reader`);
  });
});
```

- [ ] **Step 4: Add the store-role test helper, stale-role cleanup and the suite entry**

Save as `/tmp/p4a_t3.py` and run `python3 /tmp/p4a_t3.py` from `$WT`. Test roles are cluster-wide, so `pgGlobalSetup` drops an hour-old run's roles as it already drops its schemas.

```python
"""Part 4a Task 3: the test store role helper, stale-role cleanup, the Postgres suite list. Run from the worktree root."""
import re


def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected one {old[:70]!r}, found {s.count(old)}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


edit('src/main/store/testStore.ts', [
    ("import { createPgPool } from './postgres.js';",
     "import { createPgPool, type PgPoolConfig } from './postgres.js';\nimport { rolePoolConfig } from './pgQueryIsolation.js';\nimport { scramVerifier } from './scram.js';"),
])
with open('src/main/store/testStore.ts', 'a') as f:
    f.write('''
export interface TestPgApp extends TestPg {
  /** The store role: owns the schema, has CREATEROLE, is not a superuser. */
  appRole: string;
  /** Pool options for appRole (what the store's own pool would use). */
  appConfig: PgPoolConfig;
  appPool: pg.Pool;
}

/** A fresh schema owned by a non-superuser store role, as on a real server:
 *  RLS doesn't apply to superusers, so isolation is only testable this way.
 *  drop() also removes every role named after the schema. */
export async function testPgAppSchema(): Promise<TestPgApp> {
  const t = await testPgSchema();
  const appRole = `${t.schema}_app`;
  const password = randomBytes(24).toString('base64url');
  await t.pool.query(`CREATE ROLE ${appRole} LOGIN CREATEROLE PASSWORD '${scramVerifier(password)}'`);
  await t.pool.query(`ALTER SCHEMA ${t.schema} OWNER TO ${appRole}`);
  const { types: _types, max: _max, idleTimeoutMillis: _idle, ...conn } = rolePoolConfig(
    { connectionString: process.env.PG_TEST_URL, schema: t.schema }, appRole, password,
  );
  const appConfig: PgPoolConfig = { ...conn, schema: t.schema, max: POOL_MAX };
  const appPool = createPgPool(appConfig);
  return {
    ...t, appRole, appConfig, appPool,
    async drop() {
      await appPool.end();
      await t.pool.query(`DROP SCHEMA ${t.schema} CASCADE`);
      const roles = await t.pool.query<{ r: string }>(`SELECT rolname AS r FROM pg_roles WHERE rolname LIKE $1 ORDER BY length(rolname) DESC`, [`${t.schema}\\\\_%`]);
      for (const { r } of roles.rows) {
        await t.pool.query(`DROP OWNED BY ${r}`);
        await t.pool.query(`DROP ROLE ${r}`);
      }
      await t.pool.end();
    },
  };
}
''')

edit('src/main/store/pgGlobalSetup.ts', [
    ("""    for (const { s } of all.rows) if (isStaleTestSchema(s, now)) await c.query(`DROP SCHEMA ${s} CASCADE`);""",
     """    for (const { s } of all.rows) if (isStaleTestSchema(s, now)) await c.query(`DROP SCHEMA ${s} CASCADE`);
    // testPgAppSchema's roles (<schema>_app, <schema>_mcp_*) are cluster-wide and outlive a crashed run.
    const roles = await c.query<{ r: string }>(`SELECT rolname AS r FROM pg_roles WHERE rolname ~ '^t_[0-9]+_[0-9a-f]+_' ORDER BY length(rolname) DESC`);
    for (const { r } of roles.rows) {
      const schema = /^(t_\\d+_[0-9a-f]+)_/.exec(r)?.[1];
      if (!schema || !isStaleTestSchema(schema, now)) continue;
      await c.query(`DROP OWNED BY ${r}`);
      await c.query(`DROP ROLE ${r}`);
    }"""),
])

p = 'vitest.pg.config.ts'
s = open(p).read()
m = re.search(r'(    include: \[\n)(.*?)(\n    \],)', s, flags=re.S)
have = set(re.findall(r"'([^']+)'", m.group(2))) | {'src/main/store/pgQueryIsolation.test.ts'}
body = '\n'.join(f"      '{f}'," for f in sorted(have))
open(p, 'w').write(s[:m.start()] + m.group(1) + body + m.group(3) + s[m.end():])
print('ok')
```

Run `STORE_TEST_DIALECT=postgres npx vitest run src/main/store/pgQueryIsolation.test.ts`. Expected: FAIL (no `./pgQueryIsolation.js`). `testStore.ts` imports it as well, so the whole Postgres suite fails to load until Step 5.

- [ ] **Step 5: Write `src/main/store/pgQueryIsolation.ts`**

```ts
// MCP `query` isolation on Postgres (SPEC §11): each caller workspace reads
// through its own LOGIN role. Row-level security limits every exposed table to
// the workspaces in `mcp_grants` for session_user, which the caller's SQL can't
// change (SET ROLE / set_config('role') reach only the caller's own roles).
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { parse as parseConnectionString } from 'pg-connection-string';
import { pgTypes, writeLock, type PgPoolConfig } from './postgres.js';
import { scramVerifier } from './scram.js';
import { MCP_QUERY_TABLES, SNAPSHOT_EVENT_COLS, type QueryArgs, type QueryCaller, type QueryRunner } from './readSource.js';

/** Role names are `<schema>_mcp_<16 hex>_raw` at most: within Postgres's 63. */
const MAX_SCHEMA_LEN = 32;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

export class QueryUnavailableError extends Error {}

export interface IsolationRoles { reader: string; raw: string }

export function isolationRoles(schema: string): IsolationRoles {
  return { reader: `${schema}_mcp_reader`, raw: `${schema}_mcp_raw` };
}

/** A caller's LOGIN role. Hashed: workspace ids aren't identifier-safe. */
export function callerRole(schema: string, callerId: string): string {
  return `${schema}_mcp_${createHash('sha256').update(callerId).digest('hex').slice(0, 16)}`;
}

/** pg options to log in as `user` where the store pool connects. A connection
 *  string's own user and password would win over explicit fields, so it is split. */
export function rolePoolConfig(base: PgPoolConfig, user: string, password: string): pg.PoolConfig {
  const { connectionString, schema: _schema, session: _session, user: _u, password: _p, max: _max, ...rest } = base as PgPoolConfig & pg.PoolConfig;
  const cs = connectionString ? parseConnectionString(connectionString) : null;
  return {
    ...rest,
    host: cs?.host ?? rest.host,
    port: cs?.port ? Number(cs.port) : rest.port,
    database: cs?.database ?? rest.database,
    user, password,
    max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
    types: pgTypes,
  };
}

const POLICY = (schema: string, table: string): string =>
  table === 'perf_events'
    ? `workspace_id IS NULL OR workspace_id IN (SELECT unnest(${schema}.mcp_scope()))`
    : `workspace_id IN (SELECT unnest(${schema}.mcp_scope()))`;

/** Idempotent; runs as the store role, which owns the tables and has CREATEROLE. */
export async function ensureIsolation<DB>(k: Kysely<DB>, schema: string): Promise<void> {
  const r = isolationRoles(schema);
  await k.transaction().execute(async (trx) => {
    const run = (text: string) => sql.raw(text).execute(trx);
    await run(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r.reader}') THEN CREATE ROLE ${r.reader} NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r.raw}') THEN CREATE ROLE ${r.raw} NOLOGIN; END IF;
    END $$`);
    await run(`CREATE TABLE IF NOT EXISTS mcp_grants (
      role_name TEXT COLLATE "C" NOT NULL, workspace_id TEXT COLLATE "C" NOT NULL, PRIMARY KEY (role_name, workspace_id))`);
    await run(`CREATE OR REPLACE FUNCTION mcp_scope() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog
      AS $f$ SELECT coalesce(array_agg(workspace_id), '{}') FROM ${schema}.mcp_grants WHERE role_name = session_user $f$`);
    await run(`REVOKE ALL ON FUNCTION mcp_scope() FROM PUBLIC`);
    await run(`GRANT USAGE ON SCHEMA ${schema} TO ${r.reader}`);
    await run(`GRANT EXECUTE ON FUNCTION mcp_scope() TO ${r.reader}`);
    await run(`GRANT SELECT (${SNAPSHOT_EVENT_COLS}) ON events TO ${r.reader}`);
    await run(`GRANT SELECT (raw_jsonl) ON events TO ${r.raw}`);
    await run(`GRANT SELECT ON ${MCP_QUERY_TABLES.filter((t) => t !== 'events').join(', ')} TO ${r.reader}`);
    for (const t of MCP_QUERY_TABLES) {
      await run(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await run(`DROP POLICY IF EXISTS mcp_read ON ${t}`);
      await run(`CREATE POLICY mcp_read ON ${t} FOR SELECT TO ${r.reader} USING (${POLICY(schema, t)})`);
    }
  });
}

/** Why `query` can't be isolated on this server, or null when it can. */
export async function isolationBlocker<DB>(k: Kysely<DB>, schema: string): Promise<string | null> {
  if (schema.length > MAX_SCHEMA_LEN) return `the store schema name is longer than ${MAX_SCHEMA_LEN} characters`;
  const r = await sql<{ v: number; cr: boolean }>`
    SELECT current_setting('server_version_num')::int AS v, rolcreaterole AS cr FROM pg_roles WHERE rolname = current_user`.execute(k);
  const row = r.rows[0];
  if (!row || row.v < 160000) return 'it needs Postgres 16 or later';
  if (!row.cr) return 'the store role needs CREATEROLE (it creates one read-only role per workspace)';
  return null;
}

export interface QueryIsolationOptions { statementTimeoutMs?: number; onPoolError?: (e: Error) => void }

export class PgQueryIsolation implements QueryRunner {
  private readonly pools = new Map<string, pg.Pool>();
  private readonly locks = new Map<string, () => Promise<() => void>>();
  private readonly ensured = new Map<string, Promise<void>>();

  private constructor(
    private readonly app: Kysely<unknown>,
    private readonly schema: string,
    private readonly base: PgPoolConfig,
    private readonly opts: QueryIsolationOptions,
  ) {}

  /** Provisions the shared roles, grants and policies; throws QueryUnavailableError when the server can't. */
  static async open<DB>(app: Kysely<DB>, schema: string, base: PgPoolConfig, opts: QueryIsolationOptions = {}): Promise<PgQueryIsolation> {
    const blocker = await isolationBlocker(app, schema);
    if (blocker) throw new QueryUnavailableError(`query is unavailable on this Postgres store: ${blocker}`);
    await ensureIsolation(app, schema);
    return new PgQueryIsolation(app as Kysely<unknown>, schema, base, opts);
  }

  async query(caller: QueryCaller, q: QueryArgs): Promise<unknown[]> {
    const role = callerRole(this.schema, caller.callerId);
    let lock = this.locks.get(role);
    if (!lock) { lock = writeLock(); this.locks.set(role, lock); }
    const release = await lock();
    try {
      await this.ensureRole(role);
      await this.writeScope(role, caller.scope);
      return await this.runAs(role, q);
    } finally {
      release();
    }
  }

  async forgetCaller(callerId: string): Promise<void> {
    const role = callerRole(this.schema, callerId);
    await this.pools.get(role)?.end();
    this.pools.delete(role);
    this.ensured.delete(role);
    await this.app.transaction().execute(async (trx) => {
      await sql`DELETE FROM mcp_grants WHERE role_name = ${role}`.execute(trx);
      await sql.raw(`DROP ROLE IF EXISTS ${role}`).execute(trx);
      await sql.raw(`DROP ROLE IF EXISTS ${role}_raw`).execute(trx);
    });
  }

  async end(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end()));
    this.pools.clear();
  }

  /** The role exists, with a password minted for this process and never stored. */
  private ensureRole(role: string): Promise<void> {
    let p = this.ensured.get(role);
    if (!p) {
      p = this.provision(role);
      this.ensured.set(role, p);
      p.catch(() => this.ensured.delete(role));
    }
    return p;
  }

  private async provision(role: string): Promise<void> {
    const r = isolationRoles(this.schema);
    const password = randomBytes(32).toString('base64url');
    await this.app.transaction().execute(async (trx) => {
      const run = (text: string) => sql.raw(text).execute(trx);
      await run(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN NOINHERIT; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}_raw') THEN CREATE ROLE ${role}_raw NOLOGIN; END IF;
      END $$`);
      await run(`ALTER ROLE ${role} LOGIN NOINHERIT CONNECTION LIMIT 4 PASSWORD '${scramVerifier(password)}'`);
      await run(`GRANT ${r.reader} TO ${role} WITH INHERIT TRUE`);
      await run(`GRANT ${r.reader}, ${r.raw} TO ${role}_raw WITH INHERIT TRUE`);
      await run(`GRANT ${role}_raw TO ${role} WITH INHERIT FALSE, SET TRUE`);
    });
    await this.pools.get(role)?.end();
    const pool = new pg.Pool(rolePoolConfig(this.base, role, password));
    pool.on('error', (e) => this.opts.onPoolError?.(e));
    this.pools.set(role, pool);
  }

  /** Rewritten on every call, so a revoked grant stops applying at once. */
  private async writeScope(role: string, scope: ReadonlySet<string>): Promise<void> {
    await this.app.transaction().execute(async (trx) => {
      await sql`DELETE FROM mcp_grants WHERE role_name = ${role}`.execute(trx);
      const ids = [...scope];
      if (ids.length > 0) {
        await sql`INSERT INTO mcp_grants (role_name, workspace_id) VALUES ${sql.join(ids.map((w) => sql`(${role}, ${w})`))}`.execute(trx);
      }
    });
  }

  private async runAs(role: string, q: QueryArgs): Promise<unknown[]> {
    if (!Number.isSafeInteger(q.maxRows) || q.maxRows < 1) throw new Error('maxRows must be a positive integer');
    const pool = this.pools.get(role);
    if (!pool) throw new Error('caller role pool missing');
    const c = await pool.connect();
    let broken: Error | undefined;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        if (q.includeRaw) await c.query(`SET LOCAL ROLE ${role}_raw`);
        await c.query(`SET LOCAL statement_timeout = ${this.opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS}`);
        await c.query(`SET LOCAL search_path = ${this.schema}, public`);
        // Temp views shadow the tables, so `SELECT * FROM events` works without raw_jsonl.
        await c.query(`CREATE TEMP VIEW events AS SELECT ${SNAPSHOT_EVENT_COLS}${q.includeRaw ? ', raw_jsonl' : ''} FROM ${this.schema}.events`);
        for (const t of MCP_QUERY_TABLES) {
          if (t !== 'events') await c.query(`CREATE TEMP VIEW ${t} AS SELECT * FROM ${this.schema}.${t}`);
        }
        await c.query('SET TRANSACTION READ ONLY');
        // A cursor accepts only SELECT/VALUES/WITH (no data-modifying WITH);
        // the extended protocol refuses a second statement.
        const declare: pg.QueryConfig & { queryMode: 'extended' } = {
          text: `DECLARE mcp_q NO SCROLL CURSOR FOR ${q.sql.replace(/[\s;]+$/, '')}`,
          values: q.params,
          queryMode: 'extended',
        };
        await c.query(declare);
        return (await c.query(`FETCH FORWARD ${q.maxRows} FROM mcp_q`)).rows;
      } finally {
        await c.query('ROLLBACK');
      }
    } finally {
      // Session-level effects outlive a rollback (advisory locks, LISTEN).
      try { await c.query('DISCARD ALL'); } catch (e) { broken = e as Error; }
      c.release(broken);
    }
  }
}
```

- [ ] **Step 6: Run the isolation suite**

```bash
npx tsc --noEmit -p tsconfig.node.json
STORE_TEST_DIALECT=postgres npx vitest run src/main/store/pgQueryIsolation.test.ts src/main/store/scram.test.ts
```

Expected: 17 + 2 PASS. On the local socket server, `the caller role cannot log in with a guessed password` accepts `connected`, because that server trusts every local login. CI's TCP service checks SCRAM and must return `28P01`; read the CI log for it.

- [ ] **Step 7: Mutation-check every guard**

Apply each mutation alone to `pgQueryIsolation.ts`, run the Step 6 Postgres line, confirm at least the listed tests fail, then revert (`git -C "$WT" checkout src/main/store/pgQueryIsolation.ts`). These counts were measured while validating this plan.

| # | Mutation | Expected failures (measured) |
|---|---|---|
| M1 | `if (t !== 'sessions')` before `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY` | 6, including *every exposed table* |
| M2 | policy `USING (true)` | 10 |
| M3 | `role_name = current_user` in `mcp_scope()` | 11 (the definer's own name matches nothing) |
| M4 | drop `queryMode: 'extended'` (and the `& { queryMode }` type) | 1: *accepts one SELECT only* |
| M5 | skip `DISCARD ALL` | 1: *session-level effects do not outlive a call* |
| M6 | drop the `DELETE FROM mcp_grants` in `writeScope` | 11 |
| M7 | grant `raw_jsonl` to `${r.reader}` | 1: *raw_jsonl only with include_raw* |
| M8 | add `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${r.reader}` | 2, including *tables outside the exposed set* |

Any mutation that leaves every test green is a missing test. Add one before going on.

- [ ] **Step 8: Gate and commit**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run typecheck:host
CI=true npx vitest run src
CI=true npm run test:unit:pg
git -C "$WT" add src/main/store/scram.ts src/main/store/scram.test.ts src/main/store/pgQueryIsolation.ts src/main/store/pgQueryIsolation.test.ts src/main/store/testStore.ts src/main/store/pgGlobalSetup.ts vitest.pg.config.ts
git -C "$WT" commit -m "feat(store): per-workspace role + RLS isolation for MCP query on Postgres

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire isolation into the MCP server and startup

**Files:**
- Modify: `src/main/store/pgStores.ts` (`poolConfig`), `src/main/store/pgReadSource.ts` (`openPgMcpReadSource`), `src/main/mcpServer.ts` (`pgDescription` for `query`, `handleMcpRequestForTests`, header comment), `src/main/index.ts`, `src/main/store/pgQueryIsolation.test.ts`

**Interfaces:**
- Consumes: `PgQueryIsolation` (Task 3), `pgReadSource` (Task 2), `startMcpServer({ readSource })` (Task 1).
- Produces:
  - `PgStores.poolConfig: PgPoolConfig`.
  - `openPgMcpReadSource(schema, base, log): Promise<ReadSource>`, which never throws for isolation reasons.
  - `handleMcpRequestForTests(method, params?, callerId?)`.

- [ ] **Step 1: Write the end-to-end tests**

Save this block as `/tmp/p4a_t4_tests.ts`:

```ts

describe.skipIf(!isPg)('query through the MCP server on Postgres', () => {
  let dir: string;
  beforeEach(async () => {
    t = await testPgAppSchema();
    await db.openDbPostgres(t.appPool);
    await seed();
    dir = mkdtempSync(join(tmpdir(), 'cf-mcp-pgq-'));
  });
  afterEach(async () => {
    stopMcpServer();
    await db.closeDb();
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('callTool runs query isolated, and tools/list describes Postgres SQL', async () => {
    startMcpServer(dir, { readSource: await openPgMcpReadSource(t.schema, t.appConfig, () => undefined) });
    const r = (await callTool({ name: 'query', arguments: { sql: 'SELECT DISTINCT workspace_id FROM events' } }, A)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual([{ workspace_id: A }]);
    const list = (await handleMcpRequestForTests('tools/list')) as { tools: Array<{ name: string; description: string }> };
    expect(list.tools.find((x) => x.name === 'query')?.description).toMatch(/Postgres/);
  });

  it('a store role without CREATEROLE: query reports why; typed tools still work', async () => {
    await t.pool.query(`ALTER ROLE ${t.appRole} NOCREATEROLE`);
    startMcpServer(dir, { readSource: await openPgMcpReadSource(t.schema, t.appConfig, () => undefined) });
    const r = (await callTool({ name: 'query', arguments: { sql: 'SELECT 1' } }, A)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.content[0].text).toBe('Error: query is unavailable on this Postgres store: the store role needs CREATEROLE (it creates one read-only role per workspace)');
    const s = (await callTool({ name: 'list_sessions', arguments: {} }, A)) as { content: Array<{ text: string }> };
    expect((JSON.parse(s.content[0].text) as Array<{ id: string }>).map((x) => x.id)).toEqual(['sa']);
  });
});
```

Then save as `/tmp/p4a_t4_tests.py` and run `python3 /tmp/p4a_t4_tests.py` from `$WT`. It appends the block and its imports:

```python
"""Part 4a Task 4: the end-to-end MCP tests on Postgres. Run from the worktree root after saving /tmp/p4a_t4_tests.ts."""
p = 'src/main/store/pgQueryIsolation.test.ts'
s = open(p).read()
s = s.replace("import { afterEach, beforeEach, describe, expect, it } from 'vitest';",
              "import { mkdtempSync, rmSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nimport { afterEach, beforeEach, describe, expect, it } from 'vitest';", 1)
s = s.replace("import { MCP_QUERY_TABLES } from './readSource.js';",
              "import { MCP_QUERY_TABLES } from './readSource.js';\nimport { openPgMcpReadSource } from './pgReadSource.js';\nimport { callTool, handleMcpRequestForTests, startMcpServer, stopMcpServer } from '../mcpServer.js';", 1)
s += open('/tmp/p4a_t4_tests.ts').read()
open(p, 'w').write(s)
print('ok')
```

Run `STORE_TEST_DIALECT=postgres npx vitest run src/main/store/pgQueryIsolation.test.ts`. Expected: FAIL (`openPgMcpReadSource` and `handleMcpRequestForTests` don't exist).

- [ ] **Step 2: Apply the wiring**

Save as `/tmp/p4a_t4.py` and run `python3 /tmp/p4a_t4.py` from `$WT`:

```python
"""Part 4a Task 4: wire query isolation. Run from the worktree root."""


def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected one {old[:70]!r}, found {s.count(old)}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


edit('src/main/store/pgStores.ts', [
    ("""export interface PgStores {
  pool: pg.Pool;""", """export interface PgStores {
  pool: pg.Pool;
  /** The options `pool` was built from (the MCP caller roles connect the same way). */
  poolConfig: PgPoolConfig;"""),
    ("""  const pool = createPgPool({ ...pgPoolConfig(cfg, o.env), ...o.pool });""",
     """  const poolConfig: PgPoolConfig = { ...pgPoolConfig(cfg, o.env), ...o.pool };
  const pool = createPgPool(poolConfig);"""),
    ("""    return { pool, inbox, end: () => pool.end() };""", """    return { pool, poolConfig, inbox, end: () => pool.end() };"""),
])

edit('src/main/store/pgReadSource.ts', [
    ("""import type { StateDb } from './stateSchema.js';
""", """import type { StateDb } from './stateSchema.js';
import { PgQueryIsolation } from './pgQueryIsolation.js';
import type { PgPoolConfig } from './postgres.js';
"""),
])
with open('src/main/store/pgReadSource.ts', 'a') as f:
    f.write('''
/** The read source for an open Postgres store. `query` degrades to an error
 *  naming the reason when isolation can't be provisioned; the rest still work. */
export async function openPgMcpReadSource(
  schema: string, base: PgPoolConfig, log: (message: string) => void,
): Promise<ReadSource> {
  try {
    return pgReadSource({ isolation: await PgQueryIsolation.open(stateKysely(), schema, base, { onPoolError: (e) => log(String(e)) }) });
  } catch (e) {
    log(String(e));
    const why = e instanceof Error ? e.message : String(e);
    return pgReadSource({ isolation: null, unavailable: why.startsWith('query is unavailable') ? why : `query is unavailable on this Postgres store: ${why}` });
  }
}
''')

edit('src/main/mcpServer.ts', [
    ("""// subquery/sqlite_master trick can reach another workspace's rows.
""", """// subquery/sqlite_master trick can reach another workspace's rows. On the
// Postgres store `query` runs under the caller's own role with row-level
// security instead (store/pgQueryIsolation.ts).
"""),
    ("""function handleMethod(method: string, params: Record<string, unknown>, callerId: string): unknown {""",
     """/** Test-only: one JSON-RPC method as a caller, without a socket. */
export function handleMcpRequestForTests(method: string, params: Record<string, unknown> = {}, callerId = 'test'): unknown {
  return handleMethod(method, params, callerId);
}

function handleMethod(method: string, params: Record<string, unknown>, callerId: string): unknown {"""),
    ("""      `${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Writes/DDL/multi-statement are rejected.`,
    inputSchema: {""", """      `${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Writes/DDL/multi-statement are rejected.`,
    pgDescription:
      'Run a single read-only Postgres SELECT against your workspace data. Tables: events, sessions, ' +
      'broker_sessions, session_summaries, session_tags, usage_events, perf_events — row-level security limits ' +
      'them to the rows you may read, so SELECT freely (joins, aggregates, GROUP BY, to_timestamp(ts / 1000.0) for UTC). ' +
      'raw_jsonl is excluded unless include_raw=true. ' +
      'Args: sql (required), params (array of values bound to $1, $2, …), include_raw (bool), max_rows (default ' +
      `${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Only SELECT/VALUES/WITH (no data-modifying WITH); one statement; 10 s limit.`,
    inputSchema: {"""),
])

edit('src/main/index.ts', [
    ("""import { pgReadSource } from './store/pgReadSource.js';""", """import { openPgMcpReadSource } from './store/pgReadSource.js';
import { schemaOf } from './store/postgres.js';"""),
    ("""    perfSpan('claude_fleet.boot.mcp_server', () => startMcpServer(app.getPath('userData'), pgStores ? { readSource: pgReadSource({ isolation: null }) } : {}));""",
     """    const pgMcp = pgStores
      ? await openPgMcpReadSource(schemaOf(pgStores.pool), pgStores.poolConfig, (message) =>
          logError({ source: 'main', type: 'mcp-query-isolation', level: 'warn', message }))
      : null;
    perfSpan('claude_fleet.boot.mcp_server', () => startMcpServer(app.getPath('userData'), pgMcp ? { readSource: pgMcp } : {}));"""),
])
print('ok')
```

`openPgMcpReadSource` runs once at startup, after `openPgStores`. A failure is logged as `mcp-query-isolation`; `query` then answers with the reason, and the other tools keep working.

- [ ] **Step 3: Run everything**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run typecheck:host
STORE_TEST_DIALECT=postgres npx vitest run src/main/store/pgQueryIsolation.test.ts src/main/store/pgStores.test.ts
CI=true npx vitest run src
CI=true npm run test:unit:pg
```

Expected: the isolation file is 19/19, `pgStores.test.ts` passes unchanged, and both suites are green.

- [ ] **Step 4: Commit**

```bash
git -C "$WT" add src/main/store/pgStores.ts src/main/store/pgReadSource.ts src/main/mcpServer.ts src/main/index.ts src/main/store/pgQueryIsolation.test.ts
git -C "$WT" commit -m "feat(mcp): query on the Postgres store runs under the caller's role with RLS

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: SPEC.md, the outlines, and the PR

**Files:**
- Modify: `docs/SPEC.md` (§7 *Postgres store* search bullet, §8 *Startup* step 5, §9 a new isolation bullet, §11 *Remote host automations*, the MCP *History reads* bullet and the `query` tool bullet), the part 3 plan's Part 4 outline, the c3 plan's c3b gate

- [ ] **Step 1: Apply the SPEC and outline edits**

Save as `/tmp/p4a_spec.py` and run `python3 /tmp/p4a_spec.py` from `$WT`:

```python
"""Part 4a Task 5: SPEC.md and the plan outlines. Run from the worktree root."""


def edit(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected one {old[:70]!r}, found {s.count(old)}'
        s = s.replace(old, new)
    open(path, 'w').write(s)


edit('docs/SPEC.md', [
    # §7 Postgres store › Search: the HNSW decision (D44).
    ("""so approximate search waits until this ceiling is reached.""",
     """so search is exact. Approximate search is deferred to remote-workspaces (d), where published partitions grow a host's corpus: it is revisited when p50 exceeds 250 ms on a real store or one caller's scope exceeds 250k rows, with a recall test at 20k/100k/250k before it ships."""),
    # §8 Startup.
    ("""and starts the MCP server without the read-only `state.db` connection (§11).""",
     """and starts the MCP server on the Postgres read source (§11 *History reads*), provisioning `query` isolation first (§9)."""),
    # §9: the isolation model (D42), before the GitHub token bullet.
    ("""- **The GitHub sign-in token stays in main (remote-workspaces (b)).**""",
     """- **MCP `query` on Postgres is isolated by role and row-level security** (`store/pgQueryIsolation.ts`).
  - **Roles:** each caller workspace reads as its own LOGIN role `<schema>_mcp_<sha256(id)[:16]>`, a member of `<schema>_mcp_reader`: schema `USAGE`, `EXECUTE` on `mcp_scope()`, `SELECT` on the seven `query` tables, and on `events` only the snapshot columns (no `raw_jsonl`, no `dedup_key`). Its NOLOGIN `_raw` sibling adds `raw_jsonl` (`<schema>_mcp_raw`) and is reached only by `SET LOCAL ROLE` when `include_raw`. A process mints each role's password at first use and sets it as a SCRAM-SHA-256 verifier; nothing stores it.
  - **Rows:** RLS on the seven tables admits `workspace_id IN mcp_scope()` (`perf_events` also NULL). `mcp_scope()` is `SECURITY DEFINER` (`search_path = pg_catalog`) and returns the `mcp_grants` rows for `session_user`. The caller's SQL can reach only its own roles with `SET ROLE` or `set_config('role')`, and can't change `session_user`. `mcp_grants` is rewritten from the caller's allowed set before every call, under a per-caller lock, so a revocation applies to the next call. The store role owns the tables without `FORCE`, so its own queries bypass RLS.
  - **Statement:** one `DECLARE … CURSOR FOR <sql>` (SELECT, VALUES or WITH; no data-modifying WITH) over the extended protocol, which refuses a second statement. It runs in a REPEATABLE READ transaction set READ ONLY after seven temp views shadow the tables (so `SELECT * FROM events` has no `raw_jsonl`), with `statement_timeout` 10 s; `FETCH` returns at most `max_rows`. Every call ends with `ROLLBACK` and `DISCARD ALL`: advisory locks and `LISTEN` survive a rollback.
  - **Visible by design:** catalog names and `pg_stat_*` table counters (counts, not rows). `pg_stats` hides RLS tables' column values.
  - **Needs** Postgres 16 or later and a store role with `CREATEROLE` (on PG 16 it administers only roles it created). Without them `query` reports why and every other tool works. `removeWorkspaceSocket` drops a removed workspace's roles and grants.
- **The GitHub sign-in token stays in main (remote-workspaces (b)).**"""),
    # §11 Remote host automations.
    ("""gated on part 4's `ReadSource`: fresh automation sessions report through the MCP inbox tools, and `mcpServer.ts` still reaches Electron and, on Postgres, has its history tools off until part 4.""",
     """because fresh automation sessions report through the MCP inbox tools and `mcpServer.ts` still reaches Electron. Its history tools read through a `ReadSource` (§11 *History reads*), which c3b serves from the host's Postgres store."""),
    # §11 MCP: the read seam replaces the "Not on the async store layer" bullet.
    ("""- **Not on the async store layer, by design**: the server keeps its own `{ readonly: true }` better-sqlite3 connection and the per-call in-memory `query` snapshot (ATTACH + copy). Both are SQLite-only, and the snapshot is the isolation mechanism. The connection is separate from the app's write connection and sees only committed WAL frames, so a snapshot never observes half an ingest chunk. Postgres gets its own isolation path (role + RLS) instead of a ported snapshot. On the Postgres store the server starts without this connection (`startMcpServer(dir, { stateDb: false })`): the tools that read it (`list_sessions`, `get_session`, `get_cost`, `list_events`, `search_transcripts`, `session_summary`, `list_errors`, `query`, `mark_useful`) return `<tool> is unavailable on the Postgres store` as a tool error, and every other tool works. `search_transcripts` also reads this connection: `searchTranscripts(…, db)` takes the handle explicitly, with no app-connection default.""",
     """- **History reads go through a `ReadSource`** (`store/readSource.ts`). It is data access only: argument validation, scope narrowing, ISO siblings, cost derivation, the result cap and usage telemetry stay in the tools, so both dialects answer alike (`mcpReadSource.test.ts` runs one fixture through both).
  - **SQLite** (`sqliteReadSource.ts`): the server's own `{ readonly: true }` better-sqlite3 connection and the per-call in-memory `query` snapshot (ATTACH + copy), which is the isolation mechanism there. The connection is separate from the app's write connection and sees only committed WAL frames, so a snapshot never observes half an ingest chunk. `search_transcripts` scans this connection (`searchVectorsSqlite`).
  - **Postgres** (`store/pgReadSource.ts`): the typed tools' SQL on the store pool, one read-only transaction per call, filtered by the caller's scope as on SQLite; `list_sessions` orders `last_active_at DESC NULLS LAST, id` and token groups sort NULLs first, matching SQLite. `search_transcripts` calls `searchEmbeddings`. `query` runs under the caller's own role with row-level security (§9).
  - **No store yet** (`startMcpServer(dir, { readSource: null })`, until `setReadSource`): `list_sessions`, `get_session`, `get_cost`, `list_events`, `search_transcripts`, `session_summary`, `list_errors`, `query` and `mark_useful` return `<tool> is unavailable while the history store is not open` as a tool error; every other tool works."""),
    # §11 query tool bullet: the Postgres variant.
    ("""on pre-v11 DBs with no `perf_events` table the snapshot creates an empty, correctly-shaped shell so queries don't error.""",
     """on pre-v11 DBs with no `perf_events` table the snapshot creates an empty, correctly-shaped shell so queries don't error. On the Postgres store the same seven tables are row-level-secured views of the store's own tables (§9): the SQL is Postgres's, `params` bind to `$1, $2, …`, only SELECT/VALUES/WITH run, the statement limit is 10 s, and the tool's description says so."""),
])

edit('docs/superpowers/plans/2026-11-04-async-store-part3.md', [
    ("""## Part 4 outline (written in full when part 3 has merged)
""", """## Part 4 outline (written in full when part 3 has merged)

Written in full as `2026-11-05-async-store-part4a.md` (MCP on Postgres) and `2026-11-05-async-store-part4b.md` (the managed container, Settings → *Storage*, the first-switch copy, the degraded state).
"""),
])

edit('docs/superpowers/plans/2026-11-04-remote-c-3-host-store.md', [
    ("""**Gate:** c3 merged; async-store part 4's typed tools on a `ReadSource` (D34's history tools on Postgres).""",
     """**Gate:** c3 merged; async-store part 4a's `ReadSource` (`2026-11-05-async-store-part4a.md`): the host serves `pgReadSource({ isolation: null })`, so `query` reports unavailable until (d) provisions isolation there."""),
])
print('ok')
```

- [ ] **Step 2: Check SQLite's surface is unchanged**

```bash
git -C "$WT" diff origin/main -- src/main/__snapshots__/ | head        # expect no output
git -C "$WT" diff origin/main --stat -- tests/                           # expect no output: e2e untouched
```

Then run each e2e MCP spec locally if a display exists (`npx playwright test tests/mcp-server.spec.ts tests/mcp-scoped-reads.spec.ts tests/inbox-mcp.spec.ts`). Otherwise leave them to CI and say so in the PR.

- [ ] **Step 3: Commit, push, open the PR, enable auto-merge**

```bash
git -C "$WT" add docs/SPEC.md docs/superpowers/plans/2026-11-04-async-store-part3.md docs/superpowers/plans/2026-11-04-remote-c-3-host-store.md
git -C "$WT" commit -m "docs(spec): MCP on the Postgres store (ReadSource, role + RLS query isolation, HNSW deferred)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$WT" push -u origin feat/async-store-p4a
gh pr create -R ImIOImI/claude-fleet --head feat/async-store-p4a --title "feat(store): async store part 4a: the fleet-state MCP server on Postgres" --body-file /tmp/p4a_pr.md
gh pr merge -R ImIOImI/claude-fleet --auto --squash feat/async-store-p4a
```

Write the body in `/tmp/p4a_pr.md` before running this, factual only:
- **What changed:** the `ReadSource` seam; the Postgres typed tools and search, which close #491; `query` isolation by role + RLS (D42).
- **Blast radius:** SQLite users see no change, apart from the no-store message text. The Postgres store is still hand-configured.
- **How it was tested:** both unit suites, the mutation table, and CI's TCP SCRAM check.
- **Footer:** end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review notes

- **Coverage of the part 4 outline's MCP item and the request:**
  - *Typed read tools on a `ReadSource`:* Tasks 1–2 (D40, D41).
  - *`query`/`search_transcripts` on Postgres:* `search_transcripts` is Task 2 (D43); `query` is Tasks 3–4 (D42).
  - *Per-workspace isolation via role + RLS, replacing the ATTACH snapshot on Postgres:* Task 3 (D42). SQLite keeps the snapshot.
  - *`searchEmbeddings` gets its app caller; #491 closes:* Task 2.
  - *HNSW decision:* D44, recorded in SPEC by Task 5.
  - *RLS tests through `query`, typed tools, search, views and functions, mutation-checked:*
    - `query`: Task 3 Steps 3 and 7, including `query_to_xml`, `pg_stats`, `mcp_scope()`, `set_config`, the temp views and qualified base tables.
    - Typed tools and search: Task 2 Steps 1 and 5.
- **SQLite unchanged:** the SQL is moved verbatim (Tasks 1 and 3). `mcpServer.test.ts` keeps all 60 tests, and the e2e MCP specs and characterization snapshots are untouched (Task 5 Step 2).
- **Names used across tasks:**
  - `ReadSource`, `QueryRunner`, `sqliteReadSource(db)` and `pgReadSource({ isolation, unavailable?, k? })`.
  - `PgQueryIsolation.open(app, schema, base, opts?)`, `openPgMcpReadSource(schema, base, log)` and `PgStores.poolConfig`.
  - `startMcpServer(dir, { readSource })`, `setReadSource(rs)` and `testPgAppSchema()`.
- **Deliberately not here (4b):** the managed container, Settings → *Storage*, the first-switch copy, the degraded banner and the Postgres perf bench.
