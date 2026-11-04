import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { sql } from 'kysely';
import { sqliteKysely, num, chunked } from './kysely.js';

interface T { t: { v: number } }

function fresh() {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE t (v INTEGER NOT NULL)');
  return { raw, k: sqliteKysely<T>(raw) };
}

describe('num', () => {
  it('normalizes driver aggregate shapes to a number', () => {
    expect(num(3)).toBe(3);
    expect(num('7')).toBe(7);
    expect(num(5n)).toBe(5);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
  });
});

describe('sqliteKysely', () => {
  it('reads and writes through the wrapped better-sqlite3 connection', async () => {
    const { raw, k } = fresh();
    await k.insertInto('t').values({ v: 1 }).execute();
    expect(raw.prepare('SELECT v FROM t').all()).toEqual([{ v: 1 }]);
    expect(await k.selectFrom('t').select('v').execute()).toEqual([{ v: 1 }]);
    await k.destroy();
  });

  it('serializes a query issued during an open transaction behind that transaction', async () => {
    const { k } = fresh();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const tx = k.transaction().execute(async (trx) => {
      await trx.insertInto('t').values({ v: 1 }).execute();
      await gate;
      order.push('tx-end');
    });
    await new Promise((r) => setTimeout(r, 10));
    const outside = k.selectFrom('t').selectAll().execute().then((rows) => { order.push(`outside:${rows.length}`); });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]); // the outside read waits on the connection mutex
    release();
    await tx;
    await outside;
    expect(order).toEqual(['tx-end', 'outside:1']);
    await k.destroy();
  });

  it('rolls back a transaction that throws', async () => {
    const { k } = fresh();
    await expect(k.transaction().execute(async (trx) => {
      await trx.insertInto('t').values({ v: 1 }).execute();
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await k.selectFrom('t').selectAll().execute()).toEqual([]);
    await k.destroy();
  });
});

describe('chunked', () => {
  it('splits items into chunks at the 500-item boundary', () => {
    expect(chunked([])).toEqual([]);
    expect(chunked([1])).toEqual([[1]]);
    expect(chunked(Array.from({ length: 500 }, (_, i) => i))).toHaveLength(1);
    expect(chunked(Array.from({ length: 501 }, (_, i) => i))).toHaveLength(2);
    expect(chunked(Array.from({ length: 1001 }, (_, i) => i))).toHaveLength(3);
  });

  it('preserves order and content when reassembling chunks', () => {
    const items = Array.from({ length: 1001 }, (_, i) => `item-${i}`);
    const chunks = chunked(items);
    const reassembled = chunks.flat();
    expect(reassembled).toEqual(items);
  });
});

describe('sqliteKysely statementCache', () => {
  function counting() {
    const raw = new Database(':memory:');
    raw.exec('CREATE TABLE t (v INTEGER NOT NULL)');
    let prepares = 0;
    const orig = raw.prepare.bind(raw);
    raw.prepare = ((sqlText: string) => { prepares++; return orig(sqlText); }) as typeof raw.prepare;
    return { raw, prepares: () => prepares };
  }

  it('reuses one prepared statement per distinct SQL text', async () => {
    const { raw, prepares } = counting();
    const k = sqliteKysely<T>(raw, { statementCache: 8 });
    for (let i = 0; i < 5; i++) await k.insertInto('t').values({ v: i }).execute();
    expect(prepares()).toBe(1);
    expect(await k.selectFrom('t').select('v').orderBy('v').execute()).toEqual([0, 1, 2, 3, 4].map((v) => ({ v })));
    expect(prepares()).toBe(2);
    await k.destroy();
  });

  it('is off by default (inbox.db keeps preparing per query)', async () => {
    const { raw, prepares } = counting();
    const k = sqliteKysely<T>(raw);
    for (let i = 0; i < 3; i++) await k.insertInto('t').values({ v: i }).execute();
    expect(prepares()).toBe(3);
    await k.destroy();
  });

  it('clears when full instead of growing', async () => {
    const { raw, prepares } = counting();
    const k = sqliteKysely<T>(raw, { statementCache: 2 });
    await k.selectFrom('t').select('v').where('v', '=', 1).execute();
    await k.selectFrom('t').select('v').where('v', '>', 1).execute();
    await k.selectFrom('t').select('v').where('v', '<', 1).execute(); // evicts all
    await k.selectFrom('t').select('v').where('v', '=', 1).execute(); // re-prepared
    expect(prepares()).toBe(4);
    await k.destroy();
  });

  it('destroy() closes the wrapped connection', async () => {
    const { raw } = counting();
    const k = sqliteKysely<T>(raw, { statementCache: 8 });
    await k.selectFrom('t').selectAll().execute();
    await k.destroy();
    expect(raw.open).toBe(false);
  });

  it('skips the cache for SQL text over 2048 chars but still caches short statements', async () => {
    const { raw, prepares } = counting();
    const k = sqliteKysely<T>(raw, { statementCache: 8 });
    const longComment = '/* ' + 'x'.repeat(2050) + ' */';
    await sql`SELECT 1 ${sql.raw(longComment)}`.execute(k);
    await sql`SELECT 1 ${sql.raw(longComment)}`.execute(k);
    expect(prepares()).toBe(2); // not cached: re-prepared every call

    await k.selectFrom('t').select('v').execute();
    await k.selectFrom('t').select('v').execute();
    expect(prepares()).toBe(3); // short statement: prepared once, reused

    await k.destroy();
  });
});
