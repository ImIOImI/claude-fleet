// Switching the store between SQLite and Postgres (part 4b D49, D53).
// To Postgres: inbox.db first (authoritative, small), then state.db. inbox.db
// is retired once copied so it can't be copied twice or mistaken for the live
// inbox; state.db stays, as the cache a switch back to SQLite resumes from.
// Back to SQLite: the inbox tables into a fresh inbox.db before the choice is
// written; any failure leaves the app on Postgres.
import Database from 'better-sqlite3';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type pg from 'pg';
import { INBOX_SCHEMA_VERSION } from '../inbox/inboxDb.js';
import { STATE_PG_TRACK } from './migrations/statePg.js';
import { migratePostgres } from './pgMigrate.js';
import { postgresKysely, schemaOf } from './postgres.js';
import { exportInboxToSqlite, pgInboxFingerprint, removeSqliteFile, type ExportOutcome } from './storeExport.js';
import {
  EXPORTED_FINGERPRINT, IMPORT_PG_TRACK, IMPORT_TABLES, ImportError, importSqlite, trackVersion, type ImportProgress,
} from './storeImport.js';

/** Renames the file with its -wal/-shm, so the pair stays readable. */
export function retireSqliteFile(file: string, now: number, tag = 'migrated'): string | null {
  if (!existsSync(file)) return null;
  const dest = `${file}.${tag}-${now}`;
  renameSync(file, dest);
  for (const ext of ['-wal', '-shm']) if (existsSync(file + ext)) renameSync(file + ext, dest + ext);
  return dest;
}

export interface FirstSwitchOptions {
  pool: pg.Pool;
  userData: string;
  /** false in mock mode (no state.db), as for openPgStores. */
  state: boolean;
  onProgress: (p: ImportProgress) => void;
  now?: () => number;
}

/** A notice for Settings when something wasn't copied, else null. */
export async function firstSwitchCopy(o: FirstSwitchOptions): Promise<string | null> {
  const now = o.now ?? Date.now;
  const k = postgresKysely<unknown>(o.pool);
  const notes: string[] = [];
  try {
    const inboxFile = join(o.userData, 'inbox.db');
    const inbox = await importSqlite({ k, file: inboxFile, source: 'inbox', expectedVersion: INBOX_SCHEMA_VERSION, onProgress: o.onProgress, now });
    if (inbox.status === 'copied' || inbox.status === 'already') retireSqliteFile(inboxFile, now());
    if (inbox.status === 'skipped-nonempty') {
      notes.push(`inbox.db was not copied: the Postgres store already had inbox data. The file is unchanged at ${inboxFile}.`);
    }
    if (o.state) {
      const state = await importSqlite({
        k, file: join(o.userData, 'state.db'), source: 'state', expectedVersion: trackVersion(STATE_PG_TRACK), onProgress: o.onProgress, now,
      });
      if (state.status === 'skipped-nonempty') notes.push('History was not copied: the Postgres store already had history.');
    }
  } finally {
    await k.destroy();
  }
  return notes.length ? notes.join(' ') : null;
}

/** True when the file may hold inbox data: any row in an inbox table, or unreadable. */
function sqliteInboxHasRows(file: string): boolean {
  if (!existsSync(file)) return false;
  let d: Database.Database | null = null;
  try {
    d = new Database(file, { readonly: true, fileMustExist: true });
    for (const t of IMPORT_TABLES.inbox) {
      if (!d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t)) continue;
      if (d.prepare(`SELECT 1 FROM "${t}" LIMIT 1`).get()) return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    d?.close();
  }
}

export interface SwitchBackOptions {
  /** The live Postgres store; its inbox writers must be stopped, or a write after the copy is not carried over. */
  pool: pg.Pool;
  userData: string;
  onProgress: (p: ImportProgress) => void;
  /** Writes config.json's choice. Runs only once inbox.db is in place; a throw undoes the switch. */
  commit: () => Promise<void>;
  now?: () => number;
}

export type SwitchBackOutcome =
  | { status: 'switched'; counts: Record<string, number> }
  | { status: 'skipped-nonempty'; notice: string };

const EXPORT_ATTEMPTS = 3;

interface RunRow { fingerprint: string; started_at: number; finished_at: number | null; counts: string | null }

/** Copies the Postgres inbox into a fresh inbox.db, then commits the SQLite choice. */
export async function switchBackToSqlite(o: SwitchBackOptions): Promise<SwitchBackOutcome> {
  const now = o.now ?? Date.now;
  const inboxFile = join(o.userData, 'inbox.db');
  if (sqliteInboxHasRows(inboxFile)) {
    return {
      status: 'skipped-nonempty',
      notice: `Not switched: ${inboxFile} already holds inbox data. Move it away to switch back; the app stays on Postgres.`,
    };
  }
  const partial = `${inboxFile}.from-postgres`;
  const k = postgresKysely<unknown>(o.pool);
  try {
    await migratePostgres(k, schemaOf(o.pool), IMPORT_PG_TRACK);
    let out: ExportOutcome | null = null;
    for (let i = 0; i < EXPORT_ATTEMPTS && !out; i++) {
      const copy = await exportInboxToSqlite({ k, file: partial, onProgress: o.onProgress });
      if (await pgInboxFingerprint(k) === copy.fingerprint) out = copy;
    }
    if (!out) {
      removeSqliteFile(partial);
      throw new ImportError('the Postgres inbox kept changing during the copy; the app stays on Postgres');
    }

    retireSqliteFile(inboxFile, now(), 'replaced');
    renameSync(partial, inboxFile);
    try {
      const prev = (await sql<RunRow>`
        SELECT fingerprint, started_at, finished_at, counts FROM store_import_run WHERE source = 'inbox'`.execute(k)).rows[0];
      await markExported(k, now());
      try {
        await o.commit();
      } catch (e) {
        await restoreRun(k, prev);
        throw e;
      }
    } catch (e) {
      renameSync(inboxFile, partial);
      throw e;
    }
    return { status: 'switched', counts: out.counts };
  } finally {
    await k.destroy();
  }
}

/** The next import of inbox.db replaces these tables (storeImport's fingerprint restart). */
async function markExported(k: Kysely<unknown>, at: number): Promise<void> {
  await sql`INSERT INTO store_import_run (source, fingerprint, started_at) VALUES ('inbox', ${EXPORTED_FINGERPRINT}, ${at})
            ON CONFLICT (source) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, started_at = EXCLUDED.started_at,
            finished_at = NULL, counts = NULL`.execute(k);
}

async function restoreRun(k: Kysely<unknown>, prev: RunRow | undefined): Promise<void> {
  if (!prev) {
    await sql`DELETE FROM store_import_run WHERE source = 'inbox'`.execute(k);
    return;
  }
  await sql`UPDATE store_import_run SET fingerprint = ${prev.fingerprint}, started_at = ${prev.started_at},
            finished_at = ${prev.finished_at}, counts = ${prev.counts} WHERE source = 'inbox'`.execute(k);
}
