import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { hasHotJournal, retireSqliteFile, sweepSqliteSidecars } from './sqliteFiles.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-sqlfiles-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('retireSqliteFile moves the file and every sidecar into one directory', () => {
  for (const f of ['inbox.db', 'inbox.db-wal', 'inbox.db-shm', 'inbox.db-journal']) writeFileSync(join(dir, f), 'x');
  expect(retireSqliteFile(join(dir, 'inbox.db'), 7)).toBe(join(dir, 'inbox.db.migrated-7'));
  expect(readdirSync(dir)).toEqual(['inbox.db.migrated-7']);
  expect(readdirSync(join(dir, 'inbox.db.migrated-7')).sort()).toEqual(['inbox.db', 'inbox.db-journal', 'inbox.db-shm', 'inbox.db-wal']);
  expect(retireSqliteFile(join(dir, 'inbox.db'), 8)).toBeNull();
});

it('a retired WAL database still opens with its uncheckpointed rows', () => {
  const f = join(dir, 'inbox.db');
  const w = new Database(f);
  w.pragma('journal_mode = WAL');
  w.pragma('wal_autocheckpoint = 0');
  w.exec('CREATE TABLE t (a)');
  for (let i = 0; i < 10; i++) w.prepare('INSERT INTO t VALUES (?)').run(i);
  // Copy the live pair as a crash would leave it, then retire the copy.
  const crashed = join(dir, 'crashed');
  mkdirSync(crashed);
  for (const s of ['', '-wal']) writeFileSync(join(crashed, `inbox.db${s}`), readFileSync(f + s));
  w.close();
  const dest = retireSqliteFile(join(crashed, 'inbox.db'), 1)!;
  const r = new Database(join(dest, 'inbox.db'), { readonly: true });
  expect((r.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(10);
  r.close();
});

it('sweepSqliteSidecars quarantines sidecars that have no database beside them', () => {
  writeFileSync(join(dir, 'inbox.db-wal'), 'foreign');
  writeFileSync(join(dir, 'inbox.db-shm'), 'foreign');
  expect(sweepSqliteSidecars(join(dir, 'inbox.db'), 5)).toBe(join(dir, 'inbox.db.orphaned-5'));
  expect(readdirSync(dir)).toEqual(['inbox.db.orphaned-5']);
  expect(sweepSqliteSidecars(join(dir, 'inbox.db'), 6)).toBeNull();
});

it('sweepSqliteSidecars leaves the sidecars of a present database alone', () => {
  for (const f of ['inbox.db', 'inbox.db-wal', 'inbox.db-journal']) writeFileSync(join(dir, f), 'x');
  expect(sweepSqliteSidecars(join(dir, 'inbox.db'), 5)).toBeNull();
  expect(readdirSync(dir).sort()).toEqual(['inbox.db', 'inbox.db-journal', 'inbox.db-wal']);
});

it('sweepSqliteSidecars finishes a retire interrupted after the main file moved', () => {
  mkdirSync(join(dir, 'inbox.db.migrated-3.moving'));
  writeFileSync(join(dir, 'inbox.db.migrated-3.moving', 'inbox.db'), 'main');
  writeFileSync(join(dir, 'inbox.db-wal'), 'its wal');
  expect(sweepSqliteSidecars(join(dir, 'inbox.db'), 9)).toBeNull();
  expect(readdirSync(dir)).toEqual(['inbox.db.migrated-3']);
  expect(readdirSync(join(dir, 'inbox.db.migrated-3')).sort()).toEqual(['inbox.db', 'inbox.db-wal']);
});

it('InboxStore.open does not adopt an orphan WAL', async () => {
  const o = join(dir, 'other.db');
  const x = new Database(o);
  x.pragma('journal_mode = WAL');
  x.pragma('wal_autocheckpoint = 0');
  x.exec('CREATE TABLE z (a)');
  for (let i = 0; i < 50; i++) x.prepare('INSERT INTO z VALUES (?)').run('x'.repeat(500));
  writeFileSync(join(dir, 'inbox.db-wal'), readFileSync(`${o}-wal`));
  x.close();
  const inbox = InboxStore.open(dir);
  try {
    await inbox.post({ kind: 'user', id: 'me' }, { title: 'fresh' });
    expect((await inbox.list({})).map((t) => t.title)).toEqual(['fresh']);
  } finally {
    await inbox.close();
  }
  expect(readdirSync(dir).some((f) => f.startsWith('inbox.db.orphaned-'))).toBe(true);
});

it('hasHotJournal is true only for a non-empty -journal', () => {
  const f = join(dir, 'x.db');
  writeFileSync(f, '');
  expect(hasHotJournal(f)).toBe(false);
  writeFileSync(`${f}-journal`, '');
  expect(hasHotJournal(f)).toBe(false);
  writeFileSync(`${f}-journal`, 'x');
  expect(hasHotJournal(f)).toBe(true);
});
