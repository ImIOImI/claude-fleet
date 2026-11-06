// The switch back from Postgres to SQLite (part 4b D53): the authoritative
// inbox tables into a fresh SQLite file, ids kept. One attempt reads one
// REPEATABLE READ snapshot; chunks commit with their progress row inside the
// file, so a failed attempt resumes while the store's content is unchanged and
// restarts from scratch when it changed. Postgres is only read.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { sql, type Kysely, type Transaction } from 'kysely';
import { INBOX_SCHEMA_VERSION, migrateInboxSqlite } from '../inbox/inboxDb.js';
import { IMPORT_TABLES, ImportError, type ImportProgress } from './storeImport.js';

const TABLES = IMPORT_TABLES.inbox;

const PROGRESS_DDL = `
CREATE TABLE store_export_run (fingerprint TEXT NOT NULL);
CREATE TABLE store_export (tbl TEXT PRIMARY KEY, copied INTEGER NOT NULL, done INTEGER NOT NULL);
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

type Q = Kysely<unknown> | Transaction<unknown>;

async function fingerprintOf(q: Q): Promise<string> {
  const h = createHash('sha256');
  for (const t of TABLES) {
    const r = (await sql<{ h: string; n: number }>`
      SELECT md5(coalesce(string_agg(r::text, E'\\n' ORDER BY r::text COLLATE "C"), '')) AS h, count(*) AS n
      FROM ${sql.table(t)} AS r`.execute(q)).rows[0];
    h.update(`${t}:${r.n}:${r.h}\n`);
  }
  return h.digest('hex');
}

/** The inbox tables' content, from one snapshot. */
export async function pgInboxFingerprint(k: Kysely<unknown>): Promise<string> {
  return k.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute((trx) => fingerprintOf(trx));
}

export function removeSqliteFile(file: string): void {
  for (const ext of ['', '-wal', '-shm', '-journal']) rmSync(file + ext, { force: true });
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
    const fingerprint = await fingerprintOf(trx);
    const d = openPartial(o.file, fingerprint);
    try {
      const counts: Record<string, number> = {};
      for (const t of TABLES) counts[t] = await exportTable(o, trx, d, t);
      d.transaction(() => d.exec('DROP TABLE store_export_run; DROP TABLE store_export;'))();
      return { fingerprint, counts };
    } finally {
      d.close();
    }
  });
}

async function exportTable(o: ExportOptions, trx: Transaction<unknown>, d: Database.Database, table: string): Promise<number> {
  const total = (await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(trx)).rows[0].n;
  const prog = d.prepare('SELECT copied, done FROM store_export WHERE tbl = ?').get(table) as { copied: number; done: number } | undefined;
  if (prog?.done) return total;
  const pgCols = (await sql<{ c: string }>`
    SELECT column_name AS c FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} ORDER BY ordinal_position`.execute(trx)).rows.map((r) => r.c);
  const sqliteCols = new Set((d.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((r) => r.name));
  const cols = pgCols.filter((c) => sqliteCols.has(c));
  if (cols.length === 0) throw new ImportError(`copying ${table} back: inbox.db has no matching columns`);
  const list = cols.map((c) => `"${c}"`).join(', ');
  const insert = d.prepare(`INSERT INTO "${table}" (${list}) VALUES (${cols.map(() => '?').join(', ')})`);
  const saveProgress = d.prepare(`INSERT INTO store_export (tbl, copied, done) VALUES (?, ?, ?)
    ON CONFLICT (tbl) DO UPDATE SET copied = excluded.copied, done = excluded.done`);
  const writeChunk = d.transaction((rows: Array<Record<string, unknown>>, copied: number) => {
    for (const r of rows) insert.run(cols.map((c) => r[c]));
    saveProgress.run(table, copied, 0);
  });
  const chunk = Math.max(1, o.maxRowsPerChunk ?? 1000);
  let copied = prog?.copied ?? 0;
  for (;;) {
    // Whole-row text order is total within the snapshot; claims_fts has no key.
    const rows = (await sql<Record<string, unknown>>`
      SELECT ${sql.raw(list)} FROM ${sql.table(table)} AS r ORDER BY r::text COLLATE "C" LIMIT ${chunk} OFFSET ${copied}`.execute(trx)).rows;
    if (rows.length === 0) break;
    writeChunk(rows, copied + rows.length);
    copied += rows.length;
    o.onProgress?.({ source: 'inbox', table, copied, total });
  }
  d.transaction(() => {
    const n = (d.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
    if (n !== total) throw new ImportError(`copying ${table} back: ${o.file} has ${n} rows, Postgres has ${total}`);
    saveProgress.run(table, copied, 1);
  })();
  return total;
}
