// The switch back from Postgres to SQLite (SPEC §7 *Switch back to SQLite*): the authoritative
// inbox tables into a fresh SQLite file, ids kept. One attempt reads one
// REPEATABLE READ snapshot; chunks commit with their progress row inside the
// file, so a failed attempt resumes while the store's content is unchanged and
// restarts from scratch when it changed. Postgres is only read.
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { sql, type Kysely, type Transaction } from 'kysely';
import { INBOX_SCHEMA_VERSION, migrateInboxSqlite } from '../inbox/inboxDb.js';
import { removeSqliteFile } from './sqliteFiles.js';
import { IMPORT_TABLES, ImportError, pgTablesFingerprint, type ImportProgress } from './storeImport.js';

export { removeSqliteFile };

const TABLES = IMPORT_TABLES.inbox;

const PROGRESS_DDL = `
CREATE TABLE store_export_run (fingerprint TEXT NOT NULL);
CREATE TABLE store_export (tbl TEXT PRIMARY KEY, copied INTEGER NOT NULL, last_key TEXT, done INTEGER NOT NULL);
`;

export interface ExportOptions {
  k: Kysely<unknown>;
  /** The partial file this copy owns: created, resumed or replaced. Never a live inbox.db. */
  file: string;
  onProgress?: (p: ImportProgress) => void;
  maxRowsPerChunk?: number;
}

export interface ExportOutcome {
  /** pgInboxFingerprint of the snapshot that was copied. */
  fingerprint: string;
  counts: Record<string, number>;
}

/** The inbox tables' content, from one snapshot. */
export async function pgInboxFingerprint(k: Kysely<unknown>): Promise<string> {
  return k.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute((trx) => pgTablesFingerprint(trx, TABLES));
}

/** Resumes `file` when it is this copy's partial of the same content, else starts it over. */
function openPartial(file: string, fingerprint: string): Database.Database {
  if (existsSync(file)) {
    let d: Database.Database | null = null;
    try {
      d = new Database(file);
      const ok = d.pragma('user_version', { simple: true }) === INBOX_SCHEMA_VERSION
        && (d.prepare('SELECT fingerprint FROM store_export_run').get() as { fingerprint: string } | undefined)?.fingerprint === fingerprint;
      if (ok) return d;
    } catch {
      // not a database, or not a partial copy (no progress tables): start over
    }
    d?.close();
    removeSqliteFile(file);
  }
  const d = new Database(file);
  try {
    d.pragma('journal_mode = DELETE');
    migrateInboxSqlite(d);
    d.transaction(() => {
      d.exec(PROGRESS_DDL);
      d.prepare('INSERT INTO store_export_run (fingerprint) VALUES (?)').run(fingerprint);
    })();
    return d;
  } catch (e) {
    d.close();
    throw e;
  }
}

export async function exportInboxToSqlite(o: ExportOptions): Promise<ExportOutcome> {
  return o.k.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
    const fingerprint = await pgTablesFingerprint(trx, TABLES);
    const d = openPartial(o.file, fingerprint);
    try {
      const counts: Record<string, number> = {};
      for (const t of TABLES) counts[t] = await exportTable(o, trx, d, t);
      d.transaction(() => d.exec('DROP TABLE store_export_run; DROP TABLE store_export;'))();
      // The header then says WAL, as InboxStore leaves it: a foreign -wal beside the placed file is read (and caught) at once.
      d.pragma('journal_mode = WAL');
      return { fingerprint, counts };
    } finally {
      d.close();
    }
  });
}

