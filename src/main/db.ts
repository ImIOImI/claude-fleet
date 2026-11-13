// SQLite cache for JSONL transcript events.
//
// JSONL is the source of truth; this DB is rebuildable from the JSONLs at any
// time. `events` mirrors raw lines with fast-access extract columns;
// `sessions` carries derived per-session metadata. The watcher ingests every
// JSONL line through `ingestEvent`; duplicate ingestions (re-tail after
// restart) are silently dropped via the UNIQUE(session_id, dedup_key)
// constraint — `dedup_key` is the event's uuid when present, otherwise a
// hash of the raw line so light events without uuids also dedupe cleanly.

import { mkdirSync } from 'node:fs';
import { fileSize } from './store/sqliteFiles.js';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { costFor } from './pricing.js';
import { contextWindowFor } from './contextWindow.js';
import { isSyntheticPromptText } from './userPromptText.js';
import { extractAnchor } from './usageAnchors.js';
import { asyncKeyedCache } from './asyncCache.js';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { sqliteKysely, num, chunked, readTransaction } from './store/kysely.js';
import type pg from 'pg';
import { postgresKysely, schemaOf, type PostgresKyselyOptions } from './store/postgres.js';
import { migratePostgres, ensureVector } from './store/pgMigrate.js';
import { STATE_PG_TRACK } from './store/migrations/statePg.js';
import { EMBED_MODEL_ID, EMBED_DIM, decodeVector, dot, encodeVectorInt8, topK, EMPTY_VECTOR } from './vectors.js';
import { pgSearchEmbeddings, pgVectorLiteral } from './store/pgVectorSearch.js';
import type { StateDb, UsageAnchorsTable } from './store/stateSchema.js';
import { parseIngestLine, foldSessionTouch, type ParsedLine } from './state/ingestParse.js';
import { rawLine } from './state/rawCodec.js';
import { ATTACHMENT_MIN_BYTES, dedupeAttachment, deflatePayload, expandLine } from './state/attachmentCodec.js';
import { PARTITION_PREFIX, SESSION_UUID_RE } from './publish/protocol.js';

let db: Database.Database | null = null;
let kdb: Kysely<StateDb> | null = null;
/** The statement cache keeps prepared-statement reuse on the hot ingest path. */
const STATE_STATEMENT_CACHE = 256;

// Debounced summary invalidation (#383): ingest marks the entry stale with a
// 3s grace instead of deleting it, so a streaming session recomputes at most
// once per grace window instead of on every poll-after-every-event. Exported
// so ipc.ts can schedule a trailing re-broadcast at grace+250ms after
// quiescence, ensuring the renderer receives the final post-burst state.
export const SUMMARY_STALE_GRACE_MS = 3_000;

// Event-invalidated read caches (spec 2026-08-15-summary-read-caches-design.md).
// Correctness policy: ingestLine calls markStale(sessionId, SUMMARY_STALE_GRACE_MS)
// — a debounced invalidation that lets a streaming session recompute at most once
// per 3s grace window instead of on every poll-after-every-event; hard invalidate
// is reserved for deleteSession and rename. openDb clears all caches (a reopened
// DB must never serve the previous database's values). The TTL on summaries is a
// safety net only. Broker-mapping learns deliberately do NOT invalidate — the
// mapping resolves before the cache and only the post-resolution summary is cached.
const summaryCache = asyncKeyedCache<WorkspaceSummary | null>({ maxEntries: 512, ttlMs: 30_000 });
const spendCache = asyncKeyedCache<number>({ maxEntries: 4 });

// Test seam (#383): counts summaryForSessionUncached executions so the
// storm-bound integration test can assert the debounce works end-to-end.
let summaryRecomputes = 0;
export function _summaryRecomputesForTests(): number {
  return summaryRecomputes;
}

const DEFAULT_TOP_TOOLS = 5;

/** What openDb found and did, plus the first write after it (perf telemetry). */
export interface StateOpenStats {
  openedAt: number;
  openMs: number;
  /** `state.db-wal` size before the open: a WAL left by the previous run. */
  walBytes: number;
  /** Valid WAL frames after recovery, none of them counted as checkpointed. */
  walFrames: number;
  /** The leftover WAL went to the drain worker instead of the first commit. */
  handedOff: boolean;
  /** Whether that worker came up (null: no hand-off, or not known yet). */
  workerReady: boolean | null;
  /** The first statement that committed a change: a COMMIT of a transaction that changed rows, or an autocommit write that did. */
  firstWriteAt: number | null;
  firstWriteMs: number | null;
  /** Effective page cache in KiB, and mmap_size in bytes. */
  cacheKib: number;
  mmapBytes: number;
}

let openStats: StateOpenStats | null = null;
let openStatsReady: Promise<StateOpenStats> | null = null;

/** Call `cb` once with the open db's stats: at its first write, or `fallbackMs`
 *  after the open without one (firstWrite* still null). Never after it closes. */
export function onStateOpenStats(cb: (s: StateOpenStats) => void, fallbackMs: number): void {
  const stats = openStats;
  const ready = openStatsReady;
  if (!stats || !ready) return;
  let done = false;
  const fire = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (openStats === stats) cb({ ...stats });
  };
  const timer = setTimeout(fire, Math.max(0, stats.openedAt + fallbackMs - Date.now()));
  timer.unref?.();
  void ready.then(fire);
}

// The WAL checkpointer's contract (state/walCheckpointer.ts implements it).
export interface CheckpointResult { busy: number; log: number; checkpointed: number }

/** One user's interest in the store's checkpointer. */
export interface WalCheckpointLease {
  /** Start a PASSIVE checkpoint in the worker unless one is already running. */
  request(): void;
  /** Resolves when no checkpoint is running. */
  idle(): Promise<void>;
  /** Run a checkpoint of its own (after any in flight) and resolve with its
   *  result: null when it failed, hung or the worker handed back. */
  checkpoint(): Promise<CheckpointResult | null>;
  /** Whether the worker came up. */
  ready(): Promise<boolean>;
  /** Once the WAL has passed WAL_REWIND_FRAMES: run a checkpoint and wait for it,
   *  so the caller's next write rewinds the WAL. Otherwise resolves at once. */
  drain(): Promise<void>;
  last(): CheckpointResult | null;
  /** False once checkpoints are handed back to the main connection, or this lease is closed. */
  active(): boolean;
  /** Drop this lease; the last one restores the main connection and ends the worker. Never waits on a checkpoint. */
  close(): Promise<void>;
}

export interface CheckpointerOptions {
  workerSource?: string;
  /** How often to request a checkpoint while running (0 = only on request()). */
  requestEveryMs?: number;
  /** Default CHECKPOINT_TIMEOUT_MS (DRAIN_TIMEOUT_MS while a drain runs). */
  checkpointTimeoutMs?: number;
  /** Default READY_TIMEOUT_MS. */
  readyTimeoutMs?: number;
  /** The database the worker opens; db.ts passes state.db. */
  dbPath?: string;
}

export interface CheckpointHost {
  dbPath: string;
  /** Run `fn` on the main connection behind the store mutex; no-op once it closed. */
  withMain(fn: (d: Database.Database) => void): Promise<void>;
  warn(message: string, extra?: Record<string, unknown>): void;
}

export interface WalDrainResult {
  startedAt: number;
  ms: number;
  ok: boolean;
  rounds: number;
  busy?: number;
  log?: number;
  checkpointed?: number;
  error?: string;
}

export interface StoreCheckpointer {
  /** At openDb, before anything writes: hold checkpoints and spawn the worker; the lease is the drain's. */
  holdAtOpen(conn: Database.Database, opts?: CheckpointerOptions): WalCheckpointLease;
  acquire(opts?: CheckpointerOptions): Promise<WalCheckpointLease | null>;
  /** True while a worker thread may still hold a connection. */
  hasWorkers(): boolean;
  /** Hand back, end the worker and wait (bounded) for every worker thread to exit. */
  stop(): Promise<void>;
}

interface CheckpointerFactory {
  create(host: CheckpointHost): StoreCheckpointer;
  drain(lease: WalCheckpointLease, warn: CheckpointHost['warn']): Promise<WalDrainResult>;
}
let checkpointerFactory: CheckpointerFactory | null = null;

/** Off-main search for `searchEmbeddings` on SQLite (searchWorker.ts), installed
 *  at boot like the checkpointer so fleet-host's import graph stays free of worker code. */
export interface SqliteSearchScanner {
  scan(conn: () => Database.Database | null, q: Float32Array, scope: string[], o: { limit: number; kind?: 'turn' | 'summary' }): Promise<EmbeddingHit[]>;
  close(): Promise<void>;
}
let searchScannerFactory: ((dbPath: string) => SqliteSearchScanner) | null = null;
let searchScanner: (SqliteSearchScanner & { path: string }) | null = null;
export function setSqliteSearchScannerFactory(f: ((dbPath: string) => SqliteSearchScanner) | null): void {
  searchScannerFactory = f;
}
/** Set while closeDb closes the scanner: searches refuse rather than start another worker. */
let searchScannerClosing: Promise<void> | null = null;

/** Without one (fleet-host, tests that don't install it) SQLite keeps its own auto-checkpoint. */
export function setWalCheckpointerFactory(f: CheckpointerFactory | null): void {
  checkpointerFactory = f;
}

let warnSink: ((message: string, extra?: Record<string, unknown>) => void) | null = null;

/** Where the WAL checkpointer's warnings go (db.ts stays free of the Electron-bound error log). */
export function setStateWarnSink(fn: ((message: string, extra?: Record<string, unknown>) => void) | null): void {
  warnSink = fn;
}

/** The open SQLite store's single WAL checkpointer; null on Postgres or closed. */
let checkpointer: StoreCheckpointer | null = null;
let leftoverDrain: Promise<WalDrainResult> | null = null;
let stoppingCheckpointer: Promise<void> | null = null;
let checkpointerTestOpts: CheckpointerOptions = {};

/** Test seam: worker source / timing for checkpointer workers started from now on. */
export function _setWalCheckpointerOptionsForTests(opts: CheckpointerOptions): void {
  checkpointerTestOpts = opts;
}

/** A lease on the store's WAL checkpointer, starting its worker if none runs
 *  (retention). Null on Postgres, when closed, or when the worker can't start. */
export async function acquireWalCheckpointer(opts: CheckpointerOptions = {}): Promise<WalCheckpointLease | null> {
  const c = checkpointer;
  if (!c || dialect !== 'sqlite') return null;
  return c.acquire({ ...checkpointerTestOpts, ...opts }).catch(() => null);
}

/** The leftover-WAL drain openDb started, if any. */
export function stateLeftoverDrain(): Promise<WalDrainResult> | null {
  return leftoverDrain;
}

/** cache_size in KiB: negative values are KiB, positive ones pages. */
function cacheKib(conn: Database.Database): number {
  const n = conn.pragma('cache_size', { simple: true }) as number;
  return n < 0 ? -n : (n * (conn.pragma('page_size', { simple: true }) as number)) / 1024;
}

const WRITE_SQL = /^\s*(insert|update|delete|replace|commit|end)\b/i;

export function openDb(userDataDir: string): Database.Database {
  if (db) return db;
  if (kdb) throw new Error('state.db is open on Postgres: closeDb() first');
  // A reopened DB must never serve the previous database's values.
  summaryCache.clear();
  spendCache.clear();
  const path = join(userDataDir, 'state.db');
  mkdirSync(dirname(path), { recursive: true });
  const openedAt = Date.now();
  const t0 = performance.now();
  const walBytes = fileSize(`${path}-wal`);
  const conn = new Database(path);
  const prevCheckpointer = checkpointer;
  db = conn;
  try {
    return openSqliteConn(conn, path, openedAt, t0, walBytes);
  } catch (e) {
    // Never leave a half-open handle: a later openDb would return it unmigrated.
    const ck = checkpointer;
    if (ck && ck !== prevCheckpointer) void ck.stop().catch(() => undefined);
    checkpointer = prevCheckpointer;
    db = null;
    kdb = null;
    leftoverDrain = null;
    openStats = null;
    if (conn.open) conn.close();
    throw e;
  }
}

function openSqliteConn(conn: Database.Database, path: string, openedAt: number, t0: number, walBytes: number): Database.Database {
  conn.pragma('journal_mode = WAL');
  // A lock still being released (e.g. a just-killed VACUUM helper on Windows) waits, not throws.
  conn.pragma('busy_timeout = 5000');
  conn.pragma('foreign_keys = ON');
  const factory = checkpointerFactory;
  const ck = factory?.create({
    dbPath: path,
    // Behind the store mutex while this connection is the store's; directly
    // once closeDb has detached it. Errors from fn propagate, never rerun.
    withMain: async (fn) => {
      if (db !== conn || !kdb) {
        if (conn.open) fn(conn);
        return;
      }
      await withRawSqlite((d) => { if (d === conn) fn(d); });
    },
    warn: (message, extra) => warnSink?.(message, extra),
  });
  checkpointer = ck ?? null;
  leftoverDrain = null;
  // Recovery counts every valid frame of a leftover WAL as not checkpointed,
  // so the first commit past wal_autocheckpoint would copy all of them, with
  // fsyncs, on the main thread. Hold before anything (migrate included) writes.
  const [noop] = conn.pragma('wal_checkpoint(NOOP)') as Array<{ log: number }>;
  const walFrames = Math.max(0, noop?.log ?? 0);
  const autockpt = conn.pragma('wal_autocheckpoint', { simple: true }) as number;
  let lease: WalCheckpointLease | null = null;
  if (ck && factory && autockpt > 0 && walFrames >= autockpt) {
    try {
      lease = ck.holdAtOpen(conn, checkpointerTestOpts);
      leftoverDrain = factory.drain(lease, (m, e) => warnSink?.(m, e));
    } catch (e) {
      warnSink?.(`leftover WAL drain did not start: ${String(e)}`);
    }
  }
  migrate(conn);
  rehydratePendingClaudeIds(conn);
  const stats: StateOpenStats = {
    openedAt, openMs: performance.now() - t0, walBytes, walFrames, handedOff: lease !== null, workerReady: null, firstWriteAt: null, firstWriteMs: null,
    cacheKib: cacheKib(conn), mmapBytes: Number(conn.pragma('mmap_size', { simple: true }) ?? 0),
  };
  void lease?.ready().then((ok) => { stats.workerReady = ok; });
  let settle: (s: StateOpenStats) => void = () => undefined;
  // Whether the open transaction has changed rows so far.
  let txChanged = false;
  openStats = stats;
  openStatsReady = new Promise<StateOpenStats>((resolve) => { settle = resolve; });
  // Every state.db read and write goes through this one Kysely handle (its
  // mutex serializes them); the raw handle serves only migrate() and the
  // rehydrate above.
  dialect = 'sqlite';
  kdb = sqliteKysely<StateDb>(conn, {
    statementCache: STATE_STATEMENT_CACHE,
    onQuery: (sqlText, ms, changes) => {
      if (openStats !== stats || stats.firstWriteMs !== null) return;
      const kind = WRITE_SQL.exec(sqlText)?.[1].toLowerCase();
      if (kind === undefined) {
        if (/^\s*(begin|rollback)\b/i.test(sqlText)) txChanged = false;
        return;
      }
      let committed: boolean;
      if (kind === 'commit' || kind === 'end') {
        committed = txChanged;
        txChanged = false;
      } else if (changes === 0) {
        return;
      } else if (conn.inTransaction) {
        txChanged = true;
        return;
      } else {
        committed = true;
      }
      if (!committed) return;
      stats.firstWriteMs = ms;
      stats.firstWriteAt = Date.now() - ms;
      settle(stats);
    },
  });
  return conn;
}

/** The dialect of the open (or draining) handle; each opener sets it. */
let dialect: 'sqlite' | 'postgres' = 'sqlite';

/** Open state.db's tables on a Postgres store pool: pgvector
 *  check, migrations, then the same pending-remap rehydrate as openDb.
 *  `migrate: false`: the caller already ran migratePgStores (fleet-host migrates unfenced). */
export async function openDbPostgres(pool: pg.Pool, opts: PostgresKyselyOptions & { migrate?: boolean } = {}): Promise<void> {
  if (kdb) {
    if (dialect === 'postgres') return;
    throw new Error('state.db is open on SQLite: closeDb() first');
  }
  summaryCache.clear();
  spendCache.clear();
  const k = postgresKysely<StateDb>(pool, opts);
  if (opts.migrate !== false) {
    await ensureVector(k);
    await migratePostgres(k, schemaOf(pool), STATE_PG_TRACK);
  }
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
  const k = kdb;
  if (!k) return;
  if (searchScannerClosing) {
    await searchScannerClosing;
    if (kdb !== k) return;
  }
  const ss = searchScanner;
  if (ss) {
    searchScannerClosing = ss.close().finally(() => {
      searchScanner = null;
      searchScannerClosing = null;
    });
    await searchScannerClosing;
    if (kdb !== k) return;
  }
  const ck = checkpointer;
  checkpointer = null;
  if (ck?.hasWorkers()) {
    // Its worker's connection must close first, so main's close is the last one
    // and checkpoints and removes the WAL.
    stoppingCheckpointer = ck.stop().finally(() => { stoppingCheckpointer = null; });
  } else {
    void ck?.stop();
  }
  if (stoppingCheckpointer) {
    await stoppingCheckpointer;
    if (kdb !== k) return;
  }
  const raw = db;
  db = null;
  kdb = null;
  leftoverDrain = null;
  openStats = null;
  // Queues behind whatever holds the mutex; also forces driver init so
  // destroy() really closes the connection.
  await sql`select 1`.execute(k).catch(() => undefined);
  await k.destroy();
  if (raw?.open) raw.close();
  // Only clear in-memory mirrors once every in-flight transaction (and its
  // own post-await mutation of them) has fully drained through the mutex —
  // clearing earlier could race a transaction still resuming after its await.
  // And only if nothing reopened the db while we were closing: a reopen's
  // rehydrate has already repopulated these from the new connection, and an
  // unconditional clear here would wipe that out from under it.
  if (!kdb) {
    pendingClaudeIds.clear();
    summaryCache.clear();
    spendCache.clear();
  }
}

