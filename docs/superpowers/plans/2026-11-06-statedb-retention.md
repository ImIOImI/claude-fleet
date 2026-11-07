# state.db retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound `state.db` growth: strip/compress old event payloads, slim embeddings, purge deleted workspaces, vacuum, and rotate `error.log` (spec `docs/superpowers/specs/2026-11-06-statedb-retention-design.md`, issue #526).

**Architecture:** A pure line codec (`state/rawCodec.ts`) does strip, compress and read. A throttled retention pass (`state/retention.ts`) runs on the async store handle in bounded slices, tracking per-session watermarks in a new `event_retention` table. The one-time SQLite VACUUM runs in a detached helper after quit (`state/vacuumHelper.ts`).

**Tech Stack:** TypeScript, Kysely (SQLite via better-sqlite3, Postgres via pg + pgvector), `node:zlib`, vitest.

## Global Constraints

- Every state.db change works on SQLite and Postgres; Postgres paths are covered by the CI Postgres unit job (`STORE_TEST_DIALECT=postgres`); no local Postgres here.
- Never block the main thread: slices ≤ 200 rows or 2 MB raw bytes, one transaction per slice, sleep `max(250, 9·t)` ms after a slice of `t` ms.
- Event rows are never deleted by retention; `id`, `dedup_key` and every extract column stay unchanged.
- Strip window: 30 days; 90 days when the session has a `usage_events` row with `kind = 'resumed'`. Compress window: 30 days, SQLite only, lines ≥ 512 bytes, zlib level 6.
- Stub head: 500 chars. Oversized tool input: `JSON.stringify(input).length > 2048`. Kept input keys (capped at 4,096 chars): `file_path`, `path`, `notebook_path`, `command`, `pattern`, `url`, `description`, `skill`, `subagent_type`. Other strings over 200 chars become their first 200 chars + `…`.
- int8 vector format: `[float32 scale LE][dim × int8]`, `scale = max|v| / 127`. Placeholder: empty BLOB (SQLite) / `NULL` (Postgres).
- error.log rotates at 5 MB to `error.log.1`.
- Update `docs/SPEC.md` in the same commit as each data-model change.
- Code comments: terse, only non-obvious why; no ticket narrative.
- Tests: `npx vitest run <files>` in the worktree; typecheck with `npm run typecheck:node` and `npm run typecheck:web` separately.

## File map

| File | Change |
|---|---|
| `src/main/state/rawCodec.ts` (+test) | new: pure line codec |
| `src/main/db.ts` | v16 migration, readers via `rawLine`, `deleteSession`, `purgeWorkspace`, retention queries, `maintenanceGet/Set`, `withRawSqlite` |
| `src/main/store/stateSchema.ts`, `store/migrations/statePg.ts` | v16 types and Postgres step 16 |
| `src/main/state/retention.ts` (+test) | new: pass, throttle, steps |
| `src/main/vectors.ts` (+test) | int8 encode, length-dispatch decode, `EMPTY_VECTOR` |
| `src/main/transcriptIndex.ts` | placeholders without vectors; int8 storage |
| `src/main/state/vacuumHelper.ts` (+test) | new: quit-time spawn, lock, startup wait |
| `src/main/queryWorker.ts` (+test) | `fleet_raw` + `events` view with `include_raw` |
| `src/main/store/storeImport.ts` (+test) | `raw_z` inflate, empty vector → NULL, new tables |
| `src/main/errorLog.ts` (+test) | rotation |
| `src/main/ipc.ts`, `src/main/index.ts` | wiring |
| `scripts/measure-statedb.mjs` | new: read-only report on a copy |
| `docs/SPEC.md` | §7 schema + retention, §6 error log, §11 MCP query |

---

### Task 1: Line codec

**Files:**
- Create: `src/main/state/rawCodec.ts`
- Test: `src/main/state/rawCodec.test.ts`

**Interfaces:**
- Produces:
  - `rawLine(row: { raw_jsonl: string; raw_z: Buffer | Uint8Array | null }): string`
  - `deflateLine(line: string): Buffer`
  - `COMPRESS_MIN_BYTES = 512`
  - `stripLine(line: string, nowMs: number): string | null`: returns the stub, or null when the line is not strippable or is already stripped.
  - `STUB_HEAD_CHARS = 500`, `TOOL_INPUT_MAX = 2048`

