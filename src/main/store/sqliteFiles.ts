// SQLite files with their sidecars. A -wal/-shm/-journal left beside a missing
// or different database is replayed into whatever file next takes that name,
// so sidecars only ever move together with their database.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Beside inbox.db while the Postgres inbox is the live one; stale once SQLite opens the inbox. */
export const INBOX_PG_MARKER = 'inbox.db.on-postgres';
/** The marker's status while inbox.db is being retired: inbox.db is still the inbox until it is gone. */
export const INBOX_PG_PENDING = 'pending';

/** The Postgres inbox is the live one. */
export function inboxOnPostgres(userData: string): boolean {
  const marker = join(userData, INBOX_PG_MARKER);
  if (!existsSync(marker)) return false;
  if (!existsSync(join(userData, 'inbox.db'))) return true;
  try {
    return (JSON.parse(readFileSync(marker, 'utf8')) as { status?: unknown }).status !== INBOX_PG_PENDING;
  } catch {
    return true;
  }
}

/** 0 when the file is missing. */
export function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const;

const MOVING = '.moving';

/** Moves the file and its sidecars into `<file>.<tag>-<now>/`, under their own
 *  names (the trio opens there as is). Staged in a `.moving` directory that
 *  sweepSqliteSidecars completes after a crash. */
export function retireSqliteFile(file: string, now: number, tag = 'migrated'): string | null {
  if (!existsSync(file)) return null;
  const dest = `${file}.${tag}-${now}`;
  const staging = dest + MOVING;
  const base = basename(file);
  mkdirSync(staging);
  renameSync(file, join(staging, base));
  for (const ext of SQLITE_SIDECARS) if (existsSync(file + ext)) renameSync(file + ext, join(staging, base + ext));
  renameSync(staging, dest);
  return dest;
}

/** Completes interrupted retires, then moves sidecars with no database beside
 *  them into `<file>.orphaned-<now>/`. Returns that directory, or null. */
export function sweepSqliteSidecars(file: string, now: number): string | null {
  const dir = dirname(file);
  const base = basename(file);
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir)) {
    if (!e.startsWith(`${base}.`) || !e.endsWith(MOVING)) continue;
    const staging = join(dir, e);
    if (!existsSync(file)) {
      for (const ext of SQLITE_SIDECARS) {
        if (existsSync(file + ext) && !existsSync(join(staging, base + ext))) renameSync(file + ext, join(staging, base + ext));
      }
    }
    if (readdirSync(staging).length === 0) rmSync(staging, { recursive: true });
    else renameSync(staging, staging.slice(0, -MOVING.length));
  }
  if (existsSync(file)) return null;
  const orphans = SQLITE_SIDECARS.filter((ext) => existsSync(file + ext));
  if (orphans.length === 0) return null;
  const q = `${file}.orphaned-${now}`;
  mkdirSync(q, { recursive: true });
  for (const ext of orphans) renameSync(file + ext, join(q, base + ext));
  return q;
}

export function removeSqliteFile(file: string): void {
  for (const ext of ['', ...SQLITE_SIDECARS]) rmSync(file + ext, { force: true });
}

/** A non-empty rollback journal: an interrupted transaction only a read-write open rolls back. */
export function hasHotJournal(file: string): boolean {
  const j = `${file}-journal`;
  return existsSync(j) && statSync(j).size > 0;
}