/** The open handle's dialect. */
export function stateDialect(): 'sqlite' | 'postgres' {
  kyselyOrThrow();
  return dialect;
}

/** Run `fn` on the raw SQLite handle while holding the store's connection
 *  mutex (so it never interleaves with a Kysely transaction); null on Postgres.
 *  For what the driver can't do: `PRAGMA incremental_vacuum(N)` through
 *  `run()` frees one page, `db.pragma()` frees N. */
export async function withRawSqlite<T>(fn: (d: Database.Database) => T): Promise<T | null> {
  const k = kyselyOrThrow();
  const raw = db;
  if (dialect !== 'sqlite' || !raw) return null;
  return k.connection().execute(async () => fn(raw));
}

/** A `maintenance` value (retention / vacuum bookkeeping), or null. */
export async function maintenanceGet(key: string): Promise<string | null> {
  const r = await kyselyOrThrow().selectFrom('maintenance').select('value').where('key', '=', key).executeTakeFirst();
  return r?.value ?? null;
}

export async function maintenanceSet(key: string, value: string): Promise<void> {
  await kyselyOrThrow().insertInto('maintenance').values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute();
}

/** The async store handle over state.db. Throws before openDb / after closeDb. */
export function stateKysely(): Kysely<StateDb> {
  return kyselyOrThrow();
}

// Claude session ids that some tab is waiting on before promoting a deferred
// remap (#170), keyed `${workspaceId}\u0000${claudeSessionId}`. An in-memory
// fast-path so `ingestLine` can skip the promotion UPDATE on the common line
// (no pending remap). Rehydrated from the persisted rows on open so a restart
// doesn't strand a pending mapping.
const pendingClaudeIds = new Set<string>();
const pendingKey = (workspaceId: string, claudeSessionId: string): string =>
  `${workspaceId}\u0000${claudeSessionId}`;

/** Test-only view of the pending-remap guard set (keys from `pendingKey`). */
export function __pendingClaudeIdsForTest(): ReadonlySet<string> {
  return pendingClaudeIds;
}

function rehydratePendingClaudeIds(d: Database.Database): void {
  pendingClaudeIds.clear();
  const rows = d
    .prepare(
      `SELECT workspace_id, pending_claude_session_id FROM broker_sessions
       WHERE pending_claude_session_id IS NOT NULL`,
    )
    .all() as Array<{ workspace_id: string; pending_claude_session_id: string }>;
  for (const r of rows) pendingClaudeIds.add(pendingKey(r.workspace_id, r.pending_claude_session_id));
}

