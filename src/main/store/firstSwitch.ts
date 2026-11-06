// Switching the store between SQLite and Postgres (SPEC §7 *First-switch copy*, *Switch back to SQLite*).
// To Postgres: inbox.db first (authoritative, small), then state.db. inbox.db
// is retired once copied so it can't be copied twice or mistaken for the live
// inbox; state.db stays, as the cache a switch back to SQLite resumes from.
// Back to SQLite: the inbox tables into a fresh inbox.db before the choice is
// written; any failure leaves the app on Postgres.
import Database from 'better-sqlite3';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type pg from 'pg';
import { INBOX_SCHEMA_VERSION } from '../inbox/inboxDb.js';
import { STATE_PG_TRACK } from './migrations/statePg.js';
import { migratePostgres } from './pgMigrate.js';
import { postgresKysely, schemaOf } from './postgres.js';
import { hasHotJournal, INBOX_PG_MARKER, INBOX_PG_PENDING, inboxOnPostgres, removeSqliteFile, retireSqliteFile, sweepSqliteSidecars } from './sqliteFiles.js';
import { exportInboxToSqlite, pgInboxFingerprint, type ExportOutcome } from './storeExport.js';
import {
  EXPORTED_PREFIX, IMPORT_PG_TRACK, IMPORT_TABLES, ImportError, importSqlite, sourceFingerprint, trackVersion, type ImportProgress,
} from './storeImport.js';
import { mergePgStateIntoSqlite, mergeSqliteStateIntoPg } from './userStateMerge.js';

export { retireSqliteFile };

type LiveStatus = typeof INBOX_PG_PENDING | 'live' | 'skipped-nonempty' | 'skipped-conflict';

const markerPath = (userData: string): string => join(userData, INBOX_PG_MARKER);

/** How to resolve two inboxes by hand (both skip notices and the refused switch back say it). */
const moveAside = (inboxFile: string, dir: string): string =>
  `Switching back to SQLite is refused while it is there. To keep only the Postgres inbox, quit the app and move ${inboxFile} (with any inbox.db-wal and inbox.db-shm) out of ${dir}.`;
const readMarker = (userData: string): string | null => (existsSync(markerPath(userData)) ? readFileSync(markerPath(userData), 'utf8') : null);
const writeMarker = (userData: string, status: LiveStatus, at: number): void =>
  writeFileSync(markerPath(userData), JSON.stringify({ status, at }));

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
    sweepSqliteSidecars(inboxFile, now());
    const inbox = await importSqlite({ k, file: inboxFile, source: 'inbox', expectedVersion: INBOX_SCHEMA_VERSION, onProgress: o.onProgress, now });
    if (inbox.status === 'copied' || inbox.status === 'already' || inbox.status === 'absent') {
      // A crash mid-retire must not leave inbox.db gone with no marker: a SQLite start would open an empty inbox.
      writeMarker(o.userData, INBOX_PG_PENDING, now());
      retireSqliteFile(inboxFile, now());
      writeMarker(o.userData, 'live', now());
    } else {
      writeMarker(o.userData, inbox.status, now());
      notes.push(`${inbox.status === 'skipped-nonempty'
        ? 'inbox.db was not copied: the Postgres store already had inbox data.'
        : 'inbox.db was not copied: it and the Postgres inbox both changed since they were last in step.'} `
        + `Both are kept: Postgres is in use, and inbox.db is unchanged at ${inboxFile}. ${moveAside(inboxFile, o.userData)}`);
    }
    if (o.state) {
      const stateFile = join(o.userData, 'state.db');
      const state = await importSqlite({
        k, file: stateFile, source: 'state', expectedVersion: trackVersion(STATE_PG_TRACK), onProgress: o.onProgress, now,
      });
      if (state.status === 'skipped-nonempty') notes.push('History was not copied: the Postgres store already had history.');
      if (state.status === 'already') await mergeStateIfChanged(k, stateFile);
    }
  } finally {
    await k.destroy();
  }
  return notes.length ? notes.join(' ') : null;
}

