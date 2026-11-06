// The first-switch copy (remote-workspaces spec §7, part 4b D49): inbox.db and
// state.db rows into an empty Postgres store, ids kept. Chunks commit with
// their progress row, so a failed or interrupted copy resumes; a source file
// that changed since restarts it. The SQLite files are only read.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { sql, type Kysely, type Transaction } from 'kysely';
import { decodeVector } from '../vectors.js';
import type { PgTrack } from './pgMigrate.js';
import { hasHotJournal } from './sqliteFiles.js';
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

/** A `store_import_run` fingerprint no file has, followed by
 *  pgTablesFingerprint of the snapshot the switch back to SQLite wrote out:
 *  the next import replaces these tables only while they still hold exactly that. */
export const EXPORTED_PREFIX = 'exported:';

/** The content of `tables`, order-independent; run it inside one snapshot for a consistent result. */
export async function pgTablesFingerprint(q: Kysely<unknown> | Transaction<unknown>, tables: readonly string[]): Promise<string> {
  const h = createHash('sha256');
  for (const t of tables) {
    const r = (await sql<{ h: string; n: number }>`
      SELECT md5(coalesce(string_agg(md5(r::text), '' ORDER BY md5(r::text)), '')) AS h, count(*) AS n
      FROM ${sql.table(t)} AS r`.execute(q)).rows[0];
    h.update(`${t}:${r.n}:${r.h}\n`);
  }
  return h.digest('hex');
}

export type { ImportProgress };

export type ImportStatus =
  | 'copied'            // this run finished the copy
  | 'already'           // a previous run finished it
  | 'absent'            // no SQLite file
  | 'skipped-nonempty'  // Postgres already held data no import wrote
  | 'skipped-conflict'; // Postgres changed after the switch back wrote it out: both copies kept

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

const FINGERPRINT_ATTEMPTS = 3;

export async function importSqlite(o: ImportOptions): Promise<ImportOutcome> {
  const now = o.now ?? Date.now;
  const tables = IMPORT_TABLES[o.source];
  if (!existsSync(o.file)) return { source: o.source, status: 'absent', counts: {} };
  if (hasHotJournal(o.file)) {
    throw new ImportError(`${o.file} has an unfinished transaction (${basename(o.file)}-journal) that only a read-write open rolls back. `
      + 'Switch back to SQLite: it opens the file as is and recovers it. Nothing was copied.');
  }

  let fingerprint = sourceFingerprint(o.file);
  const src = new Database(o.file, { readonly: true, fileMustExist: true });
  try {
    const v = Number(src.pragma('user_version', { simple: true }));
    if (v !== o.expectedVersion) {
      throw new ImportError(`${o.file} is at schema version ${v}; this build copies version ${o.expectedVersion}. Open it once on SQLite with this build first.`);
    }
    src.defaultSafeIntegers(true);
    const run = (await sql<{ fingerprint: string; finished_at: number | null }>`
      SELECT fingerprint, finished_at FROM store_import_run WHERE source = ${o.source}`.execute(o.k)).rows[0];
    if (run?.finished_at != null) return { source: o.source, status: 'already', counts: {} };
    if (run && run.fingerprint !== fingerprint) {
      if (run.fingerprint.startsWith(EXPORTED_PREFIX)
        && await pgTablesFingerprint(o.k, tables) !== run.fingerprint.slice(EXPORTED_PREFIX.length)) {
        return { source: o.source, status: 'skipped-conflict', counts: {} };
      }
      // Only an import (or the switch back, unchanged since) wrote these rows, and the file is newer.
      await restartImport(o, fingerprint, now());
    } else if (!run) {
      for (const t of tables) {
        const any = await sql<{ x: number }>`SELECT 1 AS x FROM ${sql.table(t)} LIMIT 1`.execute(o.k);
        if (any.rows.length > 0) return { source: o.source, status: 'skipped-nonempty', counts: {} };
      }
      await sql`INSERT INTO store_import_run (source, fingerprint, started_at) VALUES (${o.source}, ${fingerprint}, ${now()})`.execute(o.k);
    }

    for (let attempt = 1; ; attempt++) {
      const counts: Record<string, number> = {};
      for (const t of tables) counts[t] = await copyTable(o, src, t);
      // A write to an already-copied row keeps the counts equal: only the file's fingerprint shows it.
      const after = sourceFingerprint(o.file);
      if (after === fingerprint) {
        await sql`UPDATE store_import_run SET finished_at = ${now()}, counts = ${JSON.stringify(counts)} WHERE source = ${o.source}`.execute(o.k);
        return { source: o.source, status: 'copied', counts };
      }
      if (attempt >= FINGERPRINT_ATTEMPTS) throw new ImportError(`${o.file} kept changing during the copy`);
      fingerprint = after;
      await restartImport(o, fingerprint, now());
    }
  } finally {
    src.close();
  }
}

async function restartImport(o: ImportOptions, fingerprint: string, at: number): Promise<void> {
  await o.k.transaction().execute(async (trx) => {
    await sql.raw(`TRUNCATE ${IMPORT_TABLES[o.source].join(', ')} RESTART IDENTITY`).execute(trx);
    await sql`DELETE FROM store_import WHERE source = ${o.source}`.execute(trx);
    await sql`UPDATE store_import_run SET fingerprint = ${fingerprint}, started_at = ${at} WHERE source = ${o.source}`.execute(trx);
  });
}

const parseVector = (v: unknown): number[] => String(v).replace(/^\[|\]$/g, '').split(',').filter((x) => x !== '').map(Number);