function migrate(d: Database.Database): void {
  const current = (d.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current < 1) {
    d.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        ts INTEGER,
        type TEXT NOT NULL,
        subtype TEXT,
        uuid TEXT,
        parent_uuid TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        service_tier TEXT,
        tool_name TEXT,
        raw_jsonl TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        UNIQUE(session_id, dedup_key)
      );
      CREATE INDEX idx_events_session_ts ON events(session_id, ts);
      CREATE INDEX idx_events_workspace ON events(workspace_id);
      CREATE INDEX idx_events_type ON events(type);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        cwd TEXT,
        started_at INTEGER,
        last_active_at INTEGER,
        ai_title TEXT,
        first_user_message TEXT,
        user_set_name TEXT
      );
      CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
    `);
    d.pragma('user_version = 1');
  }
  if (current < 2) {
    // broker_sessions: maps each renderer-owned broker session id (the
    // stable per-tab uid in sessions.json) to the claude-generated
    // session UUID claude writes its JSONL under. Learned passively by
    // the JsonlWatcher's onNewSession hook + a pending-attach map kept
    // in docker.ts — see §11 "Per-tab mapping" in docs/SPEC.md.
    // Persisted because mappings need to survive app restarts: when the
    // broker still has the claude alive across restart, no new JSONL
    // appears for us to re-learn from.
    d.exec(`
      CREATE TABLE broker_sessions (
        workspace_id TEXT NOT NULL,
        broker_session_id TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        learned_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, broker_session_id)
      );
      CREATE INDEX idx_broker_sessions_claude ON broker_sessions(claude_session_id);
    `);
    d.pragma('user_version = 2');
  }
  if (current < 3) {
    // Workspace identity moved from mutable name → immutable ULID id
    // (workspace-modal redesign, Foundation PR). Pre-existing rows refer
    // to workspaces by name which no longer matches anything in the new
    // state-dir layout, so we cut history rather than carry stale
    // foreign keys. Matches the "clean slate" migration documented in
    // docs/design/workspace-modal.md.
    d.exec(`
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS broker_sessions;

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        ts INTEGER,
        type TEXT NOT NULL,
        subtype TEXT,
        uuid TEXT,
        parent_uuid TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        service_tier TEXT,
        tool_name TEXT,
        raw_jsonl TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        UNIQUE(session_id, dedup_key)
      );
      CREATE INDEX idx_events_session_ts ON events(session_id, ts);
      CREATE INDEX idx_events_workspace ON events(workspace_id);
      CREATE INDEX idx_events_type ON events(type);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        cwd TEXT,
        started_at INTEGER,
        last_active_at INTEGER,
        ai_title TEXT,
        first_user_message TEXT,
        user_set_name TEXT
      );
      CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);

      CREATE TABLE broker_sessions (
        workspace_id TEXT NOT NULL,
        broker_session_id TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        learned_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, broker_session_id)
      );
      CREATE INDEX idx_broker_sessions_claude ON broker_sessions(claude_session_id);
    `);
    d.pragma('user_version = 3');
  }
  if (current < 4) {
    // Tool-call detail (Phase B observability): tool_use_id links a
    // tool_use event to its tool_result so we can compute call duration;
    // tool_input is a short arg summary; tool_result_is_error is 1/0 on the
    // result event. Additive ALTER (not a clean-slate) so existing token /
    // cost history survives — tool detail populates as new calls land.
    d.exec(`
      ALTER TABLE events ADD COLUMN tool_use_id TEXT;
      ALTER TABLE events ADD COLUMN tool_input TEXT;
      ALTER TABLE events ADD COLUMN tool_result_is_error INTEGER;
      CREATE INDEX idx_events_tool_use ON events(session_id, tool_use_id);
    `);
    d.pragma('user_version = 4');
  }
  if ((d.pragma('user_version', { simple: true }) as number) < 5) {
    d.exec(`
      CREATE TABLE errors (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        workspace_id TEXT,
        session_id   TEXT,
        source       TEXT NOT NULL,
        level        TEXT NOT NULL,
        type         TEXT NOT NULL,
        message      TEXT NOT NULL,
        stack        TEXT,
        extra        TEXT
      );
      CREATE INDEX idx_errors_workspace_ts ON errors(workspace_id, ts);
      CREATE INDEX idx_errors_session ON errors(session_id);
    `);
    d.pragma('user_version = 5');
  }
  if ((d.pragma('user_version', { simple: true }) as number) < 6) {
    // Semantic transcript search (rebuildable from JSONL — additive).
    d.exec(`
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        kind         TEXT NOT NULL,          -- 'turn' | 'summary'
        ref_event_id INTEGER,
        ts           INTEGER,
        text         TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        dim          INTEGER NOT NULL,
        vec          BLOB NOT NULL,
        dedup_key    TEXT NOT NULL,
        UNIQUE(session_id, kind, dedup_key)
      );
      CREATE INDEX idx_emb_workspace ON embeddings(workspace_id);
      CREATE INDEX idx_emb_session   ON embeddings(session_id);
      CREATE INDEX idx_emb_ref_event ON embeddings(ref_event_id);

      CREATE TABLE session_summaries (
        session_id          TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        summary             TEXT NOT NULL,
        source_max_event_id INTEGER NOT NULL,
        model               TEXT,
        generated_at        INTEGER NOT NULL
      );
    `);
    d.pragma('user_version = 6');
  }
  if ((d.pragma('user_version', { simple: true }) as number) < 7) {
    // Verified resume mappings (#195 follow-up). Rows minted by the pre-#198
    // FIFO guess are indistinguishable from facts, and a tab Refresh that
    // trusts one resumes the WRONG conversation. New learns are deterministic
    // (host-assigned --session-id / explicit --resume) and marked verified=1;
    // every pre-existing row stays verified=0 — still fine for observability
    // attribution, but never again a resume target.
    d.exec(`ALTER TABLE broker_sessions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`);
    d.pragma('user_version = 7');
  }
  if ((d.pragma('user_version', { simple: true }) as number) < 8) {
    // Phase 2 (#207): chaptered summaries + tags + value-signal collection.
    // session_summaries becomes append-only chapters (one per summarized
    // window); a wandering multi-day session gets topical chapters instead
    // of one over-generalized replaced blurb. Old rows migrate as chapters.
    d.exec(`
      CREATE TABLE session_summaries_v8 (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id          TEXT NOT NULL,
        workspace_id        TEXT NOT NULL,
        summary             TEXT NOT NULL,
        tags                TEXT,
        source_max_event_id INTEGER NOT NULL,
        from_ts             INTEGER,
        to_ts               INTEGER,
        model               TEXT,
        generated_at        INTEGER NOT NULL,
        UNIQUE(session_id, source_max_event_id)
      );
      INSERT INTO session_summaries_v8
        (session_id, workspace_id, summary, source_max_event_id, model, generated_at)
        SELECT session_id, workspace_id, summary, source_max_event_id, model, generated_at
        FROM session_summaries;
      DROP TABLE session_summaries;
      ALTER TABLE session_summaries_v8 RENAME TO session_summaries;
      CREATE INDEX idx_session_summaries_session ON session_summaries(session_id, generated_at);

      CREATE TABLE session_tags (
        workspace_id TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        tag          TEXT NOT NULL,
        PRIMARY KEY (session_id, tag)
      );
      CREATE INDEX idx_session_tags_workspace ON session_tags(workspace_id, tag);

      CREATE TABLE usage_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id   TEXT,
        kind         TEXT NOT NULL,
        detail       TEXT
      );
      CREATE INDEX idx_usage_events_session ON usage_events(session_id, kind);
      CREATE INDEX idx_usage_events_workspace_ts ON usage_events(workspace_id, ts);
    `);
    d.pragma('user_version = 8');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 9) {
    // Account-level rate-limit anchors — the only account-wide-true checkpoints
    // (429 reset messages + populated rateLimits payloads). Rebuildable from JSONL.
    d.exec(`
      CREATE TABLE usage_anchors (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        workspace_id TEXT,
        session_id   TEXT,
        kind         TEXT NOT NULL,      -- 'limit-hit' | 'throttle'
        http_status  INTEGER,
        scope        TEXT,               -- 'session' | 'weekly' | 'opus-weekly'
        reset_at     INTEGER,
        window_start INTEGER,
        message      TEXT,
        rate_limits  TEXT,
        dedup_key    TEXT NOT NULL,
        UNIQUE(dedup_key)
      );
      CREATE INDEX idx_usage_anchors_ts ON usage_anchors(ts);
    `);
    d.pragma('user_version = 9');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 10) {
    // Provisional per-tab remaps (#170). A SessionStart-hook remap (e.g. after
    // `/clear`) names the tab's NEW claude session before that session has
    // written any transcript. If that id turns out to be a phantom (the cleared
    // session is abandoned with zero turns), committing it black-holes the tab:
    // every per-tab lookup resolves a rowless session → null title, dropped from
    // the Open list, blank observability. So an unconfirmed remap is parked here
    // instead of overwriting the live mapping, and promoted to
    // claude_session_id only once its session actually ingests a line.
    d.exec(`ALTER TABLE broker_sessions ADD COLUMN pending_claude_session_id TEXT`);
    d.pragma('user_version = 10');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 11) {
    // Perf telemetry (docs/superpowers/specs/2026-08-07-perf-telemetry-design.md):
    // event-loop stalls, slow-op spans, PTY throughput windows, and (Phase 2)
    // terminal latency samples. Local-only; 7-day retention enforced by
    // PerfStore.prune at startup. workspace_id scopes MCP snapshot copies;
    // NULL = app-global row (stalls, slow ops) visible to every caller.
    d.exec(`
      CREATE TABLE perf_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        kind         TEXT NOT NULL,      -- stall | slow_op | pty_window | input_hop | output_hop | echo_rtt | gc
        workspace_id TEXT,
        session_id   TEXT,
        name         TEXT,               -- span/metric name for slow_op / pty_window
        dur_ms       REAL,
        trace_id     TEXT,
        span_id      TEXT,
        meta         TEXT                -- JSON: span attrs, p50/p99/max, window values
      );
      CREATE INDEX idx_perf_events_ts ON perf_events(ts);
      CREATE INDEX idx_perf_events_kind_ts ON perf_events(kind, ts);
    `);
    d.pragma('user_version = 11');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 12) {
    // first_user_message rows written before the synthetic-prompt filters —
    // or by older claude CLIs that emit the local-command caveat without its
    // wrapper tag — hold a wrapper blob as the permanent fallback title
    // (COALESCE means they never heal, and re-ingest dedupes). One-time
    // repair: recompute from stored events; sessions with no real prompt drop
    // back to NULL so the UI's untitled fallback applies.
    repairSyntheticFirstUserMessages(d);
    d.pragma('user_version = 12');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 13) {
    // session_costs: incrementally-maintained lifetime token rollup (#383).
    // Kills the full-history SUM(...) scans that dominated main-thread stalls
    // (#382). Key columns use '' for NULL model/service_tier (SQLite PKs
    // treat NULLs as distinct); readers map back with NULLIF(col, '').
    // Invariant: ≡ GROUP BY over events at every commit boundary — pinned by
    // dbSessionCosts.test.ts. DROP+rebuild here is the drift self-heal: any
    // future schema bump reconstructs the table from ground truth.
    d.exec(`
      DROP TABLE IF EXISTS session_costs;
      CREATE TABLE session_costs (
        session_id                  TEXT NOT NULL,
        workspace_id                TEXT NOT NULL,
        model                       TEXT NOT NULL DEFAULT '',
        service_tier                TEXT NOT NULL DEFAULT '',
        input_tokens                INTEGER NOT NULL DEFAULT 0,
        output_tokens               INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        event_count                 INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, workspace_id, model, service_tier)
      );
      CREATE INDEX idx_session_costs_workspace ON session_costs(workspace_id);
      INSERT INTO session_costs (session_id, workspace_id, model, service_tier,
        input_tokens, output_tokens, cache_read_input_tokens,
        cache_creation_input_tokens, event_count)
      SELECT session_id, workspace_id, COALESCE(model, ''), COALESCE(service_tier, ''),
             COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
             COALESCE(SUM(cache_read_input_tokens), 0),
             COALESCE(SUM(cache_creation_input_tokens), 0), COUNT(id)
      FROM events
      GROUP BY session_id, workspace_id, COALESCE(model, ''), COALESCE(service_tier, '');
    `);
    d.pragma('user_version = 13');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 14) {
    // (session_id, type) composite index + two summary-stat rollups (#390).
    // The observedMax query (session_id + type='assistant') previously hit
    // idx_events_type and scanned every assistant row in the table (#386:
    // 84k rows for one session's 4; 56ms → 3ms with this index). The
    // rollups remove the remaining O(session-history) reads from the
    // summary path entirely. Same invariants + rebuild-on-migration
    // self-heal as session_costs (v13): ≡ recomputing from events at every
    // commit boundary, pinned by dbSessionStats.test.ts.
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type);

      DROP TABLE IF EXISTS session_stats;
      CREATE TABLE session_stats (
        session_id          TEXT PRIMARY KEY,
        max_context_tokens  INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO session_stats (session_id, max_context_tokens)
      SELECT session_id,
             COALESCE(MAX(
               COALESCE(input_tokens, 0)
               + COALESCE(cache_read_input_tokens, 0)
               + COALESCE(cache_creation_input_tokens, 0)
             ), 0)
      FROM events WHERE type = 'assistant'
      GROUP BY session_id;

      DROP TABLE IF EXISTS session_tool_counts;
      CREATE TABLE session_tool_counts (
        session_id  TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        count       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, tool_name)
      );
      INSERT INTO session_tool_counts (session_id, tool_name, count)
      SELECT session_id, tool_name, COUNT(*)
      FROM events WHERE tool_name IS NOT NULL
      GROUP BY session_id, tool_name;
    `);
    d.pragma('user_version = 14');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 15) {
    // One row per port appearance: declared (expose_port) and/or scanned.
    // Read via fleet-state `query` to measure missed declarations.
    // IF NOT EXISTS: a lower-version self-heal rewind (v13/v14 tests) replays
    // this block too since migrate() cascades forward from current version.
    d.exec(`
      CREATE TABLE IF NOT EXISTS port_exposures (
        id               TEXT PRIMARY KEY,
        workspace_id     TEXT NOT NULL,
        session_id       TEXT,
        port             INTEGER NOT NULL,
        cmdline          TEXT,
        label            TEXT,
        reason           TEXT,
        source           TEXT NOT NULL,
        first_scanned_at INTEGER,
        declared_at      INTEGER,
        popup_shown_at   INTEGER,
        outcome          TEXT,
        opened_via       TEXT,
        open_count       INTEGER NOT NULL DEFAULT 0,
        ended_at         INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_port_exposures_workspace ON port_exposures(workspace_id, port);
      CREATE INDEX IF NOT EXISTS idx_port_exposures_ended ON port_exposures(ended_at);
    `);
    d.pragma('user_version = 15');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 16) {
    // Retention (SPEC §7 *Retention*). ADD COLUMN is O(1); no events index is
    // added, since building one would read the whole table here.
    const cols = d.prepare(`PRAGMA table_info(events)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'raw_z')) d.exec(`ALTER TABLE events ADD COLUMN raw_z BLOB`);
    d.exec(`
      CREATE TABLE IF NOT EXISTS event_retention (
        session_id        TEXT PRIMARY KEY,
        workspace_id      TEXT NOT NULL,
        compressed_before INTEGER NOT NULL DEFAULT 0,
        stripped_before   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_event_retention_workspace ON event_retention(workspace_id);
      CREATE TABLE IF NOT EXISTS maintenance (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    d.pragma('user_version = 16');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 17) {
    // Attachment dedupe (SPEC §7 *Attachment dedupe*). refs is counted on
    // write; the triggers release it on every delete and att_ref change, so
    // no events(att_ref) index is needed.
    const cols = d.prepare(`PRAGMA table_info(events)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'att_ref')) d.exec(`ALTER TABLE events ADD COLUMN att_ref TEXT`);
    d.exec(`
      CREATE TABLE IF NOT EXISTS event_blobs (
        hash   TEXT PRIMARY KEY,
        body_z BLOB NOT NULL,
        bytes  INTEGER NOT NULL,
        refs   INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS events_att_ref_ad AFTER DELETE ON events WHEN old.att_ref IS NOT NULL BEGIN
        UPDATE event_blobs SET refs = refs - 1 WHERE hash = old.att_ref;
        DELETE FROM event_blobs WHERE hash = old.att_ref AND refs <= 0;
      END;
      CREATE TRIGGER IF NOT EXISTS events_att_ref_au AFTER UPDATE OF att_ref ON events
        WHEN old.att_ref IS NOT NULL AND (new.att_ref IS NULL OR new.att_ref <> old.att_ref) BEGIN
        UPDATE event_blobs SET refs = refs - 1 WHERE hash = old.att_ref;
        DELETE FROM event_blobs WHERE hash = old.att_ref AND refs <= 0;
      END;
    `);
    d.pragma('user_version = 17');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 18) {
    // Ingest resume points (SPEC §7 *Transcript offsets*).
    d.exec(`
      CREATE TABLE IF NOT EXISTS transcript_offsets (
        path         TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        byte_offset  INTEGER NOT NULL,
        tail_len     INTEGER NOT NULL,
        tail_hash    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_offsets_workspace ON transcript_offsets(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_transcript_offsets_session ON transcript_offsets(session_id);
    `);
    d.pragma('user_version = 18');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 19) {
    // Postgres step 19 adds id to idx_events_session_type; here the index
    // already ends in the rowid (= id). Version-only, so imports stay in step.
    d.pragma('user_version = 19');
  }

  if ((d.pragma('user_version', { simple: true }) as number) < 20) {
    // Transcript publish (SPEC §7 *Transcript publish*).
    const cols = d.prepare(`PRAGMA table_info(usage_events)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'origin')) d.exec(`ALTER TABLE usage_events ADD COLUMN origin TEXT`);
    d.exec(`
      CREATE TABLE IF NOT EXISTS publish_cursors (
        source_workspace_id TEXT NOT NULL,
        target_workspace_id TEXT NOT NULL,
        last_event_id       INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        PRIMARY KEY (source_workspace_id, target_workspace_id)
      );
      CREATE TABLE IF NOT EXISTS publish_withheld (
        session_id   TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        withheld_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_publish_withheld_workspace ON publish_withheld(workspace_id);
    `);
    d.pragma('user_version = 20');
  }
}

function repairSyntheticFirstUserMessages(d: Database.Database): void {
  const sessions = d
    .prepare(`SELECT id, first_user_message FROM sessions WHERE first_user_message IS NOT NULL`)
    .all() as { id: string; first_user_message: string }[];
  const poisoned = sessions.filter((s) => isSyntheticPromptText(s.first_user_message));
  if (poisoned.length === 0) return;
  const eventsFor = d.prepare(
    `SELECT type, raw_jsonl FROM events
     WHERE session_id = ? AND type IN ('user', 'last-prompt') ORDER BY id`,
  );
  const update = d.prepare(`UPDATE sessions SET first_user_message = ? WHERE id = ?`);
  for (const session of poisoned) {
    let replacement: string | null = null;
    for (const row of eventsFor.iterate(session.id) as IterableIterator<{
      type: string;
      raw_jsonl: string;
    }>) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.raw_jsonl) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.isMeta === true) continue;
      const message = (parsed.message ?? null) as Record<string, unknown> | null;
      const text = row.type === 'last-prompt' ? parsed.lastPrompt : message?.content;
      if (typeof text !== 'string' || isSyntheticPromptText(text)) continue;
      replacement = text;
      break;
    }
    update.run(replacement, session.id);
  }
}

// ── Ingest ────────────────────────────────────────────────────────────────

export interface IngestResult {
  inserted: boolean;       // false when the event was a duplicate
  sessionId: string;
  type: string;
}

/** Lines per ingest transaction. One commit per chunk instead of one per line;
 *  between chunks the batch yields one macrotask so a large re-read (startup,
 *  compaction) does not hold the event loop for the whole file. */
export const INGEST_TX_LINES = 500;

const yieldMacrotask = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/**
 * Ingest a batch of JSONL lines from ONE file (so one workspace + session; both
 * derived from the file path on disk — JSONL light events sometimes omit
 * sessionId, so the path is authoritative). Lines are applied strictly in
 * order with per-line semantics; each chunk's sessions-row upserts are folded
 * into one write (foldSessionTouch), which yields the same row. Every
 * `INGEST_TX_LINES` lines are one transaction. Returns one result per input
 * line, in input order (`type: 'malformed'` for unparseable lines).
 *
 * Callers must not run two batches for the same file concurrently — the
 * watcher's per-file queue guarantees that (jsonlWatcher.ts).
 *
 * `opts.atStart` runs first in every chunk transaction. `opts.inTx` runs as
 * the chunk transaction's last statement, so its writes commit or roll back
 * with the rows; it needs at most one chunk of lines.
 */
/** Two-int advisory keyspace class for per-session ingest (pgMigrate/bootstrap use the one-bigint keyspace). */
const INGEST_SESSION_LOCK = 7_340_213;

export async function ingestBatch(
  workspaceId: string,
  sessionId: string,
  rawLines: readonly string[],
  opts: { atStart?: (trx: Transaction<StateDb>) => Promise<void>; inTx?: (trx: Transaction<StateDb>) => Promise<void> } = {},
): Promise<IngestResult[]> {
  if (opts.inTx && rawLines.length > INGEST_TX_LINES) {
    throw new Error(`ingestBatch with inTx takes at most INGEST_TX_LINES (${INGEST_TX_LINES}) lines, got ${rawLines.length}`);
  }
  const results: IngestResult[] = [];
  const key = pendingKey(workspaceId, sessionId);
  for (let start = 0; start < rawLines.length; start += INGEST_TX_LINES) {
    if (start > 0) await yieldMacrotask();
    const k = kyselyOrThrow();
    const chunk = rawLines.slice(start, start + INGEST_TX_LINES);
    let promoted = false;
    let anyParsed = false;
    let chunkResults: IngestResult[];
    try {
      chunkResults = await k.transaction().execute(async (trx) => {
        // Event ids must commit in id order per session (unembeddedTurnEvents reads
        // past the newest embedded turn). In process the write lock already does
        // this; the advisory lock covers a second writer process on one database.
        if (dialect === 'postgres') await sql`SELECT pg_advisory_xact_lock(${INGEST_SESSION_LOCK}::int, hashtext(${sessionId}))`.execute(trx);
        await opts.atStart?.(trx);
        const lines = chunk.map((rawLine) => ({ rawLine, p: parseIngestLine(rawLine) }));
        anyParsed = lines.some((l) => l.p);
        if (!anyParsed) {
          await opts.inTx?.(trx);
          return lines.map(() => ({ inserted: false, sessionId, type: 'malformed' }));
        }
        const parsed = lines.flatMap((l) => (l.p ? [l.p] : []));
        // The sessions row is touched once per chunk with the folded result of
        // every line's upsert, and BEFORE the lines so per-line metadata
        // UPDATEs always find the row.
        await touchSessionQ(trx, workspaceId, sessionId, parsed.map((p) => p.ts));
        const out: IngestResult[] = [];
        for (const { rawLine, p } of lines) {
          if (!p) {
            // Malformed line — skip silently. JSONL writers occasionally
            // produce partial lines mid-write; the watcher re-reads on the
            // next change.
            out.push({ inserted: false, sessionId, type: 'malformed' });
            continue;
          }
          out.push(await ingestOne(trx, workspaceId, sessionId, rawLine, p));
          // This session now has a transcript row — promote any tab whose
          // remap was parked pending on it (#170). The in-memory guard keeps
          // this off the hot path for almost every chunk (no pending remap).
          if (!promoted && pendingClaudeIds.has(key)) {
            await promotePendingBrokerMapping(trx, workspaceId, sessionId);
            pendingClaudeIds.delete(key); // after this step's last await, inside the tx
            promoted = true;
          }
        }
        await opts.inTx?.(trx);
        return out;
      });
    } catch (err) {
      if (promoted) pendingClaudeIds.add(key); // the promotion rolled back with the chunk
      throw err;
    }
    // Cache invalidation, once per committed chunk: mark this session's
    // summary stale with a 3s grace window (ingest also updates session-row
    // fields like ai_title even on duplicate events); only clear the spend
    // cache when an event row actually landed.
    if (anyParsed) summaryCache.markStale(sessionId, SUMMARY_STALE_GRACE_MS);
    if (chunkResults.some((r) => r.inserted)) spendCache.clear();
    results.push(...chunkResults);
  }
  return results;
}

/** Single-line convenience over `ingestBatch` (tests, one-off callers). */
export async function ingestLine(workspaceId: string, sessionId: string, rawLine: string): Promise<IngestResult> {
  const [r] = await ingestBatch(workspaceId, sessionId, [rawLine]);
  return r;
}

/** One more reference to `ref`'s payload; the blob row on first use. Update
 *  first: deflating is the costly part, and nearly every call is a hit. */
async function upsertBlob(q: Kysely<StateDb>, ref: string, payload: string): Promise<void> {
  const hit = await q.updateTable('event_blobs').set((eb) => ({ refs: eb('refs', '+', 1) })).where('hash', '=', ref).executeTakeFirst();
  if (num(hit.numUpdatedRows) > 0) return;
  await q.insertInto('event_blobs')
    .values({ hash: ref, body_z: deflatePayload(payload), bytes: Buffer.byteLength(payload, 'utf8'), refs: 1 })
    .onConflict((oc) => oc.column('hash').doUpdateSet((eb) => ({ refs: eb('event_blobs.refs', '+', 1) })))
    .execute();
}

/** One parsed line's writes, on the chunk transaction: the event insert
 *  (deduped by ON CONFLICT DO NOTHING), rollups only when it landed, then
 *  per-type metadata — which runs for duplicates too. The sessions-row touch
 *  is folded per chunk by the caller (touchSessionQ). */
async function ingestOne(
  q: Kysely<StateDb>,
  workspaceId: string,
  sessionId: string,
  rawLine: string,
  p: ParsedLine,
): Promise<IngestResult> {
  const e = p.event;

  // The watcher replays every line on each start; dedupe only a line that is
  // not stored yet (one index probe), so a replay costs no stringify/hash.
  let dd: ReturnType<typeof dedupeAttachment> = null;
  if (dialect === 'sqlite' && e.type === 'attachment' && rawLine.length >= ATTACHMENT_MIN_BYTES) {
    const seen = await q.selectFrom('events').select('id')
      .where('session_id', '=', sessionId).where('dedup_key', '=', e.dedup_key).executeTakeFirst();
    if (!seen) dd = dedupeAttachment(rawLine, p.parsed);
  }
  // Always attempted, even for a replayed line: an ignored INSERT still
  // advances AUTOINCREMENT, which event ids depend on.
  const ins = await q
    .insertInto('events')
    .values({ ...e, session_id: sessionId, workspace_id: workspaceId, raw_jsonl: dd ? dd.stored : rawLine, att_ref: dd?.ref ?? null })
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  const inserted = num(ins.numInsertedOrUpdatedRows) > 0;
  if (inserted && dd) await upsertBlob(q, dd.ref, dd.payload);

  if (inserted) {
    // Rollups (#383/#390) ride the same transaction as the event insert and
    // run only when the event landed — duplicate replays must not double-count.
    await q
      .insertInto('session_costs')
      .values({
        session_id: sessionId,
        workspace_id: workspaceId,
        model: e.model ?? '',
        service_tier: e.service_tier ?? '',
        input_tokens: e.input_tokens ?? 0,
        output_tokens: e.output_tokens ?? 0,
        cache_read_input_tokens: e.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: e.cache_creation_input_tokens ?? 0,
        event_count: 1,
      })
      .onConflict((oc) =>
        oc.columns(['session_id', 'workspace_id', 'model', 'service_tier']).doUpdateSet((eb) => ({
          input_tokens: eb('session_costs.input_tokens', '+', eb.ref('excluded.input_tokens')),
          output_tokens: eb('session_costs.output_tokens', '+', eb.ref('excluded.output_tokens')),
          cache_read_input_tokens: eb('session_costs.cache_read_input_tokens', '+', eb.ref('excluded.cache_read_input_tokens')),
          cache_creation_input_tokens: eb('session_costs.cache_creation_input_tokens', '+', eb.ref('excluded.cache_creation_input_tokens')),
          event_count: eb('session_costs.event_count', '+', 1),
        })),
      )
      .execute();
    if (e.type === 'assistant') {
      await q
        .insertInto('session_stats')
        .values({
          session_id: sessionId,
          max_context_tokens: (e.input_tokens ?? 0) + (e.cache_read_input_tokens ?? 0) + (e.cache_creation_input_tokens ?? 0),
        })
        .onConflict((oc) =>
          oc.column('session_id').doUpdateSet((eb) => ({
            max_context_tokens: eb
              .case()
              .when('excluded.max_context_tokens', '>', eb.ref('session_stats.max_context_tokens'))
              .then(eb.ref('excluded.max_context_tokens'))
              .else(eb.ref('session_stats.max_context_tokens'))
              .end(),
          })),
        )
        .execute();
    }
    if (e.tool_name != null) {
      await q
        .insertInto('session_tool_counts')
        .values({ session_id: sessionId, tool_name: e.tool_name, count: 1 })
        .onConflict((oc) =>
          oc.columns(['session_id', 'tool_name']).doUpdateSet((eb) => ({
            count: eb('session_tool_counts.count', '+', 1),
          })),
        )
        .execute();
    }
  }

  // Derive per-event metadata into the sessions row.
  const parsed = p.parsed;
  const message = p.message;
  // A re-sent published line (no insert) must not roll back a title or prompt set by a newer one.
  const published = workspaceId.startsWith(PARTITION_PREFIX);
  const titleOk = inserted || !published;
  if (p.type === 'system' && typeof parsed.cwd === 'string') {
    await q.updateTable('sessions').set({ cwd: parsed.cwd }).where('id', '=', sessionId).where('cwd', 'is', null).execute();
  } else if (titleOk && p.type === 'ai-title' && typeof parsed.aiTitle === 'string') {
    await q.updateTable('sessions').set({ ai_title: parsed.aiTitle }).where('id', '=', sessionId).execute();
  } else if (titleOk && p.type === 'last-prompt' && typeof parsed.lastPrompt === 'string' && !isSyntheticPromptText(parsed.lastPrompt)) {
    await setFirstUserMessage(q, sessionId, parsed.lastPrompt);
  } else if (
    titleOk &&
    p.type === 'user' &&
    parsed.isMeta !== true &&
    typeof message?.content === 'string' &&
    !isSyntheticPromptText(message.content)
  ) {
    await setFirstUserMessage(q, sessionId, message.content);
  } else if (p.type === 'session-summary' && typeof parsed.summary === 'string') {
    const toEpoch = (v: unknown): number | null => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : null;
    };
    await q
      .insertInto('session_summaries')
      .values({
        session_id: sessionId,
        workspace_id: workspaceId,
        summary: parsed.summary,
        tags: Array.isArray(parsed.tags) ? JSON.stringify(parsed.tags) : null,
        source_max_event_id: await maxEventIdQ(q, sessionId),
        from_ts: toEpoch(parsed.fromEventTs),
        to_ts: toEpoch(parsed.toEventTs),
        model: typeof parsed.model === 'string' ? parsed.model : null,
        generated_at: p.ts ?? Date.now(),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    if (Array.isArray(parsed.tags)) {
      for (const tag of parsed.tags) {
        if (typeof tag === 'string' && tag.trim()) {
          await q
            .insertInto('session_tags')
            .values({ workspace_id: workspaceId, session_id: sessionId, tag: tag.trim().toLowerCase() })
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
      }
    }
  }

  // Rate-limit anchors (#plan-usage): the account-wide-true checkpoints.
  // Only on a genuinely-new insert so re-reads after compaction don't re-fire.
  // Published lines are other people's limits, not this account's.
  if (inserted && !published) {
    const at = p.ts ?? Date.now();
    const anchor = extractAnchor(parsed, at, p.dedupKey);
    if (anchor) await insertUsageAnchorQ(q, workspaceId, sessionId, at, anchor);
  }

  return { inserted, sessionId, type: p.type };
}

/** Apply `foldSessionTouch` over a chunk's timestamps: one read + one write
 *  instead of one upsert per line. */
async function touchSessionQ(
  q: Kysely<StateDb>,
  workspaceId: string,
  sessionId: string,
  tss: Array<number | null>,
): Promise<void> {
  const prev = await q
    .selectFrom('sessions')
    .select(['started_at', 'last_active_at'])
    .where('id', '=', sessionId)
    .executeTakeFirst();
  const next = foldSessionTouch(prev, tss);
  if (!next) return;
  if (!prev) {
    await q.insertInto('sessions').values({ id: sessionId, workspace_id: workspaceId, ...next }).execute();
  } else if (next.started_at !== prev.started_at || next.last_active_at !== prev.last_active_at) {
    await q.updateTable('sessions').set(next).where('id', '=', sessionId).execute();
  }
}

async function setFirstUserMessage(q: Kysely<StateDb>, sessionId: string, text: string): Promise<void> {
  await q
    .updateTable('sessions')
    .set((eb) => ({ first_user_message: eb.fn.coalesce('first_user_message', eb.val(text)) }))
    .where('id', '=', sessionId)
    .execute();
}

async function maxEventIdQ(q: Kysely<StateDb>, sessionId: string): Promise<number> {
  const row = await q
    .selectFrom('events')
    .select((eb) => eb.fn.coalesce(eb.fn.max('id'), eb.lit(0)).as('m'))
    .where('session_id', '=', sessionId)
    .executeTakeFirstOrThrow();
  return num(row.m);
}

// ── Queries ───────────────────────────────────────────────────────────────

export interface EventRow {
  id: number;
  sessionId: string;
  workspaceId: string;
  ts: number | null;
  type: string;
  subtype: string | null;
  uuid: string | null;
  parentUuid: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  serviceTier: string | null;
  toolName: string | null;
  rawJsonl: string;
}

interface EventRowSql {
  id: number;
  session_id: string;
  workspace_id: string;
  ts: number | null;
  type: string;
  subtype: string | null;
  uuid: string | null;
  parent_uuid: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  service_tier: string | null;
  tool_name: string | null;
  raw_jsonl: string;
  raw_z: Buffer | null;
  att_ref: string | null;
}

function rowFromSql(r: EventRowSql, blobs: ReadonlyMap<string, Buffer>): EventRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    workspaceId: r.workspace_id,
    ts: r.ts,
    type: r.type,
    subtype: r.subtype,
    uuid: r.uuid,
    parentUuid: r.parent_uuid,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadInputTokens: r.cache_read_input_tokens,
    cacheCreationInputTokens: r.cache_creation_input_tokens,
    serviceTier: r.service_tier,
    toolName: r.tool_name,
    rawJsonl: expandLine(rawLine(r), r.att_ref, r.att_ref ? blobs.get(r.att_ref) ?? null : null),
  };
}

/** Each distinct blob once per page: a session repeats the same few payloads. */
async function blobsFor(k: Kysely<StateDb>, rows: readonly { att_ref: string | null }[]): Promise<Map<string, Buffer>> {
  const refs = [...new Set(rows.flatMap((r) => (r.att_ref ? [r.att_ref] : [])))];
  const blobs = new Map<string, Buffer>();
  for (const part of chunked(refs, 500)) {
    for (const b of await k.selectFrom('event_blobs').select(['hash', 'body_z']).where('hash', 'in', part).execute()) blobs.set(b.hash, b.body_z);
  }
  return blobs;
}

export async function eventsForSession(sessionId: string, sinceEventId = 0, limit = 500): Promise<EventRow[]> {
  const k = kyselyOrThrow();
  const rows = await k
    .selectFrom('events')
    .selectAll()
    .where('session_id', '=', sessionId)
    .where('id', '>', sinceEventId)
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  const blobs = await blobsFor(k, rows);
  return rows.map((r) => rowFromSql(r, blobs));
}

export interface SessionRow {
  id: string;
  workspaceId: string;
  cwd: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  aiTitle: string | null;
  firstUserMessage: string | null;
  userSetName: string | null;
}

export async function getSession(id: string): Promise<SessionRow | null> {
  const row = await kyselyOrThrow().selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    cwd: row.cwd,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    aiTitle: row.ai_title,
    firstUserMessage: row.first_user_message,
    userSetName: row.user_set_name,
  };
}