- [ ] **Step 1: Failing tests.** Cover each case:
  - A `tool_result` user line (string content, and array content with text blocks, plus a top-level `toolUseResult`) → the stub parses; `toolUseResult` is gone; the block keeps `tool_use_id`/`is_error`; `content` is the first 500 chars; `fleetStripped.bytes` is the original UTF-8 length; `uuid`/`timestamp` are kept.
  - An assistant line whose `tool_use` input is a 5 KB `content` → `file_path` is kept and `content` is truncated to 200 chars + `…`. A small input → `null`.
  - A line that is already stripped → `null`.
  - A non-JSON line → `null`.
  - `rawLine` round-trips `deflateLine`, and returns `raw_jsonl` when `raw_z` is null.
- [ ] **Step 2:** `npx vitest run src/main/state/rawCodec.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.**

```ts
import { deflateSync, inflateSync } from 'node:zlib';
export const COMPRESS_MIN_BYTES = 512;
export const STUB_HEAD_CHARS = 500;
export const TOOL_INPUT_MAX = 2048;
const KEEP_INPUT = new Set(['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'description', 'skill', 'subagent_type']);
const KEEP_MAX = 4096;
const OTHER_MAX = 200;

export function rawLine(r: { raw_jsonl: string; raw_z: Buffer | Uint8Array | null }): string {
  return r.raw_z && r.raw_z.length > 0 ? inflateSync(r.raw_z).toString('utf8') : r.raw_jsonl;
}
export function deflateLine(line: string): Buffer { return deflateSync(Buffer.from(line, 'utf8'), { level: 6 }); }

export function stripLine(line: string, nowMs: number): string | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object' || o.fleetStripped) return null;
  const msg = o.message as { content?: unknown } | undefined;
  const content = Array.isArray(msg?.content) ? (msg!.content as Array<Record<string, unknown>>) : null;
  if (!content) return null;
  const marker = { bytes: Buffer.byteLength(line, 'utf8'), at: nowMs };
  if (o.type === 'user' && content.some((b) => b?.type === 'tool_result')) {
    const blocks = content.map((b) => b?.type !== 'tool_result' ? b : {
      type: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error ?? false,
      content: (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')).slice(0, STUB_HEAD_CHARS),
    });
    const { toolUseResult: _drop, ...rest } = o;
    return JSON.stringify({ ...rest, message: { ...msg, content: blocks }, fleetStripped: marker });
  }
  if (o.type === 'assistant') {
    let changed = false;
    const blocks = content.map((b) => {
      if (b?.type !== 'tool_use' || !b.input || typeof b.input !== 'object') return b;
      if (JSON.stringify(b.input).length <= TOOL_INPUT_MAX) return b;
      changed = true;
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.input as Record<string, unknown>)) {
        const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
        if (KEEP_INPUT.has(k)) input[k] = s.length > KEEP_MAX ? s.slice(0, KEEP_MAX) : v;
        else input[k] = s.length > OTHER_MAX ? `${s.slice(0, OTHER_MAX)}…` : v;
      }
      return { ...b, input };
    });
    return changed ? JSON.stringify({ ...o, message: { ...msg, content: blocks }, fleetStripped: marker }) : null;
  }
  return null;
}
```

- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(state): raw line codec for retention (#526)`.

### Task 2: Schema v16 + readers + deleteSession

**Files:**
- Modify: `src/main/db.ts` (migrate v16; `eventsForSession`/`rowFromSql`, `unembeddedTurnEvents`, `repairSyntheticFirstUserMessages` read via `rawLine`; `deleteSession` also deletes `event_retention` + `embeddings` for the session)
- Modify: `src/main/store/stateSchema.ts`, `src/main/store/migrations/statePg.ts`
- Modify: `docs/SPEC.md` §7 schema block (v16)
- Test: `src/main/dbRetentionSchema.test.ts` (new)

