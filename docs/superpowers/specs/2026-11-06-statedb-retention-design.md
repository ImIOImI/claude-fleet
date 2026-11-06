# state.db retention (#476 fix #3)

Status: design approved by Troy (policy items 1–6 below); open questions resolved in this doc (§9).
Issue: #526. Parent: #476. Related: #465, #478, #500.

## 1. Problem

`state.db` on Troy's host is ~3.1 GB:

| Object | Size |
|---|---|
| `events` | 2,192 MB (~478k rows, ~4.8 KB/row, mostly `raw_jsonl`) |
| `embeddings` | 574 MB |
| `events` indexes | ~160 MB |
| `perf_events` | 32 MB (already pruned by `perfStore`) |

Nothing prunes `events` or `embeddings`. Claude Code deletes transcript JSONL after `cleanupPeriodDays`, so `state.db` is often the only long-term copy. Knowledge claims (#500) raise `cleanupPeriodDays` to 365 by default. `error.log` is 16.5 MB with no rotation.

Every DB-backed IPC call, the MCP `query` snapshot (#478) and backups pay for this size.

## 2. Measurements

### 2.1 Bytes per event class (sample, real transcripts)

Troy's running app (v0.14.11+85721e3) predates #478, so the MCP `query` tool was not used against the live DB. A copy of the host `state.db` was requested (notify, 2026-11-06). Until it lands, the ratios below come from 270 real Claude Code transcripts in this workspace's container (68,179 lines, 295 MB, avg 4.3 KB/line, close to the host's 4.8 KB/row). Each line was classified the way ingest does it. Then the §4.1 strip and §4.2 compression were applied to every line.

| Class | Rows | Raw MB | Share | Avg B | zlib MB | Stripped MB | Stripped + zlib MB |
|---|---|---|---|---|---|---|---|
| user `tool_result` | 16,528 | 126.7 | 42.9% | 7,665 | 47.1 | 17.5 | 10.6 |
| `attachment` | 7,754 | 68.3 | 23.2% | 8,813 | 18.1 | 68.3 | 18.1 |
| assistant (text/thinking) | 13,726 | 44.8 | 15.2% | 3,261 | 29.7 | 44.8 | 29.7 |
| assistant `tool_use` (input ≤ 2 KB) | 14,716 | 28.9 | 9.8% | 1,965 | 14.1 | 28.9 | 14.1 |
| assistant `tool_use` (input > 2 KB) | 1,822 | 13.8 | 4.7% | 7,579 | 5.4 | 6.5 | 2.8 |
| user (prompt) | 1,534 | 6.9 | 2.3% | 4,468 | 2.5 | 6.9 | 2.5 |
| everything else | 13,099 | 5.4 | 1.8% | — | 3.9 | 5.4 | 3.9 |
| **Total** | 68,179 | **295.0** | 100% | 4,327 | **120.6** | **178.6** | **81.6** |

Once retention applies, a row costs **28%** of its raw bytes (strip + zlib). zlib alone gets it to 41%.

Embeddings: of 48,392 user/assistant lines, **86.9% have no embeddable text** (tool-only or empty). Each still stores a 1,536-byte zero vector as a placeholder. The rest average 354 bytes of text.

### 2.2 Projected savings on Troy's host (provisional, from the ratios above)

| Item | Now | After | Saved |
|---|---|---|---|
| `events` rows older than 30 days (~55%, from the #476 monthly counts) | ~1,200 MB | ~340 MB | ~860 MB |
| `events` rows newer than 30 days | ~990 MB | ~990 MB | 0 (aged into retention later) |
| `embeddings`: placeholder vectors dropped (~290k rows × 1,536 B) | | | ~445 MB |
| `embeddings`: int8 vectors (~44k rows × 1,148 B) | | | ~50 MB |
| Deleted-workspace rows | unknown | | measured on the copy |
| **state.db file** | ~3.1 GB | **~1.7 GB** after the one-time VACUUM | **~1.4 GB** |

Steady state: rows older than 30 days stay at ~28% of their raw size, so growth drops by ~3.5× once a row ages past 30 days. Replace these figures with real per-type bytes when the host copy arrives. The measuring script is `scripts/measure-statedb.mjs` (§8). It runs read-only on a copy.

## 3. Constraints

- **Both dialects.** `state.db` runs on async Kysely with a SQLite or Postgres dialect. Every step works on both, or this spec states its Postgres equivalent.
- **Never block the main thread.** Bulk work runs in bounded slices on the async store handle with a duty-cycle throttle (§5). The one full VACUUM runs in a detached helper process after quit (§6).
- **No deleted event rows.** Re-ingest from an existing JSONL would re-insert deleted rows. Tool counts and `filesEdited` read the `tool_name`/`tool_input` columns. A rewritten row keeps every extract column, `dedup_key` and `id`. `INSERT … ON CONFLICT DO NOTHING` on `(session_id, dedup_key)` keeps a stripped row stripped when its line is re-read.
- **Readers see text.** Every reader of `raw_jsonl` gets the decompressed line, including the MCP `query` tool through a SQL function.

## 4. Policy (approved)

### 4.1 Strip (item 1)

A row is strippable when `ts < now − window`. `window` is 30 days, or 90 days when its session has a `usage_events` row of kind `resumed`. The resumed rule applies going forward only: a session resumed after its rows were stripped stays stripped (dedup keeps the stub even if the JSONL still has the full line). Two shapes:

- **`tool_result` rows** (`type = 'user'` and a `tool_result` block in `message.content`). The line is rewritten to a stub that keeps every top-level field except `toolUseResult`. Each `tool_result` block becomes `{ type, tool_use_id, is_error, content: <first 500 chars of its text> }`. The stub adds `fleetStripped: { bytes: <original UTF-8 byte length>, at: <ms> }`. That keeps `uuid`, `timestamp`, `tool_use_id`, the error flag, the original size and the head of the result, and the stub stays valid JSON that existing readers parse (`extractTurnText` still shows `[tool_result]`).
- **Oversized `tool_use` inputs** (`type = 'assistant'`, a `tool_use` block whose `JSON.stringify(input)` exceeds 2,048 chars). Each `input` field is rewritten: `file_path`, `path`, `notebook_path`, `command`, `pattern`, `url`, `description`, `skill` and `subagent_type` are kept, each capped at 4,096 chars. Every other string field longer than 200 chars becomes its first 200 chars plus `…`. Text and thinking blocks are kept. The line gets the same `fleetStripped` marker.

Other rows are never stripped. That includes `attachment` (23% of bytes; compressed only; see §9 Q7).

### 4.2 Compress (item 2)

On **SQLite**, rows with `ts < now − 30 days` whose stored line is ≥ 512 bytes are deflated with zlib (`node:zlib` `deflateSync`, level 6) into a new column `events.raw_z BLOB`, and `raw_jsonl` is set to `''`. A stripped row is stripped first, then compressed. Reads inflate: `raw_z IS NOT NULL ? inflate(raw_z) : raw_jsonl` (`state/rawCodec.ts:rawLine`).

On **Postgres**, rows are not compressed by the app. TOAST already compresses any text value over ~2 KB (pglz) without app involvement, so `raw_z` exists only for schema parity and stays NULL there. The SQLite→Postgres import (`storeImport.ts`) inflates `raw_z` into `raw_jsonl` and writes `raw_z` NULL.

The MCP `query` tool on SQLite registers `fleet_raw(raw_jsonl, raw_z)` in the worker. With `include_raw`, the snapshot copies `raw_jsonl` and `raw_z` into `events_store`, and `events` is a view whose `raw_jsonl` column is `fleet_raw(raw_jsonl, raw_z)`. Inflation then happens only for rows a query actually reads, and the snapshot holds the compressed bytes. `fleet_raw` is also callable directly. The Postgres temp view is unchanged.

### 4.3 Embeddings (item 3)

- **No vector for placeholders.** A turn with no embeddable text still gets a row, so it leaves the pending set (the indexer's anti-join), but with no vector: an empty BLOB on SQLite, `NULL` on Postgres (`embeddings.vec` loses `NOT NULL` there). Search already filters `text <> ''`, and claims never read this table.
- **int8 vectors (SQLite).** Callers pass float32; `insertEmbeddings` quantizes on SQLite only (Postgres keeps float32, see below). A vector is stored as `[float32 scale][384 × int8]` (388 bytes), where `scale = max|v| / 127`. `decodeVector` dispatches on byte length: `4·dim` is float32, `dim + 4` is int8, `0` is none. Old float32 rows stay readable. The dot product of the dequantized vectors approximates cosine, and the ranking test below bounds the error. `EmbedFn` and the model key (`EMBED_MODEL_ID`) are unchanged: same model, same vectors, different storage.
- **Postgres keeps `vector(384)`.** pgvector has no int8 type. `halfvec` would save under 30 MB on today's corpus, at the cost of a type migration plus importer and search changes. Placeholders as `NULL` give Postgres the main win (~78% of the table).
- **Recall gate (passed 2026-11-06).** The gate was int8 vs float32 on a fixed corpus of real turns from this workspace's transcripts: mean recall@10 ≥ 0.95 and the same top-1 on the benchmark-style queries.
  - **Result:** 5,497 turns and 209 queries (8 symptom queries plus 201 real prompts) gave mean recall@10 **0.992**, top-1 agreement **99.0%**, top-1 on the symptom queries **8/8**, and max score error **0.0024**.
  - **Why no model-backed test:** embedding the corpus takes ~15 min on CPU, so the model-backed run stays a one-off measurement. CI pins the ranking on fixture vectors (`retention.test.ts`).
- **Existing rows** are rewritten by the retention pass (§5): placeholders lose their vector and float32 rows are re-encoded to int8, keyset by `embeddings.id` up to the max id seen when the pass began, with the cursor saved in `maintenance`.

### 4.4 Deleted workspaces (item 4)

`purgeWorkspace(id)` deletes the workspace's rows from `events`, `sessions`, `session_costs`, `session_stats`, `session_tool_counts`, `broker_sessions`, `embeddings`, `session_summaries`, `session_tags`, `usage_events`, `port_exposures` and `event_retention`. It runs in id-ranged chunks of 250 rows, one transaction per chunk, with a macrotask yield between chunks (or the retention throttle when called from the sweep), so neither a transaction nor a loop turn grows with history. The ring buffers (`errors`, `perf_events`) and `usage_anchors` (account-wide) keep their rows.

- **On delete:** `workspace:remove` calls it when `opts.deleteState` is set and `opts.id` is known, after the backend removal succeeds. A remove that keeps state keeps the rows (the workspace can come back).
- **Orphan sweep** (every retention pass; finds nothing after the first). Runs only on SQLite and the managed Postgres: an external Postgres/RDS store can be shared with other desktops or `fleet-host`, and their workspaces have no manifest here. A workspace id in `sessions`, `events` or `embeddings` (recursive `min()` skip-scan per table) is purged only if all of these hold:
  - no manifest lists it, and `<userData>/state/<id>` does not exist;
  - it has the ULID shape;
  - the manifest listing succeeded and returned at least one workspace.

  A transient listing failure can't wipe history. Not run in mock mode or by `fleet-host`.

### 4.5 Vacuum (item 5)

- **SQLite, one-time conversion.** When `PRAGMA auto_vacuum` is not `INCREMENTAL` and the first retention pass has finished (`maintenance['retention.first_pass_at']`), a quit sets the DB up for conversion. After the bounded shutdown closes the DB, main spawns a detached helper (the Electron binary with `ELECTRON_RUN_AS_NODE=1`, the same mechanism as the MCP bridge). The helper takes `<userData>/state.db.vacuum.lock` (its pid), runs `PRAGMA auto_vacuum = INCREMENTAL; VACUUM;` and removes the lock. Quit is not delayed.
  - **Before spawning,** main requires free disk ≥ 2.2 × (db + wal) (`fs.statfs`): VACUUM peaks at about db + 2 × (temp copy + WAL). The helper's `SQLITE_TMPDIR`/`TMP`/`TEMP` point at `<userData>`, so one statfs covers the temp files. Otherwise it skips and logs `vacuum-skipped`.
  - **Lock first:** the lock (`{ pid: null, startedAt }`) is written before the spawn and rewritten with the pid after; if it can't be written, no helper runs. A pid-less lock (crash in between) is stale.
  - **Windows / NSIS:** the helper is the app's own executable, so an installer update started while it runs sees the app as running and may close it. A killed VACUUM rolls back, so this is safe.
  - **At startup,** a fresh lock naming a live pid defers only the SQLite history services; the window, IPC and the MCP server (a WAL reader, not blocked by VACUUM) start at once. The history bring-up waits asynchronously (poll every 250 ms, up to 120 s), then kills the helper and polls until its pid is gone (Windows releases file locks late). `openDb` sets `busy_timeout = 5000`. A killed VACUUM rolls back; the DB is unchanged and conversion is retried at a later quit, at most once per 24 h.
  - **Logged:** `vacuum-start`, `vacuum-done` (duration, bytes before and after), `vacuum-failed`.
- **SQLite, steady state.** After each retention pass, and at most every 30 min while the app runs, `PRAGMA freelist_count` is read. If it exceeds 4,096 pages (16 MB), `PRAGMA incremental_vacuum(1024)` runs in slices under the same throttle, until the freelist is under the threshold or 64 slices have run.
- **Postgres.** Nothing app-side. Rewritten rows leave dead tuples that autovacuum reclaims for reuse. Returning disk to the OS needs `VACUUM FULL`, which locks the table, so the app doesn't run it.

### 4.6 error.log rotation (item 6)

Before an append, `logError` checks the tracked size: one `stat` at first use, then the bytes written are counted in memory. At 5 MB it renames `error.log` to `error.log.1`, replacing any previous `.1`, and starts a new file. At most ~10 MB stays on disk. Rotation failure is swallowed, like the append: on Windows a rename fails while another process holds the log open, so the line goes to the current file and rotation retries on the next line (fails soft). `getLogPath()` is unchanged.

## 5. The retention pass

`src/main/state/retention.ts`. One instance per main process, started by the history services: the SQLite path after `openDb` and the Postgres service step `retention`, after `watcher`. Stopped at quit before `closeDb()`.

- **Schedule:** first pass 5 min after start (clear of the #464 startup storm), then every 24 h, plus the incremental vacuum check every 30 min.
- **Throttle:** work goes in slices of at most 200 rows or 2 MB of raw bytes, one transaction per slice. A slice reads keys and stored sizes first (`octet_length`, no payload), then bodies only up to the byte budget, so no row is read twice. `retentionCandidates` runs under its own span (`claude_fleet.retention.candidates`). After a slice that took `t` ms, the pass sleeps `max(250, 9·t)` ms (≤10% duty cycle). Each slice is wrapped in `perfSpanAsync('claude_fleet.retention.slice')`. A stop request ends the pass between slices.
- **Steps per pass:** (1) orphan sweep; (2) events by session; (3) embeddings compaction; (4) incremental vacuum (SQLite).
- **Events by session:** sessions whose `started_at < now − 30 d`, ordered by `started_at`. Watermarks are kept in `event_retention(session_id PK, workspace_id, compressed_before, stripped_before)`. For a session with compress cut `cCut = now − 30 d` and strip cut `sCut = now − (resumed ? 90 : 30) d`:
  - rows with `ts ∈ [compressed_before, cCut)` are read keyset `(ts, id)` through `idx_events_session_ts`; each is stripped if `ts < sCut` and strippable, then compressed;
  - rows with `ts ∈ [stripped_before, min(sCut, compressed_before))` and `tool_use_id IS NOT NULL` are stripped (the resumed session's 30–90 day rows when they age out);
  - after the session, the watermarks advance to `cCut` and `sCut`, written only if the session still exists (a purge racing the pass leaves no `event_retention` row).

  No index on `events` is added: building one would read the whole 2 GB table at migration on the main thread.
- **Rows with `ts` NULL** (light events, ~100 B) are left as they are.
- **Late rows:** a row inserted later with a `ts` below its session's watermark is not revisited. It still reads correctly; it just stays raw.

## 6. Schema (state v16, Postgres step 16)

- `events.raw_z BLOB` (Postgres `BYTEA`), NULL by default: ADD COLUMN only, O(1) on both.
- `event_retention(session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, compressed_before INTEGER NOT NULL DEFAULT 0, stripped_before INTEGER NOT NULL DEFAULT 0)` and index `(workspace_id)`.
- `maintenance(key TEXT PRIMARY KEY, value TEXT NOT NULL)`: `retention.first_pass_at`, `retention.last_pass_at`, `embeddings.compacted_through_id`, `vacuum.last_attempt_at`.
- Postgres only: `ALTER TABLE embeddings ALTER COLUMN vec DROP NOT NULL`. SQLite's `vec BLOB NOT NULL` accepts the empty BLOB.
- `deleteSession` also deletes `event_retention` and `embeddings` rows for the session (today it leaves embeddings behind).
- `stateSchema.ts`, `statePg.ts`, `schemaParity.test.ts` and SPEC §7 change in the same commit.

## 7. Components

| Unit | Responsibility |
|---|---|
| `state/rawCodec.ts` | `rawLine(row)`, `compressLine`, `stripToolResult`, `stripToolInput`: pure, no DB |
| `state/retention.ts` | pass scheduler, throttle, orphan sweep, events and embeddings steps (dialect-aware) |
| `db.ts` | v16 migration; readers use `rawLine`; `purgeWorkspace`; `deleteSession` extension; retention queries |
| `vectors.ts` | `encodeVectorInt8`, length-dispatching `decodeVector` |
| `transcriptIndex.ts` | placeholders insert an empty vector; real vectors via the storage encoder (no `EmbedFn` change) |
| `queryWorker.ts` | `fleet_raw` function plus the `events` view when `include_raw` |
| `store/storeImport.ts` | `events.raw_z` → `raw_jsonl`; empty BLOB → `NULL` vector |
| `state/vacuumHelper.ts` | quit-time spawn, lock file, startup wait/kill |
| `errorLog.ts` | rotation |
| `ipc.ts` | `workspace:remove` → `purgeWorkspace` |
| `scripts/measure-statedb.mjs` | read-only per-type byte report on a `state.db` copy |

## 8. Testing

- **Unit, both dialects** (`STORE_TEST_DIALECT`):
  - the strip and compress round-trip;
  - re-ingesting a stripped row's original line leaves the stub;
  - rollups, `topTools` and `filesEdited` are unchanged after a pass;
  - the 30/90-day windows and watermarks;
  - `purgeWorkspace` and the orphan sweep guards;
  - placeholder and int8 rows, and search ranking;
  - the import of compressed rows and empty vectors.
- **`queryWorker.test.ts`:** `include_raw` returns decompressed text, and `fleet_raw` works.
- **`errorLog.test.ts`:** rotation at the threshold.
- **Vacuum helper:** lock handling, the startup wait/kill path, and the free-space guard, all against a temp DB. The real VACUUM runs on a small DB in the test.
- **Recall:** `embeddingsQuantize.test.ts` (§4.3).
- **Not possible in the container:** the end-to-end effect on Troy's host. After install: compare `state.db` size and `dbstat` before and after a pass plus a quit, and check that no `retention.slice` span exceeds 50 ms.

## 9. Decisions made on Troy's behalf

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Where compressed bytes live | New `raw_z` column, `raw_jsonl = ''` | Keeps `raw_jsonl TEXT` typed on both dialects; no sniffing |
| Q2 | Compression on Postgres | None app-side; TOAST already compresses | Avoids a server extension; the query view stays plain text |
| Q3 | Tracking progress | Per-session watermarks, not a per-row flag | A partial index would read the whole 2 GB table at migration on the main thread |
| Q4 | Running the bulk pass | Main process, async store, 200-row slices, ≤10% duty | A worker connection would contend for the write lock, and better-sqlite3's busy wait blocks the main thread |
| Q5 | One-time VACUUM | Detached helper after quit | Online VACUUM must stall every store read for its whole run; at-quit inside the 10 s bound is too short |
| Q6 | int8 on Postgres | No; placeholders `NULL` only | No int8 type in pgvector; halfvec saves < 30 MB |
| Q7 | `attachment` rows (23% of bytes) | Compressed, not stripped | Not in the approved policy; follow-up issue if the host copy shows the same share |
| Q8 | Orphan sweep safety | Manifest + state-dir absence + ULID + non-empty listing; SQLite/managed store only | A shared external store holds other desktops' workspaces. A transient listing failure must never wipe history |
| Q9 | error.log size | 5 MB × 2 files | One startup's `new-session-dropped` burst is ~0.3 MB |