// ── Workspace summary ─────────────────────────────────────────────────────

export interface ToolCallCount {
  name: string;
  count: number;
}

export interface ToolCall {
  name: string;
  /** Short input summary (command / path / pattern / …), or null. */
  input: string | null;
  /** tool_use→tool_result wall time in ms; null while still pending. */
  durationMs: number | null;
  /** 'ok' / 'error' once the result lands, 'pending' until then. */
  status: 'ok' | 'error' | 'pending';
  ts: number | null;
}

export interface WorkspaceSummary {
  /** Latest active Claude session UUID in the workspace, or null if none. */
  sessionId: string | null;
  /** Display title — from `ai-title.aiTitle` if present, else the session's first user message head. */
  title: string | null;
  /** Latest assistant.message.model seen in this session. */
  model: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  /** Row count for this session in `events`. */
  eventCount: number;
  /** Per-session token sums (assistant events only). */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Total USD across all events in the session — see `getCost`. */
  usd: number;
  /**
   * Context-window fullness proxy: the latest assistant event's
   * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
   * Represents how much of the model's context window the most recent
   * turn used. Pair with `contextWindowTokens` for the displayed
   * percentage. Null when no assistant event has been seen yet.
   */
  lastTurnContextTokens: number | null;
  /**
   * Effective context window for this session in tokens — 200K for stock
   * Claude 4.x, 1M when the model id carries the `[1m]` marker OR when
   * any observed turn already exceeded 200K (the 1M beta is request-time
   * and doesn't always show up in the model string). The renderer
   * divides `lastTurnContextTokens` by this to position the
   * terminal-pane context-bar fill.
   */
  contextWindowTokens: number;
  /** Top tools called in this session, descending count. */
  topTools: ToolCallCount[];
  /** Recent tool calls with input/duration/status, newest first. */
  recentToolCalls: ToolCall[];
  /** Per-turn USD cost over recent turns, oldest→newest (sparkline series). */
  costSeries: number[];
  /** Per-turn total tokens over recent turns, oldest→newest — the cost
   *  sparkline's sibling, shown when the rail's graph is toggled to tokens. */
  tokenSeries: number[];
}

/**
 * Single-shot query for the renderer's right-rail pane: pick the
 * most-recently-active session in this workspace, then assemble its
 * token totals + top tools + metadata. Returns null when the workspace
 * has no JSONL events at all yet.
 */
/** The workspace's most-recently-active session id, or null when it has none
 *  (ORDER BY COALESCE(last_active_at, 0) DESC, as listSessions). Shared by
 *  `summaryForWorkspace` and `committeeCollect`, which otherwise paid for the
 *  full `listSessions` rollup (cost rows + tags) just to read `[0].id`. */
export async function latestSessionId(workspaceId: string): Promise<string | null> {
  const row = await kyselyOrThrow()
    .selectFrom('sessions')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .orderBy((eb) => eb.fn.coalesce('last_active_at', eb.lit(0)), 'desc')
    .orderBy('id', 'asc')
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function summaryForWorkspace(workspaceId: string, topToolsLimit = 5): Promise<WorkspaceSummary | null> {
  const latestId = await latestSessionId(workspaceId);
  if (!latestId) return null;
  return summaryForSession(latestId, topToolsLimit);
}

/**
 * Total tokens spent across the **whole fleet** within a trailing time window —
 * the numerator for the observability rail's plan-usage bar. Sums every token
 * type (input + output + cache create + cache read), since Anthropic's rolling
 * subscription limit meters against all of them. `sinceMs` is an absolute epoch
 * floor in ms (the caller passes `Date.now() - windowMs`); as the oldest events
 * age past it they drop out of the sum, mirroring the real rolling reset.
 */
async function tokensSpentSinceUncached(sinceMs: number): Promise<number> {
  const { rows } = await tokensSpentSinceQuery(sinceMs).execute(kyselyOrThrow());
  return num(rows[0]?.total ?? 0);
}

/** events has no ts index, and `ts >= ?` alone scans the whole table. Skip-scan
 *  the session ids out of idx_events_session_ts, then range-read each session's
 *  window through the same index. Exported for the plan test. */
export function tokensSpentSinceQuery(sinceMs: number) {
  return sql<{ total: number }>`
    WITH RECURSIVE s(id) AS (
      SELECT (SELECT min(session_id) FROM events)
      UNION ALL
      SELECT (SELECT min(session_id) FROM events WHERE session_id > s.id) FROM s WHERE s.id IS NOT NULL
    )
    SELECT COALESCE(SUM(
      COALESCE(e.input_tokens, 0) + COALESCE(e.output_tokens, 0) +
      COALESCE(e.cache_read_input_tokens, 0) + COALESCE(e.cache_creation_input_tokens, 0)
    ), 0) AS total
    FROM s JOIN events e ON e.session_id = s.id AND e.ts >= ${sinceMs}`;
}

export async function summaryForSession(
  sessionId: string,
  topToolsLimit = DEFAULT_TOP_TOOLS,
): Promise<WorkspaceSummary | null> {
  if (topToolsLimit !== DEFAULT_TOP_TOOLS) return summaryForSessionUncached(sessionId, topToolsLimit);
  // The cached object is shared by every caller until invalidation. Freeze it
  // (shallow) so a future consumer that decorates the summary throws instead
  // of silently corrupting the cache for every window. Callers that need to
  // modify must copy.
  return summaryCache.get(sessionId, async () => {
    const summary = await summaryForSessionUncached(sessionId, topToolsLimit);
    return summary === null ? null : Object.freeze(summary);
  });
}

export async function tokensSpentSince(sinceMs: number): Promise<number> {
  // 15s bucket key: freshness emerges from the keying (a stale bucket is
  // simply never asked for again); staleness is capped at 15s against the
  // budget bar's 60s poll. Ingest/delete clear the cache outright.
  return spendCache.get(String(Math.floor(sinceMs / 15_000)), () => tokensSpentSinceUncached(sinceMs));
}

// Exported so the EXPLAIN QUERY PLAN tests in dbSessionStats.test.ts pin the
// compiled SQL of the real queries and assert the two rollup queries never
// touch events. latestAssistant reads events via a session-prefixed index.
export function observedMaxQuery(q: Kysely<StateDb>, sessionId: string) {
  return q.selectFrom('session_stats').select('max_context_tokens').where('session_id', '=', sessionId);
}
export function topToolsQuery(q: Kysely<StateDb>, sessionId: string, limit: number) {
  return q
    .selectFrom('session_tool_counts')
    .select(['tool_name as name', 'count'])
    .where('session_id', '=', sessionId)
    .orderBy('count', 'desc')
    .orderBy('tool_name')
    .limit(limit);
}
export function latestAssistantQuery(q: Kysely<StateDb>, sessionId: string) {
  return q
    .selectFrom('events')
    .select((eb) => [
      'model',
      eb.fn.coalesce('input_tokens', eb.lit(0)).as('input_tokens'),
      eb.fn.coalesce('cache_read_input_tokens', eb.lit(0)).as('cache_read_input_tokens'),
      eb.fn.coalesce('cache_creation_input_tokens', eb.lit(0)).as('cache_creation_input_tokens'),
    ])
    .where('session_id', '=', sessionId)
    .where('type', '=', 'assistant')
    .where('model', 'is not', null)
    .orderBy('id', 'desc')
    .limit(1);
}

/**
 * Same shape as `summaryForWorkspace`, but scoped to one specific claude
 * session UUID — the per-tab endpoint reaches here via
 * `summaryForBrokerSession` after resolving the broker→claude mapping.
 * Returns null when the session id has no rows in `sessions` (mapping
 * stale, claude exited and the user wiped state, etc.).
 *
 * One read transaction: the eight queries see one consistent state (no
 * ingest chunk commits between them).
 */
async function summaryForSessionUncached(
  sessionId: string,
  topToolsLimit = DEFAULT_TOP_TOOLS,
): Promise<WorkspaceSummary | null> {
  summaryRecomputes++;
  return readTransaction(kyselyOrThrow(), async (trx) => {
    const session = await trx
      .selectFrom('sessions')
      .select(['id', 'ai_title', 'first_user_message', 'started_at', 'last_active_at'])
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session) return null;

    const aggregates = await trx
      .selectFrom('session_costs')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<number>('event_count'), eb.lit(0)).as('event_count'),
        eb.fn.coalesce(eb.fn.sum<number>('input_tokens'), eb.lit(0)).as('input_tokens'),
        eb.fn.coalesce(eb.fn.sum<number>('output_tokens'), eb.lit(0)).as('output_tokens'),
        eb.fn.coalesce(eb.fn.sum<number>('cache_read_input_tokens'), eb.lit(0)).as('cache_read_input_tokens'),
        eb.fn.coalesce(eb.fn.sum<number>('cache_creation_input_tokens'), eb.lit(0)).as('cache_creation_input_tokens'),
      ])
      .where('session_id', '=', session.id)
      .executeTakeFirstOrThrow();

    // Latest assistant event drives both the displayed model and the
    // context-window fullness proxy (idx_events_session_type seek + LIMIT 1).
    const latestAssistant = await latestAssistantQuery(trx, session.id).executeTakeFirst();
    const lastTurnContextTokens = latestAssistant
      ? latestAssistant.input_tokens +
        latestAssistant.cache_read_input_tokens +
        latestAssistant.cache_creation_input_tokens
      : null;

    // Observed-max context tokens from the session_stats rollup; drives the 1M
    // auto-upgrade in contextWindowFor. Absent row ⇒ 0.
    const observedMax = (await observedMaxQuery(trx, session.id).executeTakeFirst()) ?? { max_context_tokens: 0 };
    const contextWindowTokens = contextWindowFor(latestAssistant?.model ?? null, observedMax.max_context_tokens);

    // topTools from the session_tool_counts rollup; ties ordered by tool_name.
    const topTools: ToolCallCount[] = await topToolsQuery(trx, session.id, topToolsLimit).execute();

    const cost = await costForSessionQ(trx, session.id);

    return {
      sessionId: session.id,
      title:
        session.ai_title ??
        (session.first_user_message ? session.first_user_message.slice(0, 80) : null),
      model: latestAssistant?.model ?? null,
      startedAt: session.started_at,
      lastActiveAt: session.last_active_at,
      eventCount: num(aggregates.event_count),
      inputTokens: num(aggregates.input_tokens),
      outputTokens: num(aggregates.output_tokens),
      cacheReadInputTokens: num(aggregates.cache_read_input_tokens),
      cacheCreationInputTokens: num(aggregates.cache_creation_input_tokens),
      usd: cost.usd,
      lastTurnContextTokens,
      contextWindowTokens,
      topTools,
      recentToolCalls: await recentToolCallsQ(trx, session.id, 10),
      costSeries: await costSeriesQ(trx, session.id, 20),
      tokenSeries: await tokenSeriesQ(trx, session.id, 20),
    };
  });
}

/**
 * Recent tool calls in a session, newest first. Each tool_use is matched to
 * its tool_result by tool_use_id (within the session) to derive duration and
 * ok/error status; calls still awaiting a result come back 'pending'.
 */
export async function recentToolCallsForSession(sessionId: string, limit = 10): Promise<ToolCall[]> {
  return recentToolCallsQ(kyselyOrThrow(), sessionId, limit);
}

// Exported for the EXPLAIN QUERY PLAN pin in dbSessionStats.test.ts.
export function recentToolCallsQuery(q: Kysely<StateDb>, sessionId: string, limit: number) {
  return q
    .selectFrom('events as u')
    .leftJoin('events as r', (j) =>
      j
        .onRef('r.session_id', '=', 'u.session_id')
        .onRef('r.tool_use_id', '=', 'u.tool_use_id')
        .on('r.tool_result_is_error', 'is not', null),
    )
    .select([
      'u.tool_name as name',
      'u.tool_input as input',
      'u.ts as start_ts',
      'r.ts as end_ts',
      'r.tool_result_is_error as is_error',
    ])
    .where('u.session_id', '=', sessionId)
    // tool_use blocks only come on assistant lines; the type term lets the
    // (session_id, type) index walk newest-first and stop at `limit` (#583).
    .where('u.type', '=', 'assistant')
    .where('u.tool_name', 'is not', null)
    .where('u.tool_use_id', 'is not', null)
    .orderBy('u.id', 'desc')
    .limit(limit);
}

async function recentToolCallsQ(q: Kysely<StateDb>, sessionId: string, limit: number): Promise<ToolCall[]> {
  const rows = await recentToolCallsQuery(q, sessionId, limit).execute();
  return rows.map((r) => ({
    name: r.name as string,
    input: r.input,
    durationMs: r.start_ts != null && r.end_ts != null ? r.end_ts - r.start_ts : null,
    status: r.is_error == null ? 'pending' : r.is_error ? 'error' : 'ok',
    ts: r.start_ts,
  }));
}

