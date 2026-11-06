import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { pingStore } from './pgStores.js';

const pool = (query: () => Promise<unknown>): pg.Pool => ({ query } as unknown as pg.Pool);

describe('pingStore', () => {
  it('resolves when the store answers', async () => {
    await expect(pingStore(pool(async () => ({ rows: [{ '?column?': 1 }] })))).resolves.toBeUndefined();
  });

  it('rejects with the query error', async () => {
    await expect(pingStore(pool(async () => { throw new Error('connect ECONNREFUSED'); }))).rejects.toThrow('connect ECONNREFUSED');
  });

  it('rejects when the store does not answer in time', async () => {
    await expect(pingStore(pool(() => new Promise(() => undefined)), 20)).rejects.toThrow('no answer within 20 ms');
  });
});
