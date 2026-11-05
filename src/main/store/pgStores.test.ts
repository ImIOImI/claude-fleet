import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import * as db from '../db.js';
import { openPgStores, type PgStores } from './pgStores.js';
import { isPg } from './testStore.js';
import { INBOX_SCHEMA_VERSION } from '../inbox/inboxDb.js';

describe.skipIf(!isPg)('openPgStores', () => {
  const schema = `t_${Math.floor(Date.now() / 1000)}_${randomBytes(6).toString('hex')}`;
  let stores: PgStores | null = null;
  const admin = () => new pg.Client({ connectionString: process.env.PG_TEST_URL });
  afterEach(async () => {
    await stores?.inbox.close();
    await db.closeDb();
    await stores?.end();
    stores = null;
    const c = admin();
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await c.end();
  });

  it('opens state.db and the inbox on one pool, from a DATABASE_URL-style env config', async () => {
    const c = admin();
    await c.connect();
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.end();
    const poolErrors: Error[] = [];
    stores = await openPgStores({ kind: 'postgres', schema, poolMax: 2, connection: { env: 'FLEET_DB' } },
      { state: true, env: { FLEET_DB: process.env.PG_TEST_URL }, onPoolError: (e) => poolErrors.push(e) });
    await db.recordUsageEvent({ workspaceId: 'W', sessionId: null, kind: 'resumed' });
    const { todo } = await stores.inbox.post({ kind: 'user', id: null }, { title: 'pg' }, 1);
    expect(await stores.inbox.get(todo.id)).toMatchObject({ title: 'pg' });
    const tracks = await stores.pool.query(`SELECT track, version FROM ${schema}.schema_migrations ORDER BY track`);
    expect(tracks.rows).toEqual([{ track: 'inbox', version: INBOX_SCHEMA_VERSION }, { track: 'state', version: 14 }]);
    const idle = new Error('idle client terminated');
    stores.pool.emit('error', idle);
    expect(poolErrors).toEqual([idle]);
  });

  it('fails cleanly, leaving nothing open, when the schema is missing', async () => {
    await expect(openPgStores({ kind: 'postgres', schema, poolMax: 2, connection: { connectionString: process.env.PG_TEST_URL! } },
      { state: true, onPoolError: () => undefined })).rejects.toThrow(/does not exist/);
    expect(() => db.stateKysely()).toThrow(/db not opened/);
  });
});

describe('openPgStores failure', () => {
  it('a failed connect names neither the password nor the connection string', async () => {
    const secret = `pw${randomBytes(6).toString('hex')}`;
    let err: Error | null = null;
    try {
      await openPgStores(
        { kind: 'postgres', schema: 'fleet', poolMax: 1, connection: { connectionString: `postgres://u:${secret}@127.0.0.1:1/fleet` } },
        { state: true, onPoolError: () => undefined },
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(`${String(err)} ${err?.stack} ${JSON.stringify(err)}`).not.toContain(secret);
    expect(() => db.stateKysely()).toThrow(/db not opened/);
  });
});