/**
 * Per-turn USD cost over the last `limit` assistant turns, oldest→newest —
 * the series a cost sparkline plots. Each assistant event with usage is one
 * turn; cost is computed per row so mixed models/tiers price correctly.
 */
export async function costSeriesForSession(sessionId: string, limit = 20): Promise<number[]> {
  return costSeriesQ(kyselyOrThrow(), sessionId, limit);
}

async function costSeriesQ(q: Kysely<StateDb>, sessionId: string, limit: number): Promise<number[]> {
  const rows = await q
    .selectFrom('events')
    .select((eb) => [
      'model',
      'service_tier',
      eb.fn.coalesce('input_tokens', eb.lit(0)).as('input_tokens'),
      eb.fn.coalesce('output_tokens', eb.lit(0)).as('output_tokens'),
      eb.fn.coalesce('cache_read_input_tokens', eb.lit(0)).as('cache_read_input_tokens'),
      eb.fn.coalesce('cache_creation_input_tokens', eb.lit(0)).as('cache_creation_input_tokens'),
    ])
    .where('session_id', '=', sessionId)
    .where('type', '=', 'assistant')
    .where('output_tokens', 'is not', null)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows
    .reverse()
    .map((r) =>
      costFor(r.model, r.service_tier, {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadInputTokens: r.cache_read_input_tokens,
        cacheCreationInputTokens: r.cache_creation_input_tokens,
      }),
    );
}

/**
 * Per-turn total tokens (input + output + cache create + cache read) over the
 * last `limit` assistant turns, oldest→newest — the sibling of
 * `costSeriesForSession` that the observability sparkline plots when toggled
 * from cost to tokens. Same per-turn definition, so the two graphs line up.
 */
export async function tokenSeriesForSession(sessionId: string, limit = 20): Promise<number[]> {
  return tokenSeriesQ(kyselyOrThrow(), sessionId, limit);
}

async function tokenSeriesQ(q: Kysely<StateDb>, sessionId: string, limit: number): Promise<number[]> {
  const rows = await q
    .selectFrom('events')
    .select(
      sql<number>`COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
        + COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0)`.as('total'),
    )
    .where('session_id', '=', sessionId)
    .where('type', '=', 'assistant')
    .where('output_tokens', 'is not', null)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.reverse().map((r) => num(r.total));
}

// ── broker_sessions: per-tab mapping ──────────────────────────────────────
//
// Each terminal tab carries a renderer-owned `broker_session_id` (the
// uid from sessions.json the broker uses as its session map key). When
// the broker spawns claude for that tab, claude writes its JSONL under
// a different UUID — the `claude_session_id`. We learn the mapping
// once per tab (see the JsonlWatcher's onNewSession hook in ipc.ts)
// and persist it so it survives app restart.

/** Append-only value signal (#207). Scores are derived at read time (Phase 3). */
export async function recordUsageEvent(e: {
  workspaceId: string;
  sessionId?: string | null;
  kind: 'search-impression' | 'clickthrough' | 'marked-useful' | 'resumed';
  detail?: Record<string, unknown>;
  origin?: string | null;
}): Promise<void> {
  await kyselyOrThrow()
    .insertInto('usage_events')
    .values({
      ts: Date.now(),
      workspace_id: e.workspaceId,
      session_id: e.sessionId ?? null,
      kind: e.kind,
      detail: e.detail ? JSON.stringify(e.detail) : null,
      origin: e.origin ?? null,
    })
    .execute();
}

/** marked-useful marks that count (SPEC §7 *Usefulness signals*): not a workspace marking its own session, and not one of unknown origin. */
export async function usefulMarkCounts(sessionIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunked([...sessionIds], 500)) {
    const rows = await kyselyOrThrow()
      .selectFrom('usage_events')
      .select((eb) => ['session_id', eb.fn.countAll().as('n')])
      .where('kind', '=', 'marked-useful')
      .where('session_id', 'in', part)
      .where('origin', 'is not', null)
      .whereRef('origin', '<>', 'workspace_id')
      .groupBy('session_id')
      .execute();
    for (const r of rows) if (r.session_id) out.set(r.session_id, num(r.n));
  }
  return out;
}

// ── Transcript publish (SPEC §7 *Transcript publish*) ─────────────────────

export interface PublishableEvent {
  id: number;
  sessionId: string;
  rawJsonl: string;
  /** The session's `started_at`; null when it has no timestamped line yet. */
  startedAt: number | null;
}

/** `workspaceId`'s events after `afterId`, in id order. The caller filters on `startedAt`, so old rows are passed over once. */
export async function publishableEvents(workspaceId: string, afterId: number, limit: number): Promise<PublishableEvent[]> {
  const k = kyselyOrThrow();
  const rows = await k
    .selectFrom('events as e')
    .leftJoin('sessions as s', 's.id', 'e.session_id')
    .selectAll('e')
    .select('s.started_at as session_started_at')
    .where('e.workspace_id', '=', workspaceId)
    .where('e.id', '>', afterId)
    .orderBy('e.id', 'asc')
    .limit(limit)
    .execute();
  const blobs = await blobsFor(k, rows);
  return rows.map((r) => {
    const e = rowFromSql(r, blobs);
    return { id: num(e.id), sessionId: e.sessionId, rawJsonl: e.rawJsonl, startedAt: r.session_started_at == null ? null : num(r.session_started_at) };
  });
}

/** Highest event id `workspaceId` holds, 0 when none: a new publish target starts after it. */
export async function workspaceMaxEventId(workspaceId: string): Promise<number> {
  const r = await kyselyOrThrow().selectFrom('events').select((eb) => eb.fn.max('id').as('m')).where('workspace_id', '=', workspaceId).executeTakeFirst();
  return r?.m == null ? 0 : num(r.m);
}

export async function getPublishCursor(source: string, target: string): Promise<number> {
  const r = await kyselyOrThrow().selectFrom('publish_cursors').select('last_event_id')
    .where('source_workspace_id', '=', source).where('target_workspace_id', '=', target).executeTakeFirst();
  return r ? num(r.last_event_id) : 0;
}

export async function setPublishCursor(source: string, target: string, lastEventId: number): Promise<void> {
  const at = Date.now();
  await kyselyOrThrow().insertInto('publish_cursors')
    .values({ source_workspace_id: source, target_workspace_id: target, last_event_id: lastEventId, updated_at: at })
    .onConflict((oc) => oc.columns(['source_workspace_id', 'target_workspace_id']).doUpdateSet({ last_event_id: lastEventId, updated_at: at }))
    .execute();
}

export async function deletePublishCursor(source: string, target: string): Promise<void> {
  await kyselyOrThrow().deleteFrom('publish_cursors').where('source_workspace_id', '=', source).where('target_workspace_id', '=', target).execute();
}

/** A forgotten remote bookmark: no workspace keeps a cursor towards it. */
export async function deletePublishCursorsTo(target: string): Promise<void> {
  await kyselyOrThrow().deleteFrom('publish_cursors').where('target_workspace_id', '=', target).execute();
}

/** The backfill action's count (D140): publishable sessions of `workspaceId` that started in [from, below). */
export async function backfillSessionCount(workspaceId: string, from: number, below: number): Promise<number> {
  const k = kyselyOrThrow();
  const rows = await k.selectFrom('sessions').select('id').where('workspace_id', '=', workspaceId)
    .where('started_at', '>=', from).where('started_at', '<', below)
    .where('id', 'not in', k.selectFrom('publish_withheld').select('session_id').where('workspace_id', '=', workspaceId))
    .execute();
  return rows.filter((r) => SESSION_UUID_RE.test(r.id)).length;
}

export async function withholdSession(workspaceId: string, sessionId: string): Promise<void> {
  await kyselyOrThrow().insertInto('publish_withheld').values({ session_id: sessionId, workspace_id: workspaceId, withheld_at: Date.now() })
    .onConflict((oc) => oc.column('session_id').doNothing()).execute();
}

export async function withheldSessions(workspaceId: string): Promise<Set<string>> {
  const rows = await kyselyOrThrow().selectFrom('publish_withheld').select('session_id').where('workspace_id', '=', workspaceId).execute();
  return new Set(rows.map((r) => r.session_id));
}

/** True once `claudeSessionId` has ingested ≥1 transcript line (a sessions
 *  row exists). A mapping to a session that isn't yet real is a phantom — the
 *  #170 failure mode — so remap policy consults this before committing. */
async function claudeSessionIsRealQ(q: Kysely<StateDb>, claudeSessionId: string): Promise<boolean> {
  const row = await q.selectFrom('sessions').select('id').where('id', '=', claudeSessionId).executeTakeFirst();
  return row !== undefined;
}

async function existingMappingQ(
  q: Kysely<StateDb>,
  workspaceId: string,
  brokerSessionId: string,
): Promise<{ claude_session_id: string; pending_claude_session_id: string | null } | undefined> {
  return q
    .selectFrom('broker_sessions')
    .select(['claude_session_id', 'pending_claude_session_id'])
    .where('workspace_id', '=', workspaceId)
    .where('broker_session_id', '=', brokerSessionId)
    .executeTakeFirst();
}

/** The committing upsert (verified=1, pending cleared). Returns the previously
 *  committed id and the pending id it cleared, if any. */
async function commitMappingQ(
  q: Kysely<StateDb>,
  workspaceId: string,
  brokerSessionId: string,
  claudeSessionId: string,
): Promise<{ previous: string | null; clearedPending: string | null }> {
  const existing = await existingMappingQ(q, workspaceId, brokerSessionId);
  await q
    .insertInto('broker_sessions')
    .values({
      workspace_id: workspaceId,
      broker_session_id: brokerSessionId,
      claude_session_id: claudeSessionId,
      learned_at: Date.now(),
      verified: 1,
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'broker_session_id']).doUpdateSet((eb) => ({
        claude_session_id: eb.ref('excluded.claude_session_id'),
        learned_at: eb.ref('excluded.learned_at'),
        verified: 1,
        pending_claude_session_id: null,
      })),
    )
    .execute();
  return {
    previous: existing?.claude_session_id ?? null,
    clearedPending: existing?.pending_claude_session_id ?? null,
  };
}

/** Persist a (workspace, broker_session) → claude_session mapping, unconditionally
 *  and immediately (verified=1). Clears any parked pending remap for the tab —
 *  a direct commit is authoritative. Returns the claude_session_id that was
 *  previously committed (null on first learn) so callers can log a remap — an
 *  overwrite with a DIFFERENT claude id is the #195 cross-wiring event and must
 *  never happen silently.
 *
 *  This is the low-level commit. Callers reacting to a SessionStart-hook /
 *  CREATE signal should prefer `recordBrokerSessionMapping`, which parks a remap
 *  onto a not-yet-real session instead of black-holing the tab (#170).
 *
 *  `pendingClaudeIds` is mutated inside the transaction after its last await
 *  (so the next ingest transaction sees it) and restored if the commit fails. */
export async function learnBrokerSessionMapping(
  workspaceId: string,
  brokerSessionId: string,
  claudeSessionId: string,
): Promise<string | null> {
  const k = kyselyOrThrow();
  let cleared: string | null = null;
  try {
    return await k.transaction().execute(async (trx) => {
      const r = await commitMappingQ(trx, workspaceId, brokerSessionId, claudeSessionId);
      if (r.clearedPending) {
        pendingClaudeIds.delete(pendingKey(workspaceId, r.clearedPending));
        cleared = r.clearedPending;
      }
      return r.previous;
    });
  } catch (err) {
    if (cleared) pendingClaudeIds.add(pendingKey(workspaceId, cleared));
    throw err;
  }
}

/** Outcome of a `recordBrokerSessionMapping` call. `committed` — the mapping is
 *  live now. `deferred` — the tab already points at a real conversation and the
 *  new id has no transcript yet, so it's parked pending and will be promoted
 *  when it produces its first line (#170). `previous` is the id that was
 *  committed before the call, for remap logging. */
export interface BrokerMappingResult {
  mode: 'committed' | 'deferred';
  previous: string | null;
}

/** Signal-driven remap (SessionStart hook / CREATE). Commits immediately when
 *  it's safe: a fresh tab (nothing to lose), a new id that's already real, or a
 *  currently-committed id that's itself a phantom (a broken mapping must never
 *  win). Otherwise — the tab holds a real conversation and the new id hasn't
 *  written a transcript yet — the remap is parked pending so a would-be phantom
 *  (an abandoned `/clear` session) can't black-hole the tab.
 *
 *  The whole check-then-act is ONE transaction (the connection mutex makes it
 *  atomic against ingest); `pendingClaudeIds` changes happen inside it after
 *  its last await. On rollback, only keys removed are re-added — a key this
 *  call added is left in place (a harmless superset), never deleted. */
export async function recordBrokerSessionMapping(
  workspaceId: string,
  brokerSessionId: string,
  claudeSessionId: string,
): Promise<BrokerMappingResult> {
  const k = kyselyOrThrow();
  const removed: string[] = [];
  try {
    return await k.transaction().execute(async (trx): Promise<BrokerMappingResult> => {
      const existing = await existingMappingQ(trx, workspaceId, brokerSessionId);
      const previous = existing?.claude_session_id ?? null;
      const committedReal = previous != null && (await claudeSessionIsRealQ(trx, previous));
      const newReal = await claudeSessionIsRealQ(trx, claudeSessionId);

      if (previous === claudeSessionId || !committedReal || newReal) {
        const r = await commitMappingQ(trx, workspaceId, brokerSessionId, claudeSessionId);
        if (r.clearedPending) {
          pendingClaudeIds.delete(pendingKey(workspaceId, r.clearedPending));
          removed.push(r.clearedPending);
        }
        return { mode: 'committed', previous };
      }

      // Park it. Replace any earlier pending (a rapid second /clear supersedes
      // the first) and keep the committed real mapping live until this one
      // materializes.
      await trx
        .updateTable('broker_sessions')
        .set({ pending_claude_session_id: claudeSessionId })
        .where('workspace_id', '=', workspaceId)
        .where('broker_session_id', '=', brokerSessionId)
        .execute();
      if (existing?.pending_claude_session_id && existing.pending_claude_session_id !== claudeSessionId) {
        pendingClaudeIds.delete(pendingKey(workspaceId, existing.pending_claude_session_id));
        removed.push(existing.pending_claude_session_id);
      }
      // A rollback only ever re-adds keys removed above, never deletes one it
      // added: a key left behind by a failed transaction is a harmless
      // superset (one no-op UPDATE later), but deleting a key wrongly would
      // lose a real promotion.
      pendingClaudeIds.add(pendingKey(workspaceId, claudeSessionId));
      return { mode: 'deferred', previous };
    });
  } catch (err) {
    for (const id of removed) pendingClaudeIds.add(pendingKey(workspaceId, id));
    throw err;
  }
}

/** Promote a parked remap now that `claudeSessionId` has a transcript row:
 *  make it the committed mapping for whichever tab was waiting on it. Called
 *  from the ingest transaction behind the `pendingClaudeIds` guard; the caller
 *  updates the guard set. */
async function promotePendingBrokerMapping(
  q: Kysely<StateDb>,
  workspaceId: string,
  claudeSessionId: string,
): Promise<void> {
  await q
    .updateTable('broker_sessions')
    .set({
      // = pending_claude_session_id: the WHERE pins it to claudeSessionId.
      claude_session_id: claudeSessionId,
      pending_claude_session_id: null,
      learned_at: Date.now(),
      verified: 1,
    })
    .where('workspace_id', '=', workspaceId)
    .where('pending_claude_session_id', '=', claudeSessionId)
    .execute();
}

/** Resume-grade lookup: returns the claude session id only when the mapping
 *  was learned deterministically (verified=1). Pre-#198 rows were FIFO
 *  guesses — good enough to attribute cost/summaries, never good enough to
 *  `claude --resume` from: resuming a guess silently swaps the tab onto a
 *  different conversation (#195). */
export async function lookupVerifiedBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
): Promise<string | null> {
  const row = await kyselyOrThrow()
    .selectFrom('broker_sessions')
    .select('claude_session_id')
    .where('workspace_id', '=', workspaceId)
    .where('broker_session_id', '=', brokerSessionId)
    .where('verified', '=', 1)
    .executeTakeFirst();
  return row?.claude_session_id ?? null;
}

/** Resume-grade lookup that additionally requires the mapped session to have
 *  ingested ≥1 transcript line. The local backend's cross-restart auto-resume
 *  uses this: `claude --resume <uuid>` of a session that never wrote a
 *  transcript errors visibly in the tab, so an unreal session means "spawn
 *  fresh" rather than "resume". One statement, so the two checks are atomic. */
export async function lookupResumableBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
): Promise<string | null> {
  const row = await kyselyOrThrow()
    .selectFrom('broker_sessions as b')
    .select('b.claude_session_id')
    .where('b.workspace_id', '=', workspaceId)
    .where('b.broker_session_id', '=', brokerSessionId)
    .where('b.verified', '=', 1)
    .where((eb) => eb.exists(eb.selectFrom('sessions as s').select('s.id').whereRef('s.id', '=', 'b.claude_session_id')))
    .executeTakeFirst();
  return row?.claude_session_id ?? null;
}

/** Look up the claude_session_id for a broker session, or null if unmapped. */
export async function lookupBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
): Promise<string | null> {
  return (await existingMappingQ(kyselyOrThrow(), workspaceId, brokerSessionId))?.claude_session_id ?? null;
}

