import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { HOST_TRACK, type HostDb } from './hostSchema.js';

describe.skipIf(!isPg)('host track', () => {
  let t: TestPg | null = null;
  afterEach(async () => { await t?.drop(); t = null; });

  it('adds publish_partitions and publish_sessions, keyed by owner account and partition', async () => {
    t = await testPgSchema();
    const k = postgresKysely<HostDb>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    await k.insertInto('publish_partitions').values({ partition_id: 'pub_a', owner_provider: 'github', owner_id: '1', owner_login: 'ann', source_workspace_id: 'W', created_at: 1 }).execute();
    await expect(k.insertInto('publish_partitions').values({ partition_id: 'pub_b', owner_provider: 'github', owner_id: '1', owner_login: 'ann2', source_workspace_id: 'W', created_at: 1 }).execute())
      .rejects.toThrow(/unique/i);
    await k.insertInto('publish_sessions').values({ session_id: 's', partition_id: 'pub_a', source_session_id: 'x', first_published_at: 1, last_published_at: 1 }).execute();
    await expect(k.insertInto('publish_sessions').values({ session_id: 's2', partition_id: 'pub_zz', source_session_id: 'y', first_published_at: 1, last_published_at: 1 }).execute())
      .rejects.toThrow(/foreign key/i);
    const v = await sql<{ version: number }>`SELECT version FROM schema_migrations WHERE track = 'host'`.execute(k);
    expect(Number(v.rows[0].version)).toBe(4);
  });

  it('v3 adds session_owners: one row per broker and claude session, people, machines and automation runs only', async () => {
    t = await testPgSchema();
    const k = postgresKysely<HostDb>(t.pool);
    await migratePostgres(k, t.schema, HOST_TRACK);
    const row = {
      broker_session_id: 'b1', session_id: 's1', workspace_id: 'W', kind: 'user', provider: 'github', account_id: '7',
      login: 'ann', name: null, avatar_url: null, started_at: 1
    };
    await k.insertInto('session_owners').values(row).execute();
    await expect(k.insertInto('session_owners').values({ ...row, account_id: '8', login: 'bob' }).execute()).rejects.toThrow(/unique|duplicate/i);
    await k.insertInto('session_owners').values({ ...row, session_id: 's2' }).execute();
    await k.insertInto('session_owners').values({ ...row, broker_session_id: 'b2', kind: 'automation' }).execute();
    await expect(k.insertInto('session_owners').values({ ...row, broker_session_id: 'b3', kind: 'publisher' }).execute()).rejects.toThrow(/check/i);
  });
});