async function exportTable(o: ExportOptions, trx: Transaction<unknown>, d: Database.Database, table: string): Promise<number> {
  const total = (await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(trx)).rows[0].n;
  const prog = d.prepare('SELECT copied, last_key, done FROM store_export WHERE tbl = ?').get(table) as
    { copied: number; last_key: string | null; done: number } | undefined;
  if (prog?.done) return total;
  const pgCols = (await sql<{ c: string; u: string; identity: string }>`
    SELECT column_name AS c, udt_name AS u, is_identity AS identity FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} ORDER BY ordinal_position`.execute(trx)).rows;
  const sqliteCols = new Set((d.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((r) => r.name));
  const cols = pgCols.filter((c) => sqliteCols.has(c.c));
  if (cols.length === 0) throw new ImportError(`copying ${table} back: inbox.db has no matching columns`);
  const pk = (await sql<{ c: string }>`
    SELECT a.attname AS c FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = ${table}::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`.execute(trx)).rows.map((r) => r.c);

  // int8 as text: the pool parses it to a double, which is not exact past 2^53.
  const select = sql.raw(cols.map((c) => (c.u === 'int8' ? `r."${c.c}"::text AS "${c.c}"` : `r."${c.c}"`)).join(', '));
  const toSqlite = (r: Record<string, unknown>): unknown[] =>
    cols.map((c) => (c.u === 'int8' && r[c.c] !== null ? BigInt(r[c.c] as string) : r[c.c]));
  const keyOf = pk.length > 0 ? sql.raw(pk.map((c) => `r."${c}"`).join(', ')) : sql.raw('md5(r::text)');
  const keyText = sql.raw(pk.length > 0 ? pk.map((c, i) => `r."${c}"::text AS __k${i}`).join(', ') : 'md5(r::text) AS __k0');
  const keyWidth = Math.max(1, pk.length);
  const keyValues = (r: Record<string, unknown>): string[] => Array.from({ length: keyWidth }, (_, i) => r[`__k${i}`] as string);

  const list = cols.map((c) => `"${c.c}"`).join(', ');
  const insert = d.prepare(`INSERT INTO "${table}" (${list}) VALUES (${cols.map(() => '?').join(', ')})`);
  const saveProgress = d.prepare(`INSERT INTO store_export (tbl, copied, last_key, done) VALUES (?, ?, ?, ?)
    ON CONFLICT (tbl) DO UPDATE SET copied = excluded.copied, last_key = excluded.last_key, done = excluded.done`);
  const writeChunk = d.transaction((rows: Array<Record<string, unknown>>, copied: number, lastKey: string) => {
    for (const r of rows) insert.run(toSqlite(r));
    saveProgress.run(table, copied, lastKey, 0);
  });
  const chunk = Math.max(1, o.maxRowsPerChunk ?? 1000);
  let copied = prog?.copied ?? 0;
  let lastKey: string[] | null = prog?.last_key ? JSON.parse(prog.last_key) as string[] : null;
  for (;;) {
    const after = lastKey
      ? sql`WHERE (${keyOf}) > (${sql.join(lastKey)})`
      : sql``;
    let rows = (await sql<Record<string, unknown>>`
      SELECT ${select}, ${keyText} FROM ${sql.table(table)} AS r ${after} ORDER BY ${keyOf} LIMIT ${chunk}`.execute(trx)).rows;
    if (rows.length === 0) break;
    if (pk.length === 0 && rows.length === chunk) {
      // Identical rows share a hash: take the last hash's whole group, or the keyset would skip its twins.
      const h = rows[rows.length - 1].__k0 as string;
      const group = (await sql<Record<string, unknown>>`
        SELECT ${select}, ${keyText} FROM ${sql.table(table)} AS r WHERE md5(r::text) = ${h}`.execute(trx)).rows;
      rows = [...rows.filter((r) => r.__k0 !== h), ...group];
    }
    const next = keyValues(rows[rows.length - 1]);
    writeChunk(rows, copied + rows.length, JSON.stringify(next));
    copied += rows.length;
    lastKey = next;
    o.onProgress?.({ source: 'inbox', table, copied, total });
  }

  // AUTOINCREMENT never reuses an id Postgres already handed out (and freed).
  const seqs: Array<bigint> = [];
  for (const c of pgCols.filter((x) => x.identity === 'YES')) {
    const name = (await sql<{ s: string }>`SELECT pg_get_serial_sequence(${table}, ${c.c}) AS s`.execute(trx)).rows[0].s;
    const r = (await sql<{ v: string; called: boolean }>`SELECT last_value::text AS v, is_called AS called FROM ${sql.raw(name)}`.execute(trx)).rows[0];
    if (r.called) seqs.push(BigInt(r.v));
  }
  const auto = !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? AND sql LIKE '%AUTOINCREMENT%'`).get(table);
  d.transaction(() => {
    const n = (d.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
    if (n !== total) throw new ImportError(`copying ${table} back: ${o.file} has ${n} rows, Postgres has ${total}`);
    if (auto) {
      for (const v of seqs) {
        if (d.prepare(`UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?`).run(v, table).changes === 0) {
          d.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(table, v);
        }
      }
    }
    saveProgress.run(table, copied, lastKey ? JSON.stringify(lastKey) : null, 1);
  })();
  return total;
}
