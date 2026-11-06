// The first-switch copy (remote-workspaces spec §7, part 4b D49): inbox.db and
// state.db rows into an empty Postgres store, ids kept. Chunks commit with
// their progress row, so a failed or interrupted copy resumes; a source file
// that changed since restarts it. The SQLite files are only read.
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { decodeVector } from '../vectors.js';
import type { PgTrack } from './pgMigrate.js';
import type { ImportProgress } from '../../preload/storeTypes.js';

export const IMPORT_PG_TRACK: PgTrack = {
  track: 'import',
  baselineVersion: 1,
  baseline: `
CREATE TABLE store_import_run (
  source TEXT COLLATE "C" PRIMARY KEY,
  fingerprint TEXT COLLATE "C" NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  counts TEXT COLLATE "C"
);
CREATE TABLE store_import (
  source TEXT COLLATE "C" NOT NULL,
  tbl TEXT COLLATE "C" NOT NULL,
  last_rowid BIGINT NOT NULL,
  copied BIGINT NOT NULL,
  done BOOLEAN NOT NULL,
  PRIMARY KEY (source, tbl)
);
`,
  steps: [],
};

export type ImportSource = 'inbox' | 'state';

/** Every table of each store, in copy order. storeImport.test.ts pins these to the tracks. */
export const IMPORT_TABLES: Record<ImportSource, readonly string[]> = {
  inbox: ['todos', 'tags', 'todo_events', 'notifications', 'notification_rules', 'downtimes', 'notify_state',
    'automations', 'automation_versions', 'automation_state', 'runs', 'step_runs', 'proposals',
    'claims', 'claim_sources', 'claim_vectors', 'claims_fts', 'capture_runs', 'capture_settings_log'],
  state: ['sessions', 'events', 'broker_sessions', 'errors', 'embeddings', 'session_summaries', 'session_tags',
    'usage_events', 'usage_anchors', 'perf_events', 'session_costs', 'session_stats', 'session_tool_counts',
    'port_exposures'],
};

/** The SQLite user_version a track's latest step mirrors. */
export const trackVersion = (t: PgTrack): number => Math.max(t.baselineVersion, ...t.steps.map((s) => s.version));

/** A `store_import_run` fingerprint no file has: the switch back to SQLite
 *  wrote this source's tables out, so the next import replaces them. */
export const EXPORTED_FINGERPRINT = 'exported';

export type { ImportProgress };

export type ImportStatus =
  | 'copied'            // this run finished the copy
  | 'already'           // a previous run finished it
  | 'absent'            // no SQLite file
  | 'skipped-nonempty'; // Postgres already held data no import wrote

export interface ImportOutcome { source: ImportSource; status: ImportStatus; counts: Record<string, number> }

export interface ImportOptions {
  /** A handle on the store pool; nothing else may write the store until this returns. */
  k: Kysely<unknown>;
  file: string;
  source: ImportSource;
  /** The SQLite user_version this build migrates to (refuses an older or newer file). */
  expectedVersion: number;
  onProgress?: (p: ImportProgress) => void;
  now?: () => number;
  /** Bounded by Postgres's 65,535 bind parameters per statement. */
  maxParamsPerChunk?: number;
}

export class ImportError extends Error {}

/** Size and mtime of the file and its WAL: a write between attempts changes
 *  it. An empty WAL counts as none: opening the file read-only creates one. */
export function sourceFingerprint(file: string): string {
  const part = (p: string): string => {
    if (!existsSync(p)) return '-';
    const s = statSync(p);
    return s.size === 0 ? '-' : `${s.size}:${Math.trunc(s.mtimeMs)}`;
  };
  return `${part(file)}|${part(`${file}-wal`)}`;
}

