// The async store layer's dialect seam (remote-workspaces spec §7 "One store
// layer"). Stores are written once against Kysely; this file is the only place
// that names the SQLite dialect. Part 3 adds the Postgres dialect beside it.
//
// Invariant the stores rely on: Kysely's SQLite driver runs every query on the
// single wrapped connection behind a ConnectionMutex, so Kysely queries and
// transactions on this instance are serialized — every inbox.db query goes
// through this mutex, with no raw better-sqlite3 handle left to bypass it. A
// transaction callback must still await only Kysely queries on its `trx`
// (never the outer `db`/`kysely` handle): an outer-handle query inside a
// transaction would queue behind the mutex the transaction already holds and
// deadlock.
import type Database from 'better-sqlite3';
import { Kysely, SqliteDialect, type SqliteDatabase, type SqliteStatement, type Transaction } from 'kysely';

export interface SqliteKyselyOptions {
  /** Reuse up to this many prepared statements, keyed by SQL text (0 = off,
   *  the default). Kysely's SQLite driver calls `prepare()` for every query;
   *  better-sqlite3 does not cache, so a hot path pays a full SQL compile per
   *  query without this. When the cache is full it is cleared, not LRU'd. */
  statementCache?: number;
  /** Called after each statement that succeeded, with its synchronous execution time. */
  onQuery?: (sqlText: string, ms: number) => void;
}

type QueryObserver = (sqlText: string, ms: number) => void;
let queryObserver: QueryObserver | null = null;

/** Observe every statement's synchronous execution time (failed ones too) on
 *  all SQLite Kysely handles. It runs in the caller's async context, so it can
 *  attribute the time to the caller's spans; mutex queueing is not included. */
export function setSqliteQueryObserver(fn: QueryObserver | null): void {
  queryObserver = fn;
}

export function sqliteKysely<DB>(raw: Database.Database, opts: SqliteKyselyOptions = {}): Kysely<DB> {
  const base: SqliteDatabase = opts.statementCache ? cachingDatabase(raw, opts.statementCache) : raw;
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: timedDatabase(base, opts.onQuery) }) });
}

function timedDatabase(base: SqliteDatabase, onQuery: SqliteKyselyOptions['onQuery']): SqliteDatabase {
  // One wrapper per statement object: cached statements reuse theirs.
  const wrappers = new WeakMap<SqliteStatement, SqliteStatement>();
  const timed = <T>(sqlText: string, call: () => T): T => {
    const t0 = performance.now();
    let ok = false;
    try {
      const r = call();
      ok = true;
      return r;
    } finally {
      const ms = performance.now() - t0;
      if (ok) onQuery?.(sqlText, ms);
      queryObserver?.(sqlText, ms);
    }
  };
  return {
    prepare(sqlText: string) {
      const stmt = base.prepare(sqlText);
      let w = wrappers.get(stmt);
      if (!w) {
        w = {
          reader: stmt.reader,
          all: (parameters) => timed(sqlText, () => stmt.all(parameters)),
          run: (parameters) => timed(sqlText, () => stmt.run(parameters)),
          iterate: (parameters) => stmt.iterate(parameters),
        };
        wrappers.set(stmt, w);
      }
      return w;
    },
    close: () => base.close(),
  };
}

function cachingDatabase(raw: Database.Database, max: number): SqliteDatabase {
  const cache = new Map<string, Database.Statement>();
  return {
    prepare(sqlText: string) {
      if (sqlText.length > 2048) return raw.prepare(sqlText);
      let stmt = cache.get(sqlText);
      if (!stmt) {
        stmt = raw.prepare(sqlText);
        if (cache.size >= max) cache.clear();
        cache.set(sqlText, stmt);
      }
      return stmt;
    },
    close() {
      cache.clear();
      if (raw.open) raw.close();
    }
  };
}

/** COUNT/SUM come back as number (SQLite), bigint, or string (Postgres); NULL sums as 0. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

/**
 * Split `items` into chunks of at most `size` (default 500). Used to keep
 * `WHERE col IN (...)` batches under SQLite's default ~999-parameter limit
 * while leaving headroom for other bound parameters in the same query.
 */
export function chunked<T>(items: readonly T[], size = 500): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A multi-query read on one snapshot: REPEATABLE READ, READ ONLY on Postgres
 *  (no write lock, no serialization failures); a plain transaction on SQLite,
 *  whose driver ignores the settings. */
export function readTransaction<DB, T>(k: Kysely<DB>, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return k.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(fn);
}
