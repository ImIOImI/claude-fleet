// User-authored state.db rows follow every store switch (SPEC §7 *User-state merge*). The
// rest of state.db is cache: events and rollups re-ingest from transcripts,
// summaries and embeddings regenerate through backfill. The outgoing store
// was the live one, so it wins every collision.
import type Database from 'better-sqlite3';
import { CompiledQuery, sql, type Kysely, type Transaction } from 'kysely';

export interface MergeSpec {
  table: string;
  key: readonly string[];
  /**
   * upsert: insert, or on a key collision overwrite `update` (default: every non-key column).
   * missing: an append-only log with no unique key; insert the outgoing rows the incoming store lacks (as a multiset).
   */
  mode: 'upsert' | 'missing';
  update?: readonly string[];
  /** A local surrogate id: not copied, the incoming store assigns its own (each store's sequence runs independently). */
  localId?: string;
}

export const USER_STATE_MERGE: readonly MergeSpec[] = [
  // Only the rename is user-authored; the rest of the row is re-ingested.
  { table: 'sessions', key: ['id'], mode: 'upsert', update: ['user_set_name'] },
  { table: 'broker_sessions', key: ['workspace_id', 'broker_session_id'], mode: 'upsert' },
  // Derived from transcripts as a union, never removed: union the two stores.
  { table: 'session_tags', key: ['session_id', 'tag'], mode: 'upsert', update: [] },
  { table: 'port_exposures', key: ['id'], mode: 'upsert' },
  { table: 'usage_events', key: ['ts', 'workspace_id', 'session_id', 'kind', 'detail'], mode: 'missing', localId: 'id' },
  { table: 'usage_anchors', key: ['dedup_key'], mode: 'upsert', localId: 'id' },
];

type Row = Record<string, unknown>;

interface Side {
  columns(table: string): Promise<Array<{ c: string; int8: boolean }>>;
  /** `?` placeholders on both dialects. */
  all(text: string, params?: readonly unknown[]): Promise<Row[]>;
  run(text: string, params?: readonly unknown[]): Promise<void>;
}

function sqliteSide(d: Database.Database): Side {
  d.defaultSafeIntegers(true);
  return {
    columns: async (t) => (d.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map((r) => ({ c: r.name, int8: false })),
    all: async (text, params = []) => d.prepare(text).all(...params) as Row[],
    run: async (text, params = []) => { d.prepare(text).run(...params); },
  };
}

function pgSide(q: Kysely<unknown> | Transaction<unknown>): Side {
  const raw = (text: string, params: readonly unknown[]) => {
    let n = 0;
    return CompiledQuery.raw(text.replace(/\?/g, () => `$${++n}`), [...params]);
  };
  return {
    columns: async (t) => (await sql<{ c: string; u: string }>`
      SELECT column_name AS c, udt_name AS u FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ${t} ORDER BY ordinal_position`.execute(q)).rows.map((r) => ({ c: r.c, int8: r.u === 'int8' })),
    all: async (text, params = []) => (await q.executeQuery<Row>(raw(text, params))).rows,
    run: async (text, params = []) => { await q.executeQuery(raw(text, params)); },
  };
}

export interface UserState { tables: Record<string, { cols: string[]; rows: Row[] }> }

const q = (c: string): string => `"${c}"`;

/** Integers as BigInt on both dialects (int8 crosses as text: the pool parses it to a double). */
async function readUserState(s: Side): Promise<UserState> {
  const tables: UserState['tables'] = {};
  for (const m of USER_STATE_MERGE) {
    const cols = (await s.columns(m.table)).filter((c) => c.c !== m.localId);
    const rows = await s.all(`SELECT ${cols.map((c) => (c.int8 ? `${q(c.c)}::text AS ${q(c.c)}` : q(c.c))).join(', ')} FROM ${q(m.table)}`);
    for (const r of rows) for (const c of cols) if (c.int8 && r[c.c] !== null) r[c.c] = BigInt(r[c.c] as string);
    tables[m.table] = { cols: cols.map((c) => c.c), rows };
  }
  return { tables };
}

/** Comparable across dialects: the Postgres side stored NUL as U+FFFD. */
const keyString = (r: Row, key: readonly string[]): string =>
  JSON.stringify(key.map((c) => {
    const v = r[c];
    if (typeof v === 'bigint' || typeof v === 'number') return String(v);
    return typeof v === 'string' ? v.replace(/\u0000/g, '�') : v ?? null;
  }));

async function insertRows(s: Side, table: string, cols: readonly string[], rows: readonly Row[], conflict: string): Promise<void> {
  const per = Math.max(1, Math.floor(900 / Math.max(1, cols.length)));
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const tuple = `(${cols.map(() => '?').join(', ')})`;
    await s.run(`INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES ${part.map(() => tuple).join(', ')} ${conflict}`,
      part.flatMap((r) => cols.map((c) => r[c])));
  }
}

async function applyUserState(s: Side, out: UserState): Promise<void> {
  for (const m of USER_STATE_MERGE) {
    const have = new Set((await s.columns(m.table)).map((c) => c.c));
    const src = out.tables[m.table];
    const cols = src.cols.filter((c) => have.has(c));
    if (m.mode === 'upsert') {
      const update = (m.update ?? cols.filter((c) => !m.key.includes(c))).filter((c) => have.has(c));
      const conflict = update.length
        ? `ON CONFLICT (${m.key.map(q).join(', ')}) DO UPDATE SET ${update.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`
        : `ON CONFLICT (${m.key.map(q).join(', ')}) DO NOTHING`;
      await insertRows(s, m.table, cols, src.rows, conflict);
    } else {
      const seen = new Map<string, number>();
      for (const r of await s.all(`SELECT ${m.key.map(q).join(', ')} FROM ${q(m.table)}`)) {
        const k = keyString(r, m.key);
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      const add = src.rows.filter((r) => {
        const k = keyString(r, m.key);
        const n = seen.get(k) ?? 0;
        if (n > 0) seen.set(k, n - 1);
        return n === 0;
      });
      await insertRows(s, m.table, cols, add, '');
    }
  }
}

/** state.db (opened read-only) into the Postgres store, in the caller's transaction. */
export async function mergeSqliteStateIntoPg(trx: Transaction<unknown>, src: Database.Database): Promise<void> {
  await applyUserState(pgSide(trx), await readUserState(sqliteSide(src)));
}

/** The Postgres store (one snapshot) into state.db (opened read-write), in one SQLite transaction. */
export async function mergePgStateIntoSqlite(k: Kysely<unknown>, dst: Database.Database): Promise<void> {
  const out = await k.transaction().setIsolationLevel('repeatable read').setAccessMode('read only')
    .execute((trx) => readUserState(pgSide(trx)));
  dst.exec('BEGIN IMMEDIATE');
  try {
    await applyUserState(sqliteSide(dst), out);
    dst.exec('COMMIT');
  } catch (e) {
    dst.exec('ROLLBACK');
    throw e;
  }
}