export async function importSqlite(o: ImportOptions): Promise<ImportOutcome> {
  const now = o.now ?? Date.now;
  const tables = IMPORT_TABLES[o.source];
  if (!existsSync(o.file)) return { source: o.source, status: 'absent', counts: {} };

  const fingerprint = sourceFingerprint(o.file);
  const src = new Database(o.file, { readonly: true, fileMustExist: true });
  try {
    const v = src.pragma('user_version', { simple: true }) as number;
    if (v !== o.expectedVersion) {
      throw new ImportError(`${o.file} is at schema version ${v}; this build copies version ${o.expectedVersion}. Open it once on SQLite with this build first.`);
    }
    const run = (await sql<{ fingerprint: string; finished_at: number | null }>`
      SELECT fingerprint, finished_at FROM store_import_run WHERE source = ${o.source}`.execute(o.k)).rows[0];
    if (run?.finished_at != null) return { source: o.source, status: 'already', counts: {} };
    if (run && run.fingerprint !== fingerprint) {
      // Only an import (or the switch back, EXPORTED_FINGERPRINT) wrote these
      // rows, and the file is now newer than them.
      await o.k.transaction().execute(async (trx) => {
        await sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY`).execute(trx);
        await sql`DELETE FROM store_import WHERE source = ${o.source}`.execute(trx);
        await sql`UPDATE store_import_run SET fingerprint = ${fingerprint}, started_at = ${now()} WHERE source = ${o.source}`.execute(trx);
      });
    } else if (!run) {
      for (const t of tables) {
        const any = await sql<{ x: number }>`SELECT 1 AS x FROM ${sql.table(t)} LIMIT 1`.execute(o.k);
        if (any.rows.length > 0) return { source: o.source, status: 'skipped-nonempty', counts: {} };
      }
      await sql`INSERT INTO store_import_run (source, fingerprint, started_at) VALUES (${o.source}, ${fingerprint}, ${now()})`.execute(o.k);
    }

    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = await copyTable(o, src, t);
    await sql`UPDATE store_import_run SET finished_at = ${now()}, counts = ${JSON.stringify(counts)} WHERE source = ${o.source}`.execute(o.k);
    return { source: o.source, status: 'copied', counts };
  } finally {
    src.close();
  }
}

async function copyTable(o: ImportOptions, src: Database.Database, table: string): Promise<number> {
  const exists = src.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  const total = exists ? (src.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n : 0;
  const prog = (await sql<{ last_rowid: number; copied: number; done: boolean }>`
    SELECT last_rowid, copied, done FROM store_import WHERE source = ${o.source} AND tbl = ${table}`.execute(o.k)).rows[0];
  if (prog?.done) return total;
  const pgCols = (await sql<{ c: string; u: string; identity: string }>`
    SELECT column_name AS c, udt_name AS u, is_identity AS identity FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} ORDER BY ordinal_position`.execute(o.k)).rows;
  const sqliteCols = exists ? new Set((src.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((r) => r.name)) : new Set<string>();
  const cols = pgCols.filter((c) => sqliteCols.has(c.c));
  const vectors = new Set(cols.filter((c) => c.u === 'vector').map((c) => c.c));
  const chunk = Math.max(1, Math.min(1000, Math.floor((o.maxParamsPerChunk ?? 30_000) / Math.max(1, cols.length))));
  let last = prog?.last_rowid ?? 0;
  let copied = prog?.copied ?? 0;
  if (exists && cols.length > 0) {
    const select = src.prepare(`SELECT rowid AS __rowid, ${cols.map((c) => `"${c.c}"`).join(', ')} FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`);
    for (;;) {
      const rows = select.all(last, chunk) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      const values = rows.map(({ __rowid: _r, ...row }) => {
        for (const v of vectors) row[v] = `[${Array.from(decodeVector(row[v] as Buffer)).join(',')}]`;
        return row;
      });
      last = rows[rows.length - 1].__rowid as number;
      copied += rows.length;
      // Text params lose NUL to U+FFFD in the dialect (postgres.ts sanitizeNul); the row count is unchanged.
      await o.k.transaction().execute(async (trx) => {
        await trx.insertInto(table as never).values(values as never).execute();
        await sql`INSERT INTO store_import (source, tbl, last_rowid, copied, done) VALUES (${o.source}, ${table}, ${last}, ${copied}, false)
                  ON CONFLICT (source, tbl) DO UPDATE SET last_rowid = EXCLUDED.last_rowid, copied = EXCLUDED.copied`.execute(trx);
      });
      o.onProgress?.({ source: o.source, table, copied, total });
    }
  }
  await o.k.transaction().execute(async (trx) => {
    const n = (await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(trx)).rows[0].n;
    if (n !== total) throw new ImportError(`copying ${table}: Postgres has ${n} rows, ${o.file} has ${total}`);
    // Explicit ids leave an identity's sequence behind: the next insert would collide.
    for (const c of pgCols.filter((x) => x.identity === 'YES')) {
      await sql`SELECT setval(pg_get_serial_sequence(${table}, ${c.c}), COALESCE((SELECT max(${sql.ref(c.c)}) FROM ${sql.table(table)}), 1), (SELECT count(*) > 0 FROM ${sql.table(table)}))`.execute(trx);
    }
    await sql`INSERT INTO store_import (source, tbl, last_rowid, copied, done) VALUES (${o.source}, ${table}, ${last}, ${copied}, true)
              ON CONFLICT (source, tbl) DO UPDATE SET done = true`.execute(trx);
  });
  return total;
}