/**
 * Per-tab summary. Resolves the broker→claude mapping and returns that
 * session's summary, or null when no mapping is known.
 *
 * **No workspace fallback here.** A brand-new tab the user just opened
 * carries an unmapped broker session id but legitimately has no data;
 * returning the workspace's most-recently-active session in that case
 * surfaces the *previous* tab's numbers — confusing ("why does my new
 * tab already show 4K tokens?"). Renderer decides when to apply a
 * workspace fallback: tabs loaded from `sessions.json` get one (best
 * guess for tabs that pre-date this table or were skipped by the
 * concurrent-attach disambiguator); freshly-added tabs do not.
 */
export async function summaryForBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
  topToolsLimit = 5,
): Promise<WorkspaceSummary | null> {
  const claudeId = await lookupBrokerSession(workspaceId, brokerSessionId);
  if (!claudeId) return null;
  return summaryForSession(claudeId, topToolsLimit);
}

// ── Cost rollup ───────────────────────────────────────────────────────────
//
// Pricing varies by model and service_tier, so we can't just sum tokens once
// and multiply — different events within a session may use different models.
// Group by (model, service_tier), let pricing.ts compute USD per group,
// then sum.

export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  usd: number;
}

interface CostGroupRow {
  model: string | null;
  service_tier: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function rollupGroups(rows: CostGroupRow[]): SessionCost {
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  for (const r of rows) {
    inputTokens += r.input_tokens;
    outputTokens += r.output_tokens;
    cacheReadInputTokens += r.cache_read_input_tokens;
    cacheCreationInputTokens += r.cache_creation_input_tokens;
    usd += costFor(r.model, r.service_tier, {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadInputTokens: r.cache_read_input_tokens,
      cacheCreationInputTokens: r.cache_creation_input_tokens,
    });
  }
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, usd };
}

export async function costForSession(sessionId: string): Promise<SessionCost> {
  return costForSessionQ(kyselyOrThrow(), sessionId);
}

async function costForSessionQ(q: Kysely<StateDb>, sessionId: string): Promise<SessionCost> {
  const rows = await q
    .selectFrom('session_costs')
    .select((eb) => [
      eb.fn<string | null>('nullif', ['model', eb.val('')]).as('model'),
      eb.fn<string | null>('nullif', ['service_tier', eb.val('')]).as('service_tier'),
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ])
    .where('session_id', '=', sessionId)
    // Raw columns, not the nullif aliases: '' sorts first on both dialects.
    .orderBy(['workspace_id', 'session_costs.model', 'session_costs.service_tier'])
    .execute();
  return rollupGroups(rows);
}

export async function costForWorkspace(workspaceId: string): Promise<SessionCost> {
  const rows = await kyselyOrThrow()
    .selectFrom('session_costs')
    .select((eb) => [
      eb.fn<string | null>('nullif', ['model', eb.val('')]).as('model'),
      eb.fn<string | null>('nullif', ['service_tier', eb.val('')]).as('service_tier'),
      eb.fn.coalesce(eb.fn.sum<number>('input_tokens'), eb.lit(0)).as('input_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('output_tokens'), eb.lit(0)).as('output_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('cache_read_input_tokens'), eb.lit(0)).as('cache_read_input_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('cache_creation_input_tokens'), eb.lit(0)).as('cache_creation_input_tokens'),
    ])
    .where('workspace_id', '=', workspaceId)
    .groupBy(['model', 'service_tier'])
    // Raw columns, not the nullif aliases: '' sorts first on both dialects.
    .orderBy(['session_costs.model', 'session_costs.service_tier'])
    .execute();
  return rollupGroups(
    rows.map((r) => ({
      model: r.model,
      service_tier: r.service_tier,
      input_tokens: num(r.input_tokens),
      output_tokens: num(r.output_tokens),
      cache_read_input_tokens: num(r.cache_read_input_tokens),
      cache_creation_input_tokens: num(r.cache_creation_input_tokens),
    })),
  );
}

export interface PlanUsageRow {
  workspaceId: string;
  model: string | null;
  serviceTier: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Windowed app-wide usage: sums assistant-event tokens across ALL workspaces
 * in the half-open time window `[fromMs, toMs)`, grouped by
 * `(workspace_id, model, service_tier)`.
 */
export async function planUsageRows(fromMs: number, toMs: number): Promise<PlanUsageRow[]> {
  const rows = await kyselyOrThrow()
    .selectFrom('events')
    .select((eb) => [
      'workspace_id',
      'model',
      'service_tier',
      eb.fn.coalesce(eb.fn.sum<number>('input_tokens'), eb.lit(0)).as('input_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('output_tokens'), eb.lit(0)).as('output_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('cache_read_input_tokens'), eb.lit(0)).as('cache_read_input_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('cache_creation_input_tokens'), eb.lit(0)).as('cache_creation_input_tokens'),
    ])
    .where('type', '=', 'assistant')
    .where('ts', 'is not', null)
    .where('ts', '>=', fromMs)
    .where('ts', '<', toMs)
    .groupBy(['workspace_id', 'model', 'service_tier'])
    .orderBy('workspace_id')
    .orderBy('model', (ob) => ob.asc().nullsFirst())
    .orderBy('service_tier', (ob) => ob.asc().nullsFirst())
    .execute();
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    model: r.model,
    serviceTier: r.service_tier,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadInputTokens: num(r.cache_read_input_tokens),
    cacheCreationInputTokens: num(r.cache_creation_input_tokens),
  }));
}

// ── Usage anchors ─────────────────────────────────────────────────────────

export interface UsageAnchorRow {
  id: number;
  ts: number;
  workspaceId: string | null;
  sessionId: string | null;
  kind: string;
  httpStatus: number | null;
  scope: string | null;
  resetAt: number | null;
  windowStart: number | null;
  message: string | null;
}

const ANCHOR_COLUMNS = [
  'id', 'ts', 'workspace_id', 'session_id', 'kind', 'http_status', 'scope', 'reset_at', 'window_start', 'message',
] as const;
type UsageAnchorSql = Pick<Selectable<UsageAnchorsTable>, (typeof ANCHOR_COLUMNS)[number]>;

function toAnchorRow(r: UsageAnchorSql): UsageAnchorRow {
  return {
    id: r.id, ts: r.ts, workspaceId: r.workspace_id, sessionId: r.session_id,
    kind: r.kind, httpStatus: r.http_status, scope: r.scope,
    resetAt: r.reset_at, windowStart: r.window_start, message: r.message,
  };
}

async function insertUsageAnchorQ(
  q: Kysely<StateDb>,
  workspaceId: string,
  sessionId: string,
  tsMs: number,
  a: import('./usageAnchors.js').AnchorInput
): Promise<void> {
  await q
    .insertInto('usage_anchors')
    .values({
      ts: tsMs,
      workspace_id: workspaceId,
      session_id: sessionId,
      kind: a.kind,
      http_status: a.httpStatus,
      scope: a.scope,
      reset_at: a.resetAt,
      window_start: a.windowStart,
      message: a.message,
      rate_limits: a.rateLimits,
      dedup_key: a.dedupKey,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function insertUsageAnchor(
  workspaceId: string,
  sessionId: string,
  tsMs: number,
  a: import('./usageAnchors.js').AnchorInput
): Promise<void> {
  await insertUsageAnchorQ(kyselyOrThrow(), workspaceId, sessionId, tsMs, a);
}

export async function latestAnchorCovering(atMs: number): Promise<UsageAnchorRow | null> {
  const r = await kyselyOrThrow()
    .selectFrom('usage_anchors')
    .select(ANCHOR_COLUMNS)
    .where('scope', '=', 'session')
    .where('window_start', 'is not', null)
    .where('reset_at', 'is not', null)
    .where('window_start', '<=', atMs)
    .where('reset_at', '>=', atMs)
    .orderBy('ts', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return r ? toAnchorRow(r) : null;
}

export async function latestLimitHitAnchor(): Promise<UsageAnchorRow | null> {
  const r = await kyselyOrThrow()
    .selectFrom('usage_anchors')
    .select(ANCHOR_COLUMNS)
    .where('kind', '=', 'limit-hit')
    .where('window_start', 'is not', null)
    .orderBy('ts', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return r ? toAnchorRow(r) : null;
}

// ── Sessions table ──────────────────────────────────────────────────────
//
// Backs the left-rail Sessions list (#3): every claude session the watcher
// has ever ingested, with derived cost + event count. Workspace-eligibility
// (hiding sessions whose workspace was deleted) is applied in the IPC layer,
// which is the only place that knows about on-disk manifests.

export interface SessionListRow {
  id: string;
  workspaceId: string;
  /** LLM-generated title; dormant until the title hook lands — usually null. */
  aiTitle: string | null;
  /** Head of the first user message — the display title fallback. */
  firstUserMessage: string | null;
  /** Manual rename override; wins over the auto title when set. */
  userSetName: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  eventCount: number;
  usd: number;
  /** Tags from the latest tagged summary chapter, in emitted (relevance)
   *  order; [] until the Phase-2 summarizer has produced one. */
  tags: string[];
  /** Started by an automation fresh step (broker id `auto-*`), not a tab. The
   *  Sessions list files these under their own collapsed group. */
  headless: boolean;
}

/** Prefix of the broker session ids automation fresh steps spawn under
 *  (`auto-<runId>-<stepId>`, automations/runner.ts). */
export const HEADLESS_BROKER_PREFIX = 'auto-';

// Exported so the EXPLAIN QUERY PLAN test in dbSessionCosts.test.ts pins the
// compiled SQL of the real query and asserts session_costs is used, not events.
export function listSessionCostsQuery(q: Kysely<StateDb>, workspaceId?: string) {
  return q
    .selectFrom('session_costs')
    .select((eb) => [
      'session_id',
      'workspace_id',
      eb.fn<string | null>('nullif', ['model', eb.val('')]).as('model'),
      eb.fn<string | null>('nullif', ['service_tier', eb.val('')]).as('service_tier'),
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'event_count',
    ])
    .$if(workspaceId !== undefined, (qb) => qb.where('workspace_id', '=', workspaceId as string));
}

/** UTF-8 byte order (= code point order), as `COLLATE "C"` and SQLite compare. */
function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codeUnitRank(x) - codeUnitRank(y);
  }
  return a.length - b.length;
}

// Surrogates (code points above U+FFFF) rank after U+E000–U+FFFF.
function codeUnitRank(c: number): number {
  if (c < 0xd800) return c;
  return c < 0xe000 ? c + 0x2000 : c - 0x800;
}

type CostRow = Awaited<ReturnType<ReturnType<typeof listSessionCostsQuery>['execute']>>[number];

function compareCostRows(a: CostRow, b: CostRow): number {
  return compareBytes(a.workspace_id, b.workspace_id)
    || compareBytes(a.model ?? '', b.model ?? '')
    || compareBytes(a.service_tier ?? '', b.service_tier ?? '');
}

/**
 * All sessions, newest-active first. Optionally scoped to one workspace.
 * Three queries total regardless of session count, in one read transaction:
 * session metadata, one pass over `session_costs` for per-session cost +
 * event count (rolled up in JS, since USD is per-(model, service_tier)), and
 * each session's latest tagged chapter. No N+1.
 */
export async function listSessions(workspaceId?: string): Promise<SessionListRow[]> {
  const scoped = workspaceId !== undefined && workspaceId !== '';
  return readTransaction(kyselyOrThrow(), async (trx) => {
    const sessRows = await trx
      .selectFrom('sessions')
      .select((eb) => [
        'id',
        'workspace_id',
        'ai_title',
        'first_user_message',
        'user_set_name',
        'started_at',
        'last_active_at',
        eb
          .exists(
            eb
              .selectFrom('broker_sessions as b')
              .select('b.broker_session_id')
              .whereRef('b.claude_session_id', '=', 'sessions.id')
              .where('b.broker_session_id', 'like', `${HEADLESS_BROKER_PREFIX}%`),
          )
          .as('headless'),
      ])
      .$if(scoped, (qb) => qb.where('workspace_id', '=', workspaceId as string))
      .orderBy((eb) => eb.fn.coalesce('last_active_at', eb.lit(0)), 'desc')
      .orderBy('id', 'asc')
      .execute();

    const costRows = await listSessionCostsQuery(trx, scoped ? workspaceId : undefined).execute();

    // Each session's USD is summed in key order, so the float sum doesn't
    // depend on storage order.
    const rowsBySession = new Map<string, CostRow[]>();
    for (const r of costRows) {
      const rs = rowsBySession.get(r.session_id);
      if (rs) rs.push(r);
      else rowsBySession.set(r.session_id, [r]);
    }
    const byId = new Map<string, { usd: number; eventCount: number }>();
    for (const [id, rs] of rowsBySession) {
      // Insertion sort: each session has only a couple of rows, where
      // Array#sort's setup cost dominates the comparisons it saves.
      for (let i = 1; i < rs.length; i++) {
        const r = rs[i];
        let j = i - 1;
        while (j >= 0 && compareCostRows(rs[j], r) > 0) { rs[j + 1] = rs[j]; j--; }
        rs[j + 1] = r;
      }
      const agg = { usd: 0, eventCount: 0 };
      for (const r of rs) {
        agg.eventCount += r.event_count;
        agg.usd += costFor(r.model, r.service_tier, {
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadInputTokens: r.cache_read_input_tokens,
          cacheCreationInputTokens: r.cache_creation_input_tokens,
        });
      }
      byId.set(id, agg);
    }

    // The latest tagged chapter per session, by id.
    const tagRows = await trx
      .selectFrom('session_summaries')
      .select(['session_id', 'tags'])
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('session_summaries')
          .select((e) => e.fn.max('id').as('latest'))
          .where('tags', 'is not', null)
          .$if(scoped, (qb) => qb.where('workspace_id', '=', workspaceId as string))
          .groupBy('session_id'),
      )
      .execute();

    const tagsById = new Map<string, string[]>();
    for (const r of tagRows) {
      try {
        const parsed: unknown = JSON.parse(r.tags as string);
        if (Array.isArray(parsed)) {
          tagsById.set(r.session_id, parsed.filter((t): t is string => typeof t === 'string'));
        }
      } catch {
        /* malformed tags JSON — treat as untagged */
      }
    }

    return sessRows.map((s) => {
      const agg = byId.get(s.id) ?? { usd: 0, eventCount: 0 };
      return {
        id: s.id,
        workspaceId: s.workspace_id,
        aiTitle: s.ai_title,
        firstUserMessage: s.first_user_message,
        userSetName: s.user_set_name,
        startedAt: s.started_at,
        lastActiveAt: s.last_active_at,
        eventCount: agg.eventCount,
        usd: agg.usd,
        tags: tagsById.get(s.id) ?? [],
        headless: Boolean(s.headless),
      };
    });
  });
}

/** Each workspace's most recent session activity (the max `last_active_at`,
 *  null when it has none) — what `listSessions(ws)[0]?.lastActiveAt` gives,
 *  for many workspaces in one grouped query per 500 ids. */
export async function latestActivityByWorkspace(workspaceIds: readonly string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const part of chunked(workspaceIds)) {
    const rows = await kyselyOrThrow()
      .selectFrom('sessions')
      .select((eb) => ['workspace_id', eb.fn.max('last_active_at').as('last')])
      .where('workspace_id', 'in', part)
      .groupBy('workspace_id')
      .execute();
    for (const r of rows) out.set(r.workspace_id, r.last === null ? null : num(r.last));
  }
  return out;
}

export interface CaptureSignals {
  workspaceId: string; model: string | null; contextTokens: number; userTurns: number; compactions: number;
}

/** Knowledge capture (#483): per-session inputs for the trigger policy. Small
 *  indexed reads (idx_events_session_type) on one read snapshot — safe on the
 *  ingest path, and dialect-neutral (SQLite and Postgres). */
export async function sessionCaptureSignals(sessionId: string): Promise<CaptureSignals | null> {
  return readTransaction(kyselyOrThrow(), async (trx) => {
    const s = await trx.selectFrom('sessions').select('workspace_id').where('id', '=', sessionId).executeTakeFirst();
    if (!s) return null;
    const last = await trx
      .selectFrom('events')
      .select((eb) => [
        'model',
        eb(
          eb(eb.fn.coalesce('input_tokens', eb.lit(0)), '+', eb.fn.coalesce('cache_read_input_tokens', eb.lit(0))),
          '+',
          eb.fn.coalesce('cache_creation_input_tokens', eb.lit(0))
        ).as('ctx')
      ])
      .where('session_id', '=', sessionId)
      .where('type', '=', 'assistant')
      .where('input_tokens', 'is not', null)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const turns = await trx
      .selectFrom('events')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('session_id', '=', sessionId)
      .where('type', '=', 'user')
      .where('tool_use_id', 'is', null)
      .executeTakeFirstOrThrow();
    const comp = await trx
      .selectFrom('events')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('session_id', '=', sessionId)
      .where('type', '=', 'system')
      .where('subtype', '=', 'compact_boundary')
      .executeTakeFirstOrThrow();
    return {
      workspaceId: s.workspace_id,
      model: last?.model ?? null,
      contextTokens: last ? num(last.ctx) : 0,
      userTurns: num(turns.n),
      compactions: num(comp.n)
    };
  });
}

/** True when the session was started by an automation fresh step (broker id auto-…). */
export async function isAutomationSession(sessionId: string): Promise<boolean> {
  const row = await kyselyOrThrow()
    .selectFrom('broker_sessions')
    .select('broker_session_id')
    .where('claude_session_id', '=', sessionId)
    .where('broker_session_id', 'like', `${HEADLESS_BROKER_PREFIX}%`)
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

/**
 * Set (or clear) the manual name override for a session. An empty/whitespace
 * name clears it back to NULL so the auto title resurfaces.
 */
export async function renameSession(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  await kyselyOrThrow()
    .updateTable('sessions')
    .set({ user_set_name: trimmed.length ? trimmed : null })
    .where('id', '=', id)
    .execute();
  summaryCache.invalidate(id);
}

/** A session's rows in every per-session cache table; the caller owns the transaction and must
 *  call this first in it: the session row lock waits out an in-flight `insertSessionEmbeddings`. */
export async function deleteSessionRows(q: Kysely<StateDb>, id: string): Promise<void> {
  if (dialect === 'postgres') await sql`SELECT 1 FROM sessions WHERE id = ${id} FOR UPDATE`.execute(q);
  await q.deleteFrom('events').where('session_id', '=', id).execute();
  await q.deleteFrom('session_costs').where('session_id', '=', id).execute();
  await q.deleteFrom('session_stats').where('session_id', '=', id).execute();
  await q.deleteFrom('session_tool_counts').where('session_id', '=', id).execute();
  await q.deleteFrom('broker_sessions').where('claude_session_id', '=', id).execute();
  await q.deleteFrom('embeddings').where('session_id', '=', id).execute();
  await q.deleteFrom('event_retention').where('session_id', '=', id).execute();
  await q.deleteFrom('transcript_offsets').where('session_id', '=', id).execute();
  await q.deleteFrom('sessions').where('id', '=', id).execute();
}

/**
 * Drop a session from the cache entirely: its events, rollups, embeddings,
 * retention watermarks, broker mapping and the session row. The on-disk JSONL is removed by the caller (IPC
 * layer), which knows the host path. Idempotent.
 */
export async function deleteSession(id: string): Promise<void> {
  await kyselyOrThrow().transaction().execute((trx) => deleteSessionRows(trx, id));
  summaryCache.invalidate(id);
  spendCache.clear();
}

// ── Transcript offsets (SPEC §7 *Transcript offsets*) ────────────────────

export interface TranscriptOffset { byteOffset: number; tailLen: number; tailHash: string }
export interface TranscriptOffsetRow extends TranscriptOffset { path: string; workspaceId: string; sessionId: string }

/** Every saved ingest resume point, by transcript path. */
export async function loadTranscriptOffsets(): Promise<Map<string, TranscriptOffset>> {
  const rows = await kyselyOrThrow().selectFrom('transcript_offsets').select(['path', 'byte_offset', 'tail_len', 'tail_hash']).execute();
  return new Map(rows.map((r) => [r.path, { byteOffset: num(r.byte_offset), tailLen: num(r.tail_len), tailHash: r.tail_hash }]));
}

/** transcript_offsets has 6 bound columns: 500 rows = 3,000 parameters per INSERT. */
export async function saveTranscriptOffsets(rows: readonly TranscriptOffsetRow[]): Promise<void> {
  for (const part of chunked(rows, 500)) {
    await kyselyOrThrow().insertInto('transcript_offsets')
      .values(part.map((r) => ({
        path: r.path, workspace_id: r.workspaceId, session_id: r.sessionId,
        byte_offset: r.byteOffset, tail_len: r.tailLen, tail_hash: r.tailHash,
      })))
      .onConflict((oc) => oc.column('path').doUpdateSet((eb) => ({
        workspace_id: eb.ref('excluded.workspace_id'),
        session_id: eb.ref('excluded.session_id'),
        byte_offset: eb.ref('excluded.byte_offset'),
        tail_len: eb.ref('excluded.tail_len'),
        tail_hash: eb.ref('excluded.tail_hash'),
      })))
      .execute();
  }
}

export async function deleteTranscriptOffsets(paths: readonly string[]): Promise<void> {
  for (const part of chunked(paths, 500)) {
    await kyselyOrThrow().deleteFrom('transcript_offsets').where('path', 'in', part).execute();
  }
}

// ── Retention (SPEC §7 *Retention*) ──────────────────────────────────────

export interface RetentionCandidate {
  sessionId: string;
  workspaceId: string;
  /** Has a 'resumed' usage signal: stripped at 90 days, not 30. */
  resumed: boolean;
  compressedBefore: number;
  strippedBefore: number;
  lastActiveAt: number;
}

/** Sessions that started before `cut` and whose compress watermark is behind
 *  it, or whose strip watermark is (resumed sessions always qualify; their
 *  strip cut trails). Oldest first. */
export async function retentionCandidates(cut: number): Promise<RetentionCandidate[]> {
  const rows = await kyselyOrThrow()
    .selectFrom('sessions as s')
    .leftJoin('event_retention as r', 'r.session_id', 's.id')
    .select((eb) => [
      's.id as sessionId',
      's.workspace_id as workspaceId',
      's.last_active_at as lastActiveAt',
      eb.fn.coalesce('r.compressed_before', eb.lit(0)).as('compressedBefore'),
      eb.fn.coalesce('r.stripped_before', eb.lit(0)).as('strippedBefore'),
      eb.exists(eb.selectFrom('usage_events as u').select('u.id')
        .whereRef('u.session_id', '=', 's.id').where('u.kind', '=', 'resumed')).as('resumed'),
    ])
    .where('s.started_at', '<', cut)
    .where((eb) => eb.or([
      eb(eb.fn.coalesce('r.compressed_before', eb.lit(0)), '<', cut),
      eb(eb.fn.coalesce('r.stripped_before', eb.lit(0)), '<', cut),
    ]))
    .orderBy('s.started_at').orderBy('s.id')
    .execute();
  return rows.map((r) => ({
    sessionId: r.sessionId, workspaceId: r.workspaceId, resumed: Boolean(num(r.resumed)),
    compressedBefore: num(r.compressedBefore), strippedBefore: num(r.strippedBefore), lastActiveAt: num(r.lastActiveAt),
  }));
}

export interface RetentionRow { id: number; ts: number; raw_jsonl: string; raw_z: Buffer | null }
export interface RetentionKey { id: number; ts: number; bytes: number }

/** Keys of one session's rows with `fromTs <= ts < toTs`, keyset after
 *  `after` on (ts, id) — served by idx_events_session_ts. `bytes` is the
 *  stored size (octet_length reads no payload), so a caller can stop at a byte
 *  budget before fetching bodies. `toolOnly` keeps rows with a tool_use_id
 *  (the only strippable ones). */
export async function retentionKeys(
  sessionId: string, fromTs: number, toTs: number, after: { ts: number; id: number } | null, limit: number, toolOnly: boolean,
): Promise<RetentionKey[]> {
  const rows = await kyselyOrThrow()
    .selectFrom('events')
    .select(['id', 'ts', sql<number>`octet_length(raw_jsonl) + COALESCE(octet_length(raw_z), 0)`.as('bytes')])
    .where('session_id', '=', sessionId)
    .where('ts', '>=', fromTs)
    .where('ts', '<', toTs)
    .$if(toolOnly, (qb) => qb.where('tool_use_id', 'is not', null))
    .$if(after !== null, (qb) => qb.where((eb) => eb.or([
      eb('ts', '>', after!.ts),
      eb.and([eb('ts', '=', after!.ts), eb('id', '>', after!.id)]),
    ])))
    .orderBy('ts').orderBy('id')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ id: num(r.id), ts: num(r.ts), bytes: num(r.bytes) }));
}