**Interfaces:**
- Produces:
  - `events.raw_z` (Buffer | null)
  - `event_retention { session_id, workspace_id, compressed_before, stripped_before }`
  - `maintenance { key, value }`
  - `maintenanceGet(key: string): Promise<string | null>`
  - `maintenanceSet(key: string, value: string): Promise<void>`
  - `stateDialect(): 'sqlite' | 'postgres'`

SQLite v16:

```sql
ALTER TABLE events ADD COLUMN raw_z BLOB;            -- guarded: only if absent (rewind replays)
CREATE TABLE IF NOT EXISTS event_retention (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  compressed_before INTEGER NOT NULL DEFAULT 0, stripped_before INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_event_retention_workspace ON event_retention(workspace_id);
CREATE TABLE IF NOT EXISTS maintenance (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Postgres step 16: the same with `BYTEA`, `BIGINT` and `TEXT COLLATE "C"`, plus `ALTER TABLE embeddings ALTER COLUMN vec DROP NOT NULL;`.

- [ ] **Step 1: Failing tests (both dialects via `openTestState`):**
  - `raw_z` exists;
  - a row updated to `raw_jsonl = ''` with `raw_z = deflateLine(line)` comes back from `eventsForSession` with `rawJsonl === line`, and `unembeddedTurnEvents` returns the inflated line;
  - `deleteSession` removes the `event_retention` and `embeddings` rows;
  - `maintenanceSet`/`maintenanceGet` round-trip and overwrite.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
  - `selectAll()` in `eventsForSession` already returns `raw_z`: `rowFromSql` sets `rawJsonl: rawLine(r)`.
  - `unembeddedTurnEvents` selects `e.raw_z as rawZ` and maps through `rawLine`.
  - `maintenanceSet` upserts with `onConflict(oc => oc.column('key').doUpdateSet({ value }))`.
  - Add the SPEC v16 block.
- [ ] **Step 4:** PASS, plus `src/main/db.test.ts src/main/dbEmbeddings.test.ts src/main/dbReadCharacterization.test.ts` still pass.
- [ ] **Step 5:** Commit `feat(state): schema v16 for retention (raw_z, event_retention, maintenance) (#526)`.

### Task 3: Retention events step

**Files:**
- Create: `src/main/state/retention.ts`
- Modify: `src/main/db.ts` (query helpers below)
- Test: `src/main/state/retention.test.ts`

**Interfaces:**
- Consumes: Task 1 codec, Task 2 schema/helpers.
- Produces (db.ts):
  - `retentionCandidates(beforeTs: number): Promise<Array<{ sessionId: string; workspaceId: string; resumed: boolean; compressedBefore: number; strippedBefore: number }>>`
  - `retentionRows(sessionId: string, fromTs: number, toTs: number, after: { ts: number; id: number } | null, limit: number, toolOnly: boolean): Promise<Array<{ id: number; ts: number; raw_jsonl: string; raw_z: Buffer | null }>>`
  - `rewriteEventRaw(updates: Array<{ id: number; raw_jsonl: string; raw_z: Buffer | null }>): Promise<void>` (one transaction)
  - `setRetentionWatermarks(sessionId: string, workspaceId: string, compressedBefore: number, strippedBefore: number): Promise<void>`
- Produces (retention.ts):
  - `DAY_MS`
  - `interface Throttle { slice<T>(fn: () => Promise<T>): Promise<T>; stopped(): boolean }`
  - `retainEvents(now: number, t: Throttle): Promise<{ rows: number; bytesBefore: number; bytesAfter: number }>`

Per-row transform:
1. `line = rawLine(row)`
2. `out = ts < sCut ? stripLine(line, now) ?? line : line`
3. if SQLite and `ts < cCut` and `Buffer.byteLength(out) >= COMPRESS_MIN_BYTES` and the row isn't compressed yet → `{ raw_jsonl: '', raw_z: deflateLine(out) }`
4. write only if something changed.

Range 1 is `[compressedBefore, cCut)` for all rows. Range 2 is `[strippedBefore, min(sCut, compressedBefore))` with `tool_use_id IS NOT NULL`. Watermarks advance after the session.

- [ ] **Step 1: Failing tests (both dialects):**
  - Ingest a session with lines aged 40 days (a tool_result, an oversized tool_use, a text assistant, a small system line) and one aged 5 days, then run `retainEvents(now, immediateThrottle)`:
    - the old tool_result is a stub;
    - the tool_use input is stripped;
    - on SQLite, the old big rows have `raw_z` set and `raw_jsonl = ''`; on Postgres, `raw_z` is null;
    - the 5-day row is untouched;
    - `summaryForSession` totals, `topTools`/`recentToolCallsForSession` and `session_costs` are equal before and after.
  - Re-`ingestLine` the original tool_result line → `inserted: false`, and the row stays a stub.
  - A `resumed` session: the 40-day tool_result is compressed but not stripped; at `now + 60 d` it is stripped.
  - A second run with the same `now` writes nothing (watermarks).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement the helpers and `retainEvents`. Keyset `(ts, id)`: `where ts > a.ts or (ts = a.ts and id > a.id)`, `orderBy ts, id`. Slices are bounded by 200 rows and 2 MB of `raw_jsonl` length (stop adding rows to the update batch once the byte budget is hit; the next slice resumes at the last processed key).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(state): strip and compress old events in bounded slices (#526)`.

### Task 4: Embeddings — no placeholder vectors, int8

**Files:**
- Modify: `src/main/vectors.ts`, `src/main/transcriptIndex.ts`, `src/main/db.ts` (`insertEmbeddings` for empty vec, SQLite search skip, compaction helpers), `src/main/state/retention.ts` (`compactEmbeddings`), `src/main/store/pgVectorSearch.ts` (`vec IS NOT NULL`)
- Test: `src/main/vectors.test.ts`, `src/main/embeddingsQuantize.test.ts` (new), `src/main/dbEmbeddings.test.ts`, `src/main/state/retention.test.ts`

**Interfaces:**
- Produces:
  - `encodeVectorInt8(v: Float32Array): Buffer`
  - `decodeVector(buf: Buffer): Float32Array` (dispatches on length: `4·n` float32 with n = len/4 if len % 4 == 0 and len ≠ dim + 4; `EMBED_DIM + 4` int8; `0` → empty array)
  - `encodeStoredVector = encodeVectorInt8` (or `encodeVector` if the recall gate failed)
  - `EMPTY_VECTOR = Buffer.alloc(0)`
  - db: `embeddingsToCompact(afterId: number, maxId: number, limit: number): Promise<Array<{ id: number; text: string; vec: Buffer }>>` (SQLite)
  - db: `rewriteEmbeddingVecs(rows: Array<{ id: number; vec: Buffer | null }>): Promise<void>`
  - db: `maxEmbeddingId()`
  - db: `clearPlaceholderVectorsPg(afterId, limit)` (Postgres: `UPDATE … SET vec = NULL WHERE text = '' AND vec IS NOT NULL AND id IN (…)`)
  - retention: `compactEmbeddings(t: Throttle): Promise<number>`

`EMBED_DIM + 4 = 388` is not a multiple of 4·384, so the dispatch is unambiguous. The decode for int8 is `out[i] = buf.readInt8(4 + i) * scale`.

- [ ] **Step 1: Failing tests:**
  - int8 round-trip error ≤ scale/2 per component;
  - `decodeVector(EMPTY_VECTOR).length === 0`;
  - placeholder inserts store an empty vec (SQLite) / NULL (Postgres);
  - search ignores placeholders and ranks int8 rows like float32 on a fixed 50-vector fixture (same top-3);
  - `compactEmbeddings` turns f32 placeholders into empty and f32 real rows into 388-byte rows (SQLite), and nulls placeholders (Postgres);
  - the cursor in `maintenance['embeddings.compacted_through_id']` advances.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
  - `insertEmbeddings`: on Postgres, a `row.vec.length === 0` → `null`; otherwise as today.
  - `transcriptIndex.ts` placeholder: `vec: EMPTY_VECTOR`; real rows: `encodeStoredVector(vecs[i])`, summaries too.
  - `searchEmbeddings` (SQLite) and `searchVectorsSqlite`: keep the `text <> ''` filter.
  - Postgres search: add `vec IS NOT NULL`.
  - `embeddingsQuantize.test.ts`: fixture-based recall, plus a model-backed variant gated on `CF_HF_CACHE` existing.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(embeddings): no vectors for placeholder turns; int8 storage on SQLite (#526)` with the SPEC §7 embeddings text updated.

### Task 5: Purge deleted workspaces

**Files:**
- Modify: `src/main/db.ts` (`purgeWorkspace`, `workspaceIdsInState`), `src/main/state/retention.ts` (`sweepOrphans`), `src/main/ipc.ts` (`workspace:remove`)
- Test: `src/main/dbPurgeWorkspace.test.ts` (new), `src/main/state/retention.test.ts`

**Interfaces:**
- Produces:
  - `purgeWorkspace(id: string, t?: Throttle): Promise<number>` (rows deleted)
  - `workspaceIdsInState(): Promise<string[]>`
  - `sweepOrphans(deps: { listManifestIds(): Promise<string[]>; stateDirExists(id: string): boolean }, t: Throttle): Promise<string[]>`

`purgeWorkspace` deletes in chunks of 2,000 ids per table:
- the session-keyed rollups (`session_costs`, `session_stats`, `session_tool_counts`) by the workspace's session ids, before `sessions`;
- `events`, `embeddings`, `session_summaries`, `session_tags`, `usage_events`, `broker_sessions`, `port_exposures`, `event_retention`, `sessions` by `workspace_id`.

It clears the caches like `deleteSession`. `sweepOrphans` purges an id only when it has the ULID shape (`/^[0-9A-HJKMNP-TV-Z]{26}$/`), is not in the manifest list, its state dir is absent, and the manifest list is non-empty.

- [ ] **Step 1: Failing tests:**
  - two workspaces ingested, purge one → zero rows left for it in every table, the other untouched;
  - the sweep skips an id with a state dir, a non-ULID id, and everything when the manifest list is empty;
  - the sweep purges a true orphan.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement. In `ipc.ts` `workspace:remove`, after `backend.removeWorkspace` succeeds: `if (opts?.deleteState && opts.id && !MOCK_MODE) void purgeWorkspace(opts.id).catch((e) => logError({ source: 'main', level: 'warn', type: 'workspace-purge', workspaceId: opts.id, message: String(e) }))`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(state): purge a deleted workspace's history; guarded orphan sweep (#526)` plus SPEC (§7 deleteSession paragraph, §8 workspace removal).

### Task 6: Scheduler, throttle, incremental vacuum, wiring

**Files:**
- Modify: `src/main/state/retention.ts` (`startRetention`, `createThrottle`, `incrementalVacuum`), `src/main/db.ts` (`withRawSqlite`), `src/main/index.ts`
- Test: `src/main/state/retention.test.ts`

**Interfaces:**
- Produces:
  - `withRawSqlite<T>(fn: (d: Database.Database) => T): Promise<T | null>`: runs under `kdb.connection().execute`; null on Postgres.
  - `createThrottle(opts?: { minSleepMs?: number; duty?: number; sleep?: (ms: number) => Promise<void> }): Throttle & { stop(): void }`
  - `incrementalVacuum(t: Throttle): Promise<number>` (pages freed; 0 on Postgres)
  - `startRetention(deps: RetentionDeps): { stop(): Promise<void> }`, where `RetentionDeps = { listManifestIds; stateDirExists; firstDelayMs?: number; intervalMs?: number; vacuumEveryMs?: number; now?: () => number }`

Pass order: `sweepOrphans` → `retainEvents` → `compactEmbeddings` → `incrementalVacuum`. Then `maintenanceSet('retention.last_pass_at')`, and `first_pass_at` if unset. Each step's error is logged as `retention-step` (warn) and doesn't stop the next step. A pass is logged as an info row `retention-pass` with counts and bytes.

`incrementalVacuum` (SQLite): `freelist_count > 4096` → loop up to 64 × `t.slice(() => withRawSqlite((d) => d.pragma('incremental_vacuum(1024)')))`. It must use `d.pragma`; `run()` frees only one page.

- [ ] **Step 1: Failing tests:**
  - the throttle sleeps `max(250, 9·t)` (injected clock/sleep);
  - `stop()` ends a pass between slices;
  - `incrementalVacuum` on an `auto_vacuum = INCREMENTAL` temp DB with a 20 MB freelist frees pages to under the threshold;
  - `startRetention` runs a pass after `firstDelayMs` and writes `retention.first_pass_at` (fake timers).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement and wire `index.ts`:
  - **SQLite path:** after `openDb` + `startStateWrites` → `retention = startRetention(deps)`.
  - **Postgres:** a service step `{ name: 'retention', group: 'history', after: ['watcher'], run: () => { retention ??= startRetention(deps) } }`.
  - **Quit:** `await retention?.stop()` before `closeDb()`.
  - **deps:** `listManifestIds` = ids from `listWorkspaceManifests()` (all kinds); `stateDirExists` = `existsSync(workspaceStateDir(id))`. Not in mock mode.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(state): throttled retention scheduler and incremental vacuum (#526)` plus a SPEC §7 *Retention* subsection.

### Task 7: One-time VACUUM helper

**Files:**
- Create: `src/main/state/vacuumHelper.ts`
- Modify: `src/main/index.ts` (startup wait before `openDb`; spawn after the bounded shutdown, before `app.exit`), `src/main/queryWorker.ts` (export `betterSqlitePath`)
- Test: `src/main/state/vacuumHelper.test.ts`

**Interfaces:**
- Produces:
  - `needsConversion(userData: string): { ok: boolean; reason?: string }`: reads `PRAGMA auto_vacuum` and `maintenance` with a short-lived read-only connection
  - `spawnVacuumHelper(userData: string, opts?: { execPath?: string; env?: NodeJS.ProcessEnv }): number | null` (pid)
  - `waitForVacuumHelper(userData: string, opts?: { capMs?: number; pollMs?: number; kill?: (pid: number) => void }): Promise<'none' | 'done' | 'killed' | 'stale'>`
  - `VACUUM_SCRIPT` (self-contained JS for `-e`)

`needsConversion` is true when:
- `auto_vacuum != 2`;
- `maintenance['retention.first_pass_at']` is set;
- `maintenance['vacuum.last_attempt_at']` is missing or older than 24 h;
- free disk ≥ 1.2 × (db + wal size) via `fs.statfsSync`.

The quit spawn writes `vacuum.last_attempt_at` first, because the DB is closed after `closeDb`. So `needsConversion` runs before `closeDb`, and the attempt mark is written then.

Helper script (`ELECTRON_RUN_AS_NODE=1`, `-e`, args `[bs3Path, dbPath, lockPath]`): open the DB, `busy_timeout = 30000`, `PRAGMA auto_vacuum = INCREMENTAL`, `VACUUM`, `PRAGMA wal_checkpoint(TRUNCATE)`, close, unlink the lock. On error, append a JSON line to `error.log` (type `vacuum-failed`) and unlink the lock. The parent writes the lock `{ pid, startedAt }` right after the spawn; `detached: true, stdio: 'ignore', windowsHide: true`, then `unref()`.

`waitForVacuumHelper`:
- no lock → `none`;
- lock pid dead → unlink, `stale`;
- alive → poll until the lock is gone (`done`) or `capMs` (120 s); then, if the lock's `startedAt` is < 15 min old, kill the pid → `killed`; else unlink → `stale`.

- [ ] **Step 1: Failing tests:**
  - with a temp DB (`auto_vacuum = 0`, a 5 MB table deleted), `spawnVacuumHelper` with `execPath: process.execPath` converts the DB (`auto_vacuum = 2`), shrinks the file and removes the lock;
  - `waitForVacuumHelper` returns `none`, `stale` (dead pid) and `killed` (a sleeping child process standing in for the helper);
  - `needsConversion` is false without `first_pass_at`, and false on low disk (injected `statfs`).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement and wire:
  - **Startup** (SQLite only): `await waitForVacuumHelper(userData)` before `openDb(userData)`; log `vacuum-wait` with the outcome when it isn't `none`.
  - **Quit:** before `closeDb()` (SQLite only), `const conv = await vacuumDecision()`; after the bounded shutdown resolves and before `app.exit(0)`, `if (conv) spawnVacuumHelper(userData)`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(state): one-time VACUUM to incremental auto_vacuum in a detached helper after quit (#526)` plus a SPEC §7 *Vacuum* paragraph and §8 Startup/Quit.

### Task 8: MCP query `fleet_raw` + store import

**Files:**
- Modify: `src/main/queryWorker.ts`, `src/main/store/storeImport.ts`, `docs/SPEC.md` §11 (query tool), §7 (first-switch copy)
- Test: `src/main/queryWorker.test.ts`, `src/main/store/storeImport.test.ts`

In `runSnapshotQuery`, inside the self-contained function, require zlib with `require('node:zlib')` passed in as a parameter: the function may only use its parameters. So the signature becomes `runSnapshotQuery(DatabaseCtor, job, zlib)`, and `WORKER_SRC` passes `require('node:zlib')`.

- Register `mem.function('fleet_raw', { deterministic: true }, (raw, z) => z ? zlib.inflateSync(z).toString('utf8') : raw)`.
- With `includeRaw`: `CREATE TABLE events_store AS SELECT <cols>, raw_jsonl, raw_z FROM src.events …`; then `CREATE VIEW events AS SELECT <cols>, fleet_raw(raw_jsonl, raw_z) AS raw_jsonl FROM events_store`.
- Without it: unchanged.
- A pre-v16 source (no `raw_z`): select `NULL AS raw_z`. Detect with `PRAGMA src.table_info(events)`.

In `storeImport.ts` `copyTable`, per row:
- if `table === 'events'` and `row.raw_z` is a non-empty Buffer → `row.raw_jsonl = rawLine(row)`, `row.raw_z = null`;
- for vector columns: an empty Buffer → `null`.
- Add `event_retention` and `maintenance` to `IMPORT_TABLES.state`.

- [ ] **Step 1: Failing tests:**
  - a compressed row is returned as text via `SELECT raw_jsonl FROM events` with `include_raw`;
  - `SELECT fleet_raw(raw_jsonl, raw_z)` works;
  - without `include_raw`, `raw_jsonl` stays absent;
  - import (Postgres suite): a compressed SQLite row arrives as the full `raw_jsonl` with null `raw_z`, and a placeholder empty vec arrives as NULL.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(mcp): query sees decompressed raw_jsonl via fleet_raw; import inflates (#526)`.

### Task 9: error.log rotation

**Files:**
- Modify: `src/main/errorLog.ts` (+ header comment: drop "No rotation")
- Test: `src/main/errorLog.test.ts`

**Interfaces:**
- Produces: `ERROR_LOG_MAX_BYTES = 5 * 1024 * 1024`; `_setErrorLogPathForTests(p: string | null)` if no test seam exists already.

In `logError`, before the append: `if (size + lineBytes > ERROR_LOG_MAX_BYTES && size > 0) { renameSync(p, p + '.1'); size = 0 }`. `size` is initialized lazily from `statSync(p).size` (0 if absent) and incremented by `lineBytes` after the append. A rename failure is swallowed, and the line is still appended.

- [ ] **Step 1: Failing test:** with the threshold forced (env or the exported constant via a test seam), writing past it produces `error.log.1` and a fresh `error.log` holding the newest line.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(errorlog): rotate error.log at 5 MB (#526)` plus the SPEC §6 *Error log* line.

### Task 10: Measuring script + final SPEC pass

**Files:**
- Create: `scripts/measure-statedb.mjs` (read-only; `--db <copy>`): `dbstat` per table and index; per-type rows and bytes of `raw_jsonl` (`length(CAST(raw_jsonl AS BLOB))`); zlib estimate on a 2% sample; placeholder count (`text = ''`); rows older than 30/90 days; orphan workspace ids (given `--state-dir`)
- Modify: `docs/SPEC.md` (verify every section above landed; §10 project layout lists new files)

- [ ] **Step 1:** Run the script on a test-built `state.db` (`node scripts/measure-statedb.mjs --db <tmp>`); expect a table printed with no writes (open `readonly: true`).
- [ ] **Step 2:** Commit `chore(scripts): read-only state.db size report (#526)`.
- [ ] **Step 3:** Full gates: `npx vitest run src/main` (SQLite), `npm run typecheck:node`, `npm run typecheck:web`.