/** state.db changed since Postgres last saw it only when the app ran on SQLite in between. */
async function mergeStateIfChanged(k: Kysely<unknown>, stateFile: string): Promise<void> {
  const fp = sourceFingerprint(stateFile);
  const run = (await sql<{ fingerprint: string }>`SELECT fingerprint FROM store_import_run WHERE source = 'state'`.execute(k)).rows[0];
  if (!run || run.fingerprint === fp) return;
  const src = new Database(stateFile, { readonly: true, fileMustExist: true });
  try {
    await k.transaction().execute(async (trx) => {
      await mergeSqliteStateIntoPg(trx, src);
      await sql`UPDATE store_import_run SET fingerprint = ${fp} WHERE source = 'state'`.execute(trx);
    });
  } finally {
    src.close();
  }
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

/** Null when every inbox table of the placed file holds the copied count. */
export function verifyPlacedInbox(file: string, counts: Record<string, number>): string | null {
  let d: Database.Database | null = null;
  try {
    d = new Database(file, { readonly: true, fileMustExist: true });
    const v = d.pragma('user_version', { simple: true });
    if (v !== INBOX_SCHEMA_VERSION) return `schema version ${String(v)}, expected ${INBOX_SCHEMA_VERSION}`;
    for (const t of IMPORT_TABLES.inbox) {
      const n = (d.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
      if (n !== counts[t]) return `${t}: ${n} rows, the copy had ${counts[t]}`;
    }
    return null;
  } catch (e) {
    return `unreadable: ${(e as Error).message}`;
  } finally {
    d?.close();
  }
}

export type SwitchBackPlan =
  /** inbox.db is still the authoritative inbox (the copy to Postgres never finished): switching back only writes the choice. */
  | { kind: 'keep-inbox-db'; notice: string | null }
  | { kind: 'refuse'; notice: string }
  | { kind: 'copy' };

/** Decided from userData alone, so it works while Postgres is unreachable. */
export function switchBackPlan(userData: string, now = Date.now()): SwitchBackPlan {
  const inboxFile = join(userData, 'inbox.db');
  sweepSqliteSidecars(inboxFile, now);
  if (!existsSync(inboxFile)) return { kind: 'copy' };
  if (!inboxOnPostgres(userData)) {
    return {
      kind: 'keep-inbox-db',
      notice: hasHotJournal(inboxFile) ? 'inbox.db has an unfinished transaction; SQLite rolls it back when it opens the file.' : null,
    };
  }
  if (sqliteInboxHasRows(inboxFile)) {
    return { kind: 'refuse', notice: `Not switched; the app stays on Postgres: ${inboxFile} holds a separate inbox. ${moveAside(inboxFile, userData)}` };
  }
  return { kind: 'copy' };
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
  | { status: 'switched'; counts: Record<string, number>; kept?: true; notice?: string | null }
  | { status: 'skipped-nonempty'; notice: string };

const EXPORT_ATTEMPTS = 3;

interface RunRow { fingerprint: string; started_at: number; finished_at: number | null; counts: string | null }

/** Copies the Postgres inbox into a fresh inbox.db, then commits the SQLite choice. */
export async function switchBackToSqlite(o: SwitchBackOptions): Promise<SwitchBackOutcome> {
  const now = o.now ?? Date.now;
  const plan = switchBackPlan(o.userData, now());
  if (plan.kind === 'keep-inbox-db') {
    await o.commit();
    return { status: 'switched', counts: {}, kept: true, notice: plan.notice };
  }
  if (plan.kind === 'refuse') return { status: 'skipped-nonempty', notice: plan.notice };

  const inboxFile = join(o.userData, 'inbox.db');
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
    await mergeStateBack(k, join(o.userData, 'state.db'));

    retireSqliteFile(inboxFile, now(), 'replaced');
    sweepSqliteSidecars(inboxFile, now());
    renameSync(partial, inboxFile);
    const takeBack = (): void => {
      renameSync(inboxFile, partial);
      sweepSqliteSidecars(inboxFile, now());
    };
    const bad = verifyPlacedInbox(inboxFile, out.counts);
    if (bad) {
      takeBack();
      throw new ImportError(`the copied inbox.db does not match Postgres (${bad}); the app stays on Postgres`);
    }
    try {
      const prev = (await sql<RunRow>`
        SELECT fingerprint, started_at, finished_at, counts FROM store_import_run WHERE source = 'inbox'`.execute(k)).rows[0];
      await markExported(k, `${EXPORTED_PREFIX}${out.fingerprint}`, now());
      const marker = readMarker(o.userData);
      rmSync(markerPath(o.userData), { force: true });
      try {
        await o.commit();
      } catch (e) {
        if (marker !== null) writeFileSync(markerPath(o.userData), marker);
        await restoreRun(k, prev);
        throw e;
      }
    } catch (e) {
      takeBack();
      throw e;
    }
    return { status: 'switched', counts: out.counts };
  } finally {
    await k.destroy();
  }
}

/** User-authored state rows into state.db, when Postgres history came from it (SPEC §7 *User-state merge*). */
async function mergeStateBack(k: Kysely<unknown>, stateFile: string): Promise<void> {
  if (!existsSync(stateFile)) return;
  const run = (await sql<{ finished_at: number | null }>`SELECT finished_at FROM store_import_run WHERE source = 'state'`.execute(k)).rows[0];
  if (run?.finished_at == null) return;
  const dst = new Database(stateFile);
  try {
    await mergePgStateIntoSqlite(k, dst);
  } finally {
    dst.close();
  }
  // The merge is not a SQLite-side change: the next Postgres start must not merge it back over newer rows.
  await sql`UPDATE store_import_run SET fingerprint = ${sourceFingerprint(stateFile)} WHERE source = 'state'`.execute(k);
}

/** The next import of inbox.db replaces these tables while they still hold the exported snapshot. */
async function markExported(k: Kysely<unknown>, fingerprint: string, at: number): Promise<void> {
  await sql`INSERT INTO store_import_run (source, fingerprint, started_at) VALUES ('inbox', ${fingerprint}, ${at})
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
