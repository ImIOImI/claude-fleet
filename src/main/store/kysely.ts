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
import { Kysely, SqliteDialect, type SqliteDatabase, type Transaction } from 'kysely';

export interface SqliteKyselyOptions {
  /** Reuse up to this many prepared statements, keyed by SQL text (0 = off,
   *  the default). Kysely's SQLite driver calls `prepare()` for every query;
   *  better-sqlite3 does not cache, so a hot path pays a full SQL compile per
   *  query without this. When the cache is full it is cleared, not LRU'd. */
  statementCache?: number;
}

export function sqliteKysely<DB>(raw: Database.Database, opts: SqliteKyselyOptions = {}): Kysely<DB> {
  const database: SqliteDatabase = opts.statementCache ? cachingDatabase(raw, opts.statementCache) : raw;
  return new Kysely<DB>({ dialect: new SqliteDialect({ database }) });
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