/** One comparable form for a source value and the `::text` Postgres returns for it. */
export function canonicalValue(udt: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const hex = (b: Buffer): string => `\\x${b.toString('hex')}`;
  switch (udt) {
    case 'int2': case 'int4': case 'int8':
      return typeof v === 'number' && Number.isInteger(v) ? BigInt(v).toString() : String(v);
    case 'float4': case 'float8': case 'numeric':
      return String(Number(v));
    case 'vector':
      return Array.from(Float32Array.from(parseVector(v))).join(',');
    default:
      if (Buffer.isBuffer(v)) return hex(v);
      return typeof v === 'string' ? v.replace(/\u0000/g, '�') : String(v);
  }
}

async function copyTable(o: ImportOptions, src: Database.Database, table: string): Promise<number> {
  const exists = src.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  const total = exists ? Number((src.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: bigint }).n) : 0;
  const prog = (await sql<{ last_rowid: string; copied: number; done: boolean }>`
    SELECT last_rowid::text AS last_rowid, copied, done FROM store_import WHERE source = ${o.source} AND tbl = ${table}`.execute(o.k)).rows[0];
  if (prog?.done) return total;
  const pgCols = (await sql<{ c: string; u: string; identity: string }>`
    SELECT column_name AS c, udt_name AS u, is_identity AS identity FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} ORDER BY ordinal_position`.execute(o.k)).rows;
  const sqliteCols = exists ? new Set((src.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((r) => r.name)) : new Set<string>();
  const cols = pgCols.filter((c) => sqliteCols.has(c.c));
  const vectors = new Set(cols.filter((c) => c.u === 'vector').map((c) => c.c));
  const chunk = Math.max(1, Math.min(1000, Math.floor((o.maxParamsPerChunk ?? 30_000) / Math.max(1, cols.length))));
  let last: bigint = BigInt(prog?.last_rowid ?? 0);
  let copied = prog?.copied ?? 0;
  if (exists && cols.length > 0) {
    const select = src.prepare(`SELECT rowid AS __rowid, ${cols.map((c) => `"${c.c}"`).join(', ')} FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`);
    const returning = sql.raw(cols.map((c, i) => `"${c.c}"::text AS c${i}`).join(', '));
    for (;;) {
      const rows = select.all(last, chunk) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      const values = rows.map(({ __rowid: _r, ...row }) => {
        for (const v of vectors) row[v] = `[${Array.from(decodeVector(row[v] as Buffer)).join(',')}]`;
        return row;
      });
      const chunkLast = rows[rows.length - 1].__rowid as bigint;
      const chunkCopied = copied + rows.length;
      const want = values.map((r) => JSON.stringify(cols.map((c) => canonicalValue(c.u, r[c.c])))).sort();
      try {
        await o.k.transaction().execute(async (trx) => {
          const stored = (await sql<Record<string, string | null>>`
            INSERT INTO ${sql.table(table)} (${sql.join(cols.map((c) => sql.ref(c.c)))})
            VALUES ${sql.join(values.map((r) => sql`(${sql.join(cols.map((c) => r[c.c]))})`))}
            RETURNING ${returning}`.execute(trx)).rows;
          const got = stored.map((r) => JSON.stringify(cols.map((c, i) => canonicalValue(c.u, r[`c${i}`])))).sort();
          if (got.some((g, i) => g !== want[i])) throw new ImportError(`copying ${table}: a row Postgres stored differs from ${o.file}`);
          await sql`INSERT INTO store_import (source, tbl, last_rowid, copied, done) VALUES (${o.source}, ${table}, ${chunkLast}, ${chunkCopied}, false)
                    ON CONFLICT (source, tbl) DO UPDATE SET last_rowid = EXCLUDED.last_rowid, copied = EXCLUDED.copied`.execute(trx);
        });
      } catch (e) {
        const pe = e as { code?: string; detail?: string; constraint?: string };
        // Distinct SQLite keys can collide once NUL becomes U+FFFD.
        if (pe.code === '23505') throw new ImportError(`copying ${table}: ${pe.detail ?? 'duplicate key'} (${pe.constraint ?? 'unique'})`);
        throw e;
      }
      last = chunkLast;
      copied = chunkCopied;
      o.onProgress?.({ source: o.source, table, copied, total });
    }
  }
  const hasSeq = !!src.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`).get();
  const seq = hasSeq ? ((src.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(table) as { seq: bigint } | undefined)?.seq ?? 0n) : 0n;
  await o.k.transaction().execute(async (trx) => {
    const n = (await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(trx)).rows[0].n;
    if (n !== total) throw new ImportError(`copying ${table}: Postgres has ${n} rows, ${o.file} has ${total}`);
    // Explicit ids leave an identity's sequence behind; AUTOINCREMENT's high-water mark can be past the max id.
    for (const c of pgCols.filter((x) => x.identity === 'YES')) {
      await sql`SELECT setval(pg_get_serial_sequence(${table}, ${c.c}), GREATEST(m, 1), m > 0) FROM (
        SELECT GREATEST(COALESCE((SELECT max(${sql.ref(c.c)}) FROM ${sql.table(table)}), 0), ${seq}::bigint) AS m) x`.execute(trx);
    }
    await sql`INSERT INTO store_import (source, tbl, last_rowid, copied, done) VALUES (${o.source}, ${table}, ${last}, ${copied}, true)
              ON CONFLICT (source, tbl) DO UPDATE SET done = true`.execute(trx);
  });
  return total;
}
