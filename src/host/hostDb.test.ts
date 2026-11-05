import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';
import { isPg } from '../main/store/testStore.js';
import { openHostDb, openHostDbRetrying, startDbHealth, type HostDbHandle } from './hostDb.js';
import { createLogger } from './log.js';

const quiet = createLogger(() => undefined);

describe('startDbHealth', () => {
  it('is ok only while the last good ping is at most maxAge old', async () => {
    let now = 1_000;
    let fail = false;
    const h = startDbHealth(async () => { if (fail) throw new Error('down'); }, { log: quiet, intervalMs: 3_600_000, maxAgeMs: 15_000, now: () => now });
    await h.tick();
    expect(h.ok()).toBe(true);
    fail = true;
    now += 10_000;
    await h.tick();
    expect(h.ok()).toBe(true);
    now += 6_000;
    expect(h.ok()).toBe(false);
    fail = false;
    await h.tick();
    expect(h.ok()).toBe(true);
    h.stop();
  });

  it('a hung ping times out and counts as a failure', async () => {
    const logs: string[] = [];
    const h = startDbHealth(() => new Promise<void>(() => undefined), { log: createLogger((l) => logs.push(l)), intervalMs: 3_600_000, timeoutMs: 20 });
    await h.tick();
    expect(h.ok()).toBe(false);
    expect(logs.join('\n')).toMatch(/host db ping failed.*timed out/);
    h.stop();
  });
});

describe.skipIf(!isPg)('openHostDb', () => {
  const schema = `t_${Math.floor(Date.now() / 1000)}_${randomBytes(6).toString('hex')}`;
  const cfg: PostgresStoreConfig = { kind: 'postgres', schema, poolMax: 2, connection: { connectionString: process.env.PG_TEST_URL ?? 'postgres://unset' } };
  const admin = async (q: string) => {
    const c = new pg.Client({ connectionString: process.env.PG_TEST_URL });
    await c.connect();
    try { return await c.query(q); } finally { await c.end(); }
  };
  let h: HostDbHandle | null = null;
  afterEach(async () => {
    await h?.end();
    h = null;
    await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  it('migrates the host track inside the existing schema, idempotently, and pings', async () => {
    await admin(`CREATE SCHEMA ${schema}`);
    h = await openHostDb(cfg, { log: quiet });
    await h.ping();
    await h.end();
    h = await openHostDb(cfg, { log: quiet });
    const v = await admin(`SELECT version FROM ${schema}.schema_migrations WHERE track = 'host'`);
    expect(v.rows).toEqual([{ version: '1' }]);
    const t = await admin(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name LIKE 'host_%' ORDER BY 1`);
    expect(t.rows.map((r) => r.table_name)).toEqual(['host_ingest_offsets', 'host_lease', 'host_meta']);
  });

  it('retries until the schema exists, logging each failure', async () => {
    const logs: string[] = [];
    let attempts = 0;
    h = await openHostDbRetrying(cfg, {
      log: createLogger((l) => logs.push(l)),
      sleep: async () => {
        if (++attempts === 2) await admin(`CREATE SCHEMA ${schema}`);
      }
    });
    expect(attempts).toBe(2);
    expect(logs.filter((l) => l.includes('host db unavailable; retrying'))).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/does not exist/);
  });

  it('does not retry a config error', async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(openHostDbRetrying({ ...cfg, connection: { env: 'FLEET_DB_UNSET' } }, { log: quiet, env: {}, sleep })).rejects.toThrow(/FLEET_DB_UNSET is not set/);
    expect(sleep).not.toHaveBeenCalled();
  });
});