/** The stored lines of `ids`, in id order. */
export async function retentionBodies(ids: readonly number[]): Promise<RetentionRow[]> {
  if (ids.length === 0) return [];
  const rows = await kyselyOrThrow().selectFrom('events').select(['id', 'ts', 'raw_jsonl', 'raw_z'])
    .where('id', 'in', [...ids]).orderBy('id').execute();
  return rows.map((r) => ({ id: num(r.id), ts: num(r.ts), raw_jsonl: r.raw_jsonl, raw_z: r.raw_z ?? null }));
}

/** Rewrite stored lines in one transaction. Extract columns, ids and
 *  dedup_key are untouched, so rollups and re-ingest dedup are unaffected. */
export async function rewriteEventRaw(updates: readonly { id: number; raw_jsonl: string; raw_z: Buffer | null }[]): Promise<void> {
  if (updates.length === 0) return;
  await kyselyOrThrow().transaction().execute(async (trx) => {
    for (const u of updates) {
      await trx.updateTable('events').set({ raw_jsonl: u.raw_jsonl, raw_z: u.raw_z }).where('id', '=', u.id).execute();
    }
  });
}

/** Attachment rows not yet deduped, id order, with an estimate of the bytes
 *  each costs to process (no payload read): a deflated line counts ×3, its
 *  typical inflated size. */
export async function attachmentBackfillKeys(afterId: number, maxId: number, limit: number): Promise<{ id: number; bytes: number }[]> {
  const rows = await kyselyOrThrow().selectFrom('events')
    .select(['id', sql<number>`octet_length(raw_jsonl) + 3 * COALESCE(octet_length(raw_z), 0)`.as('bytes')])
    .where('type', '=', 'attachment').where('att_ref', 'is', null)
    .where('id', '>', afterId).where('id', '<=', maxId)
    .orderBy('id').limit(limit).execute();
  return rows.map((r) => ({ id: num(r.id), bytes: num(r.bytes) }));
}

export async function maxAttachmentId(): Promise<number> {
  const r = await kyselyOrThrow().selectFrom('events')
    .select((eb) => eb.fn.coalesce(eb.fn.max('id'), eb.lit(0)).as('m'))
    .where('type', '=', 'attachment').executeTakeFirst();
  return num(r?.m ?? 0);
}

/** Store rows in their deduped form and add their blob references, in one transaction.
 *  A row deleted or deduped since it was read is skipped. */
export async function applyAttachmentDedupe(
  updates: readonly { id: number; raw_jsonl: string; raw_z: Buffer | null; ref: string; payload: string }[],
): Promise<void> {
  if (updates.length === 0) return;
  await kyselyOrThrow().transaction().execute(async (trx) => {
    for (const u of updates) {
      const r = await trx.updateTable('events').set({ raw_jsonl: u.raw_jsonl, raw_z: u.raw_z, att_ref: u.ref })
        .where('id', '=', u.id).where('att_ref', 'is', null).executeTakeFirst();
      if (num(r.numUpdatedRows) > 0) await upsertBlob(trx, u.ref, u.payload);
    }
  });
}

export async function setRetentionWatermarks(
  sessionId: string, workspaceId: string, compressedBefore: number, strippedBefore: number,
): Promise<void> {
  // Only for a session that still exists: a purge racing the pass leaves no row behind.
  await kyselyOrThrow().insertInto('event_retention')
    .columns(['session_id', 'workspace_id', 'compressed_before', 'stripped_before'])
    .expression((eb) => eb.selectFrom('sessions')
      .select([eb.val(sessionId).as('session_id'), eb.val(workspaceId).as('workspace_id'),
        eb.val(compressedBefore).as('compressed_before'), eb.val(strippedBefore).as('stripped_before')])
      .where('id', '=', sessionId))
    .onConflict((oc) => oc.column('session_id').doUpdateSet({ compressed_before: compressedBefore, stripped_before: strippedBefore }))
    .execute();
}

/** Rows per purge statement to start with; the size then tracks PURGE_TARGET_MS. */
const PURGE_CHUNK = 250;
const PURGE_MIN_CHUNK = 50;
const PURGE_TARGET_MS = 35;

/** The next purge chunk after one of `size` rows took `ms`: cut in proportion
 *  on overshoot, grown back by 25% while under half the target. */
export function nextPurgeChunk(size: number, ms: number): number {
  if (ms > PURGE_TARGET_MS) return Math.max(PURGE_MIN_CHUNK, Math.floor(size * (PURGE_TARGET_MS / ms) * 0.8));
  if (ms < PURGE_TARGET_MS / 2) return Math.min(PURGE_CHUNK, Math.ceil(size * 1.25));
  return size;
}
const macrotask = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Delete every state.db row of a removed workspace (SPEC §7 *Retention*).
 *  Large tables go in id-ranged chunks, one transaction each, each run through
 *  `slice` when given so the caller can pace it. errors, perf_events and
 *  usage_anchors keep their rows (bounded diagnostics / account-wide). */
export async function purgeWorkspace(
  workspaceId: string,
  // Default: yield a macrotask after each chunk, since the SQLite driver resolves only microtasks between statements.
  slice: <T>(fn: () => Promise<T>) => Promise<T> = async (fn) => { const r = await fn(); await macrotask(); return r; },
  now: () => number = () => performance.now(),
): Promise<number> {
  const k = kyselyOrThrow();
  let deleted = 0;
  for (const table of ['session_stats', 'session_tool_counts'] as const) {
    const r = await slice(() => k.deleteFrom(table)
      .where('session_id', 'in', (eb) => eb.selectFrom('sessions').select('id').where('workspace_id', '=', workspaceId))
      .executeTakeFirst());
    deleted += num(r.numDeletedRows);
  }
  // One delete can't be interrupted, so its size adapts: cut in proportion
  // when a chunk overshoots the target, grown back slowly while well under it.
  let chunk = PURGE_CHUNK;
  for (const table of ['events', 'embeddings', 'usage_events', 'session_summaries'] as const) {
    for (;;) {
      const size = chunk;
      // Timed once the connection is held, so SQLite mutex waits don't shrink chunks (Postgres still counts its write-lock wait).
      const r = await slice(() => k.connection().execute(async (c) => {
        const t0 = now();
        const out = await c.deleteFrom(table)
          .where('id', 'in', (eb) => eb.selectFrom(table).select('id').where('workspace_id', '=', workspaceId).limit(size))
          .executeTakeFirst();
        chunk = nextPurgeChunk(size, now() - t0);
        return out;
      }));
      const n = num(r.numDeletedRows);
      deleted += n;
      if (n < size) break;
    }
  }
  for (const table of ['session_costs', 'session_tags', 'broker_sessions', 'port_exposures', 'event_retention', 'transcript_offsets', 'publish_withheld', 'sessions'] as const) {
    const r = await slice(() => k.deleteFrom(table).where('workspace_id', '=', workspaceId).executeTakeFirst());
    deleted += num(r.numDeletedRows);
  }
  const cursors = await slice(() => k.deleteFrom('publish_cursors')
    .where((eb) => eb.or([eb('source_workspace_id', '=', workspaceId), eb('target_workspace_id', '=', workspaceId)]))
    .executeTakeFirst());
  deleted += num(cursors.numDeletedRows);
  summaryCache.clear();
  spendCache.clear();
  return deleted;
}

/** Workspace ids with rows in sessions, events or embeddings. A recursive
 *  min() skip-scan per table: O(workspaces × log rows) on its workspace index,
 *  where DISTINCT would walk the whole index. */
export async function workspaceIdsInState(): Promise<string[]> {
  const ids = new Set<string>();
  for (const t of ['sessions', 'events', 'embeddings'] as const) {
    const { rows } = await sql<{ id: string }>`
      WITH RECURSIVE w(id) AS (
        SELECT (SELECT min(workspace_id) FROM ${sql.table(t)})
        UNION ALL
        SELECT (SELECT min(workspace_id) FROM ${sql.table(t)} WHERE workspace_id > w.id) FROM w WHERE w.id IS NOT NULL
      )
      SELECT id FROM w WHERE id IS NOT NULL`.execute(kyselyOrThrow());
    for (const r of rows) ids.add(r.id);
  }
  return [...ids].sort();
}

// ── Embeddings ────────────────────────────────────────────────────────────

export interface EmbeddingInsert {
  workspaceId: string;
  sessionId: string;
  kind: 'turn' | 'summary';
  refEventId: number | null;
  ts: number | null;
  text: string;
  modelId: string;
  dim: number;
  vec: Buffer;
  dedupKey: string;
}

/** Drop embedding rows keyed to any OTHER model id. Run before backfill so a
 *  model/dtype change (which re-keys EMBED_MODEL_ID) doesn't leave dead
 *  vectors accumulating under retired keys. Deletes `chunk` rows per statement
 *  and yields between them: on SQLite each statement runs synchronously on
 *  the main loop. Returns rows deleted. */
export async function deleteEmbeddingsForOtherModels(
  modelId: string,
  chunk = 500,
  yieldFn: () => Promise<void> = yieldMacrotask,
): Promise<number> {
  const k = kyselyOrThrow();
  let total = 0;
  for (;;) {
    const r = await k.deleteFrom('embeddings')
      .where('id', 'in', (qb) => qb.selectFrom('embeddings').select('id').where('model_id', '!=', modelId).limit(chunk))
      .executeTakeFirst();
    const n = num(r.numDeletedRows);
    total += n;
    if (n < chunk) return total;
    await yieldFn();
  }
}

/** embeddings has 10 bound columns: 500 rows = 5,000 parameters per INSERT —
 *  under SQLite's 32,766 bound-parameter limit (3.32+, which better-sqlite3
 *  bundles) and Postgres's 65,535. */
const EMBEDDINGS_ROWS_PER_INSERT = 500;

/** SQLite stores int8 (388 B); callers hand float32. Postgres keeps float32 vector(384). */
const sqliteVec = (vec: Buffer): Buffer => (vec.length === EMBED_DIM * 4 ? encodeVectorInt8(decodeVector(vec)) : vec);

/** Insert a batch of embedding rows in one transaction (ON CONFLICT DO
 *  NOTHING, same as the single-row path). Returns rows actually inserted —
 *  a dedup hit doesn't count. */
export async function insertEmbeddings(rows: readonly EmbeddingInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  return kyselyOrThrow().transaction().execute((trx) => insertEmbeddingRows(trx, rows));
}

