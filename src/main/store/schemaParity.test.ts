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

interface Shape {
  columns: Record<string, { notNull: boolean }>;
  pk: string[];
  uniques: string[];
  /** Explicitly named indexes (CREATE INDEX, not a PK/UNIQUE constraint's
   *  auto-named backing index): name -> ordered column list, '<expr>' for a
   *  non-column key part (e.g. todos_dedupe's IFNULL/COALESCE expression). */
  indexes: Record<string, string[]>;
}

function sqliteShapes(raw: Database.Database): Record<string, Shape> {
  const out: Record<string, Shape> = {};
  const all = raw.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string; sql: string | null }[];
  // An FTS5 virtual table (inbox claims_fts) is compared by its declared
  // columns; its shadow tables are SQLite internals with no Postgres twin.
  const fts5 = all.filter((t) => /^CREATE VIRTUAL TABLE .* USING fts5/i.test(t.sql ?? '')).map((t) => t.name);
  const shadow = new Set(fts5.flatMap((v) => ['data', 'idx', 'content', 'docsize', 'config'].map((x) => `${v}_${x}`)));
  const tables = all.filter((t) => !shadow.has(t.name));
  for (const { name } of tables) {
    const cols = raw.prepare(`PRAGMA table_info(${name})`).all() as { name: string; notnull: number; pk: number }[];
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const uniques = (raw.prepare(`PRAGMA index_list(${name})`).all() as { name: string; unique: number; origin: string; partial: number }[])
      .filter((i) => i.unique && i.origin !== 'pk' && !i.partial)
      .map((i) => (raw.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name).join(','))
      .sort();
    // Auto-indexes backing a PK/UNIQUE constraint have a NULL sql column; only
    // explicit CREATE INDEX statements are named on both dialects.
    const idxNames = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).all(name) as { name: string }[]);
    const indexes: Record<string, string[]> = {};
    for (const { name: idxName } of idxNames) {
      const info = raw.prepare(`PRAGMA index_info(${idxName})`).all() as { name: string | null }[];
      indexes[idxName] = info.map((c) => c.name ?? '<expr>');
    }
    out[name] = {
      columns: Object.fromEntries(cols.map((c) => [c.name, { notNull: c.notnull === 1 || pk.includes(c.name) }])),
      pk, uniques, indexes,
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
    out[r.t] ??= { columns: {}, pk: [], uniques: [], indexes: {} };
    out[r.t].columns[r.c] = { notNull: r.nn === 'NO' };
  }
  for (const r of keys) {
    if (r.kind === 'p') out[r.t].pk = r.cols.split(',');
    else out[r.t].uniques.push(r.cols);
  }
  for (const s of Object.values(out)) s.uniques.sort();
  // Excludes a PK/UNIQUE constraint's auto-named backing index. No non-btree
  // index exists in this schema (D30: exact search, no HNSW); if one is added
  // later it belongs in a separate, dialect-specific assertion, not here.
  const idx = (await sql<{ t: string; name: string; cols: string }>`
    SELECT tc.relname AS t, ic.relname AS name,
           string_agg(COALESCE(att.attname, '<expr>'), ',' ORDER BY k.ord) AS cols
    FROM pg_index ix
    JOIN pg_class ic ON ic.oid = ix.indexrelid
    JOIN pg_class tc ON tc.oid = ix.indrelid
    JOIN pg_namespace ns ON ns.oid = tc.relnamespace
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
    LEFT JOIN pg_attribute att ON att.attrelid = ix.indrelid AND att.attnum = k.attnum AND k.attnum <> 0
    WHERE ns.nspname = ${schema} AND tc.relname <> 'schema_migrations'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
    GROUP BY tc.relname, ic.relname`.execute(k)).rows;
  for (const r of idx) out[r.t].indexes[r.name] = r.cols.split(',');
  return out;
}

describe.skipIf(!isPg)('Postgres baseline schema parity', () => {
  it('state schema mirrors state.db at its current user_version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-parity-'));
    const raw = db.openDb(dir);
    const want = sqliteShapes(raw);
    // A placeholder's vec is NULL on Postgres (vector(384) has no empty value);
    // SQLite keeps NOT NULL and stores an empty BLOB.
    want.embeddings.columns.vec = { notNull: false };
    // SQLite's index ends in the rowid implicitly; Postgres names id (step 19).
    want.events.indexes.idx_events_session_type = [...want.events.indexes.idx_events_session_type, 'id'];
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
