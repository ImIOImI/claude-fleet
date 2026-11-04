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
import { Kysely, SqliteDialect } from 'kysely';

export function sqliteKysely<DB>(raw: Database.Database): Kysely<DB> {
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
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