/** `insertEmbeddings` for one session's rows, or null (nothing written) once the session row is gone.
 *  The row lock orders this against a delete that takes `FOR UPDATE` first; SQLite serializes
 *  writers, so the check inside the write transaction suffices there. */
export async function insertSessionEmbeddings(sessionId: string, rows: readonly EmbeddingInsert[]): Promise<number | null> {
  if (rows.some((r) => r.sessionId !== sessionId)) throw new Error('insertSessionEmbeddings: rows of another session');
  return kyselyOrThrow().transaction().execute(async (trx) => {
    const lock = dialect === 'postgres' ? sql`FOR SHARE` : sql``;
    const held = await sql`SELECT 1 FROM sessions WHERE id = ${sessionId} ${lock}`.execute(trx);
    if (held.rows.length === 0) return null;
    return rows.length === 0 ? 0 : insertEmbeddingRows(trx, rows);
  });
}

async function insertEmbeddingRows(trx: Kysely<StateDb>, rows: readonly EmbeddingInsert[]): Promise<number> {
  let inserted = 0;
  for (const part of chunked(rows, EMBEDDINGS_ROWS_PER_INSERT)) {
    const r = await trx
      .insertInto('embeddings')
      .values(
        part.map((row) => ({
          workspace_id: row.workspaceId,
          session_id: row.sessionId,
          kind: row.kind,
          ref_event_id: row.refEventId,
          ts: row.ts,
          text: row.text,
          model_id: row.modelId,
          dim: row.dim,
          vec: dialect !== 'postgres' ? sqliteVec(row.vec)
            : row.vec.length === 0 ? null
            : sql<Buffer>`${pgVectorLiteral(decodeVector(row.vec))}::vector`,
          dedup_key: row.dedupKey,
        }))
      )
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    inserted += num(r.numInsertedOrUpdatedRows);
  }
  return inserted;
}

export async function maxEmbeddingId(): Promise<number> {
  const r = await kyselyOrThrow().selectFrom('embeddings')
    .select((eb) => eb.fn.coalesce(eb.fn.max('id'), eb.lit(0)).as('m')).executeTakeFirstOrThrow();
  return num(r.m);
}

/** Compact up to `limit` embedding rows with `afterId < id <= maxId`: a
 *  placeholder (text '') loses its vector; on SQLite a float32 vector is
 *  re-encoded to int8. `expired` stops the SQLite row loop early (after at
 *  least one row); `started` runs once the transaction holds the store.
 *  `lastId` is the cursor to resume from (null when the range is exhausted). */
export async function compactEmbeddingSlice(
  afterId: number, maxId: number, limit: number, expired: () => boolean = () => false, started: () => void = () => undefined,
): Promise<{ lastId: number | null; scanned: number; rewritten: number; bytesSaved: number }> {
  return kyselyOrThrow().transaction().execute(async (trx) => {
    started();
    if (dialect === 'postgres') {
      const ids = (await trx.selectFrom('embeddings').select('id')
        .where('id', '>', afterId).where('id', '<=', maxId).orderBy('id').limit(limit).execute()).map((r) => num(r.id));
      if (ids.length === 0) return { lastId: null, scanned: 0, rewritten: 0, bytesSaved: 0 };
      const r = await trx.updateTable('embeddings').set({ vec: null })
        .where('id', 'in', ids).where('text', '=', '').where('vec', 'is not', null).executeTakeFirst();
      const n = num(r.numUpdatedRows);
      return { lastId: ids[ids.length - 1], scanned: ids.length, rewritten: n, bytesSaved: n * EMBED_DIM * 4 };
    }
    const rows = await trx.selectFrom('embeddings').select(['id', 'text', 'vec'])
      .where('id', '>', afterId).where('id', '<=', maxId).orderBy('id').limit(limit).execute();
    if (rows.length === 0) return { lastId: null, scanned: 0, rewritten: 0, bytesSaved: 0 };
    let scanned = 0;
    let rewritten = 0;
    let bytesSaved = 0;
    for (; scanned < rows.length && (scanned === 0 || !expired()); scanned++) {
      const r = rows[scanned];
      const old = r.vec ?? EMPTY_VECTOR;
      if (old.length !== EMBED_DIM * 4) continue;
      const vec = r.text === '' ? EMPTY_VECTOR : sqliteVec(old);
      await trx.updateTable('embeddings').set({ vec }).where('id', '=', num(r.id)).execute();
      rewritten++;
      bytesSaved += old.length - vec.length;
    }
    return { lastId: num(rows[scanned - 1].id), scanned, rewritten, bytesSaved };
  });
}

/** Single-row convenience over `insertEmbeddings` (tests, one-off callers). */
export async function insertEmbedding(row: EmbeddingInsert): Promise<boolean> {
  return (await insertEmbeddings([row])) > 0;
}

export interface UnembeddedTurn {
  id: number;
  workspaceId: string;
  ts: number | null;
  rawJsonl: string;
}

/** The newest `type` turn of a session that has a `modelId` turn embedding.
 *  Exported for the EXPLAIN QUERY PLAN pin. */
export function turnBoundaryQuery(q: Kysely<StateDb>, sessionId: string, type: 'user' | 'assistant', modelId: string) {
  return q
    .selectFrom('events as e')
    .select('e.id')
    .where('e.session_id', '=', sessionId)
    .where('e.type', '=', type)
    .where(({ exists, selectFrom }) => exists(
      selectFrom('embeddings as em')
        .select('em.id')
        .whereRef('em.ref_event_id', '=', 'e.id')
        .where('em.kind', '=', 'turn')
        .where('em.model_id', '=', modelId),
    ))
    .orderBy('e.id', 'desc')
    .limit(1);
}

/** Unembedded `type` turns of a session with id > `after`, oldest first. One
 *  type per query so the index walk is already in id order and stops at
 *  `limit` (an IN list would read every later row and sort). Exported for the
 *  EXPLAIN QUERY PLAN pin. */
export function pendingTurnsQuery(q: Kysely<StateDb>, sessionId: string, type: 'user' | 'assistant', modelId: string, after: number, limit: number) {
  return q
    .selectFrom('events as e')
    .leftJoin('embeddings as em', (j) =>
      j.onRef('em.ref_event_id', '=', 'e.id').on('em.kind', '=', 'turn').on('em.model_id', '=', modelId),
    )
    .select(['e.id as id', 'e.workspace_id as workspaceId', 'e.ts as ts', 'e.raw_jsonl as raw_jsonl', 'e.raw_z as raw_z'])
    .where('e.session_id', '=', sessionId)
    .where('e.type', '=', type)
    .where('e.id', '>', after)
    .where('em.id', 'is', null)
    .orderBy('e.id', 'asc')
    .limit(limit);
}

/** user/assistant events in a session with no 'turn' embedding for `modelId`,
 *  oldest first, after the newest embedded turn. Turns are embedded oldest-first
 *  and a session's event ids commit in id order (SPEC §7 *Startup indexing*), so
 *  that boundary is where pending turns start: each read walks the pending tail,
 *  not the session (#583). `after` skips the boundary lookup: a caller draining
 *  a backlog passes the last id it handled. */
export async function unembeddedTurnEvents(
  sessionId: string, modelId: string, limit = 200, after?: number,
): Promise<UnembeddedTurn[]> {
  const k = kyselyOrThrow();
  let from = after ?? 0;
  if (after === undefined) {
    for (const type of ['user', 'assistant'] as const) {
      const row = await turnBoundaryQuery(k, sessionId, type, modelId).executeTakeFirst();
      if (row && row.id > from) from = row.id;
    }
  }
  const users = await pendingTurnsQuery(k, sessionId, 'user', modelId, from, limit).execute();
  const assistants = await pendingTurnsQuery(k, sessionId, 'assistant', modelId, from, limit).execute();
  const rows = [...users, ...assistants].sort((a, b) => a.id - b.id).slice(0, limit);
  // user/assistant rows never carry att_ref (attachment lines only).
  return rows.map((r) => ({ id: r.id, workspaceId: r.workspaceId, ts: r.ts, rawJsonl: rawLine(r) }));
}

/** Sessions with at least one user/assistant event lacking a `modelId` turn
 *  embedding, in `listSessions` order. Turns are embedded oldest-first per
 *  session (`unembeddedTurnEvents` order), so a session has pending turns iff
 *  its newest user/assistant event has none: one index probe per session
 *  instead of an anti-join over all its turns. */
// Exported for the EXPLAIN QUERY PLAN test. The CTE is materialized so the
// correlated max runs once per session though the outer query reads it twice.
export function sessionsWithPendingTurnsQuery(q: Kysely<StateDb>, modelId: string) {
  return q
    .with((w) => w('x').materialized(), (qb) => qb
      .selectFrom('sessions as s')
      .select((eb) => [
        's.id as id',
        's.last_active_at as last_active_at',
        eb.selectFrom('events as e')
          .select((e) => e.fn.max('e.id').as('m'))
          .whereRef('e.session_id', '=', 's.id')
          .where('e.type', 'in', ['user', 'assistant'])
          .as('last_turn'),
      ]))
    .selectFrom('x')
    .select('x.id')
    .where('x.last_turn', 'is not', null)
    .where(({ not, exists, selectFrom }) => not(exists(
      selectFrom('embeddings as em')
        .select('em.id')
        .whereRef('em.ref_event_id', '=', 'x.last_turn')
        .where('em.kind', '=', 'turn')
        .where('em.model_id', '=', modelId),
    )))
    .orderBy((eb) => eb.fn.coalesce('x.last_active_at', eb.lit(0)), 'desc')
    .orderBy('x.id', 'asc');
}

export async function sessionsWithPendingTurns(modelId: string): Promise<string[]> {
  const rows = await sessionsWithPendingTurnsQuery(kyselyOrThrow(), modelId).execute();
  return rows.map((r) => r.id);
}

export async function maxEventId(sessionId: string): Promise<number> {
  const row = await kyselyOrThrow()
    .selectFrom('events')
    .select((eb) => eb.fn.coalesce(eb.fn.max('id'), eb.lit(0)).as('m'))
    .where('session_id', '=', sessionId)
    .executeTakeFirstOrThrow();
  return num(row.m);
}

export interface PendingSummary {
  sessionId: string;
  workspaceId: string;
  summary: string;
  sourceMaxEventId: number;
  ts: number | null;
}

/** Summaries whose current (session, source_max_event_id) has no embedding. */
export async function unembeddedSummaries(modelId: string, limit = 100): Promise<PendingSummary[]> {
  return kyselyOrThrow()
    .selectFrom('session_summaries as s')
    .leftJoin('embeddings as em', (j) =>
      j
        .onRef('em.session_id', '=', 's.session_id')
        .on('em.kind', '=', 'summary')
        .on('em.model_id', '=', modelId)
        .on((eb) => eb('em.dedup_key', '=', eb.cast<string>('s.source_max_event_id', 'text'))),
    )
    .select([
      's.session_id as sessionId',
      's.workspace_id as workspaceId',
      's.summary as summary',
      's.source_max_event_id as sourceMaxEventId',
      's.generated_at as ts',
    ])
    .where('em.id', 'is', null)
    .orderBy('s.generated_at', 'desc')
    .orderBy('s.id', 'desc')
    .limit(limit)
    .execute();
}

// ── Error recording ───────────────────────────────────────────────────────

export const ERRORS_RETENTION = 2000;

export interface ErrorRow {
  ts: number;
  source: string;
  type: string;
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
  workspaceId?: string;
  sessionId?: string;
  level?: string;
}

export async function recordError(row: ErrorRow): Promise<void> {
  await recordErrors([row]);
}

/** Postgres text refuses NUL. */
const noNul = (v: string): string => v.replace(/\0/g, '');
const noNulOrNull = (v: string | undefined | null): string | null => (v == null ? null : noNul(String(v)));

/** JSON for `extra` that never throws: BigInt as a string, cycles cut. */
export function safeExtraJson(extra: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    return noNul(JSON.stringify(extra, (_k, v: unknown) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }));
  } catch (e) {
    return JSON.stringify({ unserializable: noNul(String(e)) });
  }
}

async function insertErrorRow(trx: Transaction<StateDb>, row: ErrorRow): Promise<void> {
  // Resolve the claude session UUID: prefer an explicit sessionId; else, if
  // the caller only knew the broker id, best-effort resolve it via the
  // mapping (NULL when unmapped — itself an honest signal).
  let sessionId = row.sessionId ?? null;
  if (!sessionId && row.workspaceId && typeof row.extra?.brokerSessionId === 'string') {
    const m = await existingMappingQ(trx, row.workspaceId, row.extra.brokerSessionId as string);
    sessionId = m?.claude_session_id ?? null;
  }
  await trx
    .insertInto('errors')
    .values({
      ts: row.ts,
      workspace_id: noNulOrNull(row.workspaceId),
      session_id: noNulOrNull(sessionId),
      source: noNul(String(row.source)),
      level: noNul(String(row.level ?? 'error')),
      type: noNul(String(row.type)),
      message: noNul(String(row.message)),
      stack: noNulOrNull(row.stack),
      extra: row.extra ? safeExtraJson(row.extra) : null,
    })
    .execute();
}

// Keep the newest ERRORS_RETENTION rows: delete every id at or below the
// (ERRORS_RETENTION+1)-th newest (a PK seek, not a table scan).
async function pruneErrors(trx: Transaction<StateDb>): Promise<void> {
  await trx
    .deleteFrom('errors')
    .where('id', '<=', (eb) =>
      eb.selectFrom('errors').select('id').orderBy('id', 'desc').limit(1).offset(ERRORS_RETENTION)
    )
    .execute();
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  '57P01', '57P02', '57P03', '53300',
]);

/** A store that can't be reached, as opposed to one row it refused. */
export function isConnectionLevelError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (CONNECTION_ERROR_CODES.has(code) || code.startsWith('08'))) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|connect|pool|terminat|not open/i.test(msg);
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Insert `rows` and prune once, in one transaction. If that fails with a
 *  row-level error, each row gets its own transaction so one bad row can't drop
 *  the rest. Stops at once on a connection-level error, and when the first two
 *  retried rows both fail like the batch did (the cause isn't one row).
 *  Rejects when no row was written. */
export async function recordErrors(rows: ErrorRow[]): Promise<void> {
  if (!rows.length) return;
  const db = kyselyOrThrow();
  try {
    await db.transaction().execute(async (trx) => {
      for (const row of rows) await insertErrorRow(trx, row);
      await pruneErrors(trx);
    });
    return;
  } catch (batchErr) {
    if (rows.length === 1 || isConnectionLevelError(batchErr)) throw batchErr;
    let written = 0;
    let sameAsBatch = 0;
    for (const [i, row] of rows.entries()) {
      try {
        await db.transaction().execute((trx) => insertErrorRow(trx, row));
        written++;
      } catch (err) {
        if (isConnectionLevelError(err)) break;
        if (i < 2 && errText(err) === errText(batchErr) && ++sameAsBatch === 2) break;
      }
    }
    if (!written) throw batchErr;
    await db.transaction().execute(pruneErrors);
  }
}

export interface EmbeddingHit {
  sessionId: string;
  workspaceId: string;
  kind: 'turn' | 'summary';
  ts: number | null;
  text: string;
  score: number;
}

/** Top `limit` embeddings in `scope` by similarity to the unit-length `qvec`,
 *  current model only, placeholders and rows of a deleted session excluded. Exact on both dialects: a
 *  brute-force dot product on SQLite, `ORDER BY vec <=> q, id` (an exact
 *  sequential scan) on Postgres; an ANN index can't serve the `id` tiebreak.
 *  Ties break by `id` on both. */
export async function searchEmbeddings(
  qvec: Float32Array, scope: readonly string[], opts: { limit: number; kind?: 'turn' | 'summary' },
): Promise<EmbeddingHit[]> {
  if (scope.length === 0 || opts.limit <= 0 || dot(qvec, qvec) === 0) return [];
  const k = kyselyOrThrow();
  if (dialect === 'sqlite' && searchScannerClosing) throw new Error('transcript search unavailable: store closing');
  if (dialect === 'sqlite' && searchScannerFactory && db) {
    if (!searchScanner || searchScanner.path !== db.name) {
      void searchScanner?.close();
      searchScanner = { path: db.name, ...searchScannerFactory(db.name) };
    }
    const s = searchScanner;
    return s.scan(() => db, qvec, [...scope], opts);
  }
  if (dialect === 'sqlite') {
    const rows = await k.selectFrom('embeddings')
      .select(['session_id as sessionId', 'workspace_id as workspaceId', 'kind', 'ts', 'text', 'vec'])
      .where('workspace_id', 'in', [...scope]).where('model_id', '=', EMBED_MODEL_ID).where('text', '<>', '')
      .where(sql<boolean>`EXISTS (SELECT 1 FROM sessions s WHERE s.id = embeddings.session_id)`)
      .$if(opts.kind !== undefined, (qb) => qb.where('kind', '=', opts.kind as 'turn' | 'summary'))
      .orderBy('id')
      .execute();
    return topK(qvec, rows.map((r) => ({ vec: decodeVector(r.vec) })), opts.limit)
      .map(({ index, score }) => { const { vec: _vec, ...hit } = rows[index]; return { ...hit, score }; });
  }
  return pgSearchEmbeddings(k, qvec, scope, opts);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function kyselyOrThrow(): Kysely<StateDb> {
  if (!kdb) throw new Error('db not opened — call openDb(userDataDir) first');
  return kdb;
}
