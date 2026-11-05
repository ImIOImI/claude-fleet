// Postgres baselines ≡ the SQLite schemas they mirror: same tables, columns,
// NOT NULL, primary keys and unique keys. Runs only on the Postgres suite.
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import * as db from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { isPg, testPgSchema } from './testStore.js';
import { postgresKysely } from './postgres.js';

interface Shape { columns: Record<string, { notNull: boolean }>; pk: string[]; uniques: string[] }

function sqliteShapes(raw: Database.Database): Record<string, Shape> {
  const out: Record<string, Shape> = {};
  const tables = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
  for (const { name } of tables) {
    const cols = raw.prepare(`PRAGMA table_info(${name})`).all() as { name: string; notnull: number; pk: number }[];
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const uniques = (raw.prepare(`PRAGMA index_list(${name})`).all() as { name: string; unique: number; origin: string; partial: number }[])
      .filter((i) => i.unique && i.origin !== 'pk' && !i.partial)
      .map((i) => (raw.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name).join(','))
      .sort();
    out[name] = {
      columns: Object.fromEntries(cols.map((c) => [c.name, { notNull: c.notnull === 1 || pk.includes(c.name) }])),
      pk, uniques,
    };
  }
  return out;
}

async function pgShapes(schema: string, k: ReturnType<typeof postgresKysely>): Promise<Record<string, Shape>> {
  const cols = (await sql<{ t: string; c: string; nn: string }>`
    SELECT table_name AS t, column_name AS c, is_nullable AS nn FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name <> 'schema_migrations' ORDER BY table_name, ordinal_position`.execute(k)).rows;
  const keys = (await sql<{ t: string; kind: string; cols: string }>`
    SELECT rel.relname AS t, con.contype AS kind,
           string_agg(att.attname, ',' ORDER BY k.ord) AS cols
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = k.attnum
    WHERE ns.nspname = ${schema} AND con.contype IN ('p', 'u') AND rel.relname <> 'schema_migrations'
    GROUP BY rel.relname, con.conname, con.contype`.execute(k)).rows;
  const out: Record<string, Shape> = {};
  for (const r of cols) {
    out[r.t] ??= { columns: {}, pk: [], uniques: [] };
    out[r.t].columns[r.c] = { notNull: r.nn === 'NO' };
  }
  for (const r of keys) {
    if (r.kind === 'p') out[r.t].pk = r.cols.split(',');
    else out[r.t].uniques.push(r.cols);
  }
  for (const s of Object.values(out)) s.uniques.sort();
  return out;
}

describe.skipIf(!isPg)('Postgres baseline schema parity', () => {
  it('state baseline mirrors state.db at user_version 14', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-parity-'));
    const raw = db.openDb(dir);
    const want = sqliteShapes(raw);
    await db.closeDb();
    rmSync(dir, { recursive: true, force: true });
    const t = await testPgSchema();
    try {
      await db.openDbPostgres(t.pool);
      expect(await pgShapes(t.schema, postgresKysely(t.pool))).toEqual(want);
    } finally {
      await db.closeDb();
      await t.drop();
    }
  });

  it('inbox baseline mirrors inbox.db at INBOX_SCHEMA_VERSION', async () => {
    const mem = InboxStore.memory();
    const want = sqliteShapes((mem as unknown as { raw: Database.Database }).raw);
    await mem.close();
    const t = await testPgSchema();
    try {
      const store = await InboxStore.openPostgres(t.pool);
      expect(await pgShapes(t.schema, postgresKysely(t.pool))).toEqual(want);
      await store.close();
    } finally {
      await t.drop();
    }
  });
});
