// The managed container on a real Docker daemon (CI; MANAGED_PG_DOCKER=1),
// under test-suffixed names so it never touches a user's store.
import Docker from 'dockerode';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import * as db from '../db.js';
import { dockerodeManagedDocker } from './managedDocker.js';
import { ensureManagedPostgres, MANAGED_PG_IMAGE, MANAGED_SCHEMA, stopManagedPostgres } from './managedPostgres.js';
import { isolationBlocker } from './pgQueryIsolation.js';
import { createPgPool } from './postgres.js';
import { pgPoolConfig, type PostgresStoreConfig } from './storeConfig.js';

const portOf = (cfg: PostgresStoreConfig): number => (cfg.connection as { port: number }).port;

async function opensAsApp(cfg: PostgresStoreConfig): Promise<void> {
  const pool = createPgPool({ ...pgPoolConfig(cfg), max: 2 });
  try {
    expect((await pool.query<{ u: string }>('SELECT current_user AS u')).rows[0].u).toBe('fleet_app');
    await db.openDbPostgres(pool);
    expect(await isolationBlocker(db.stateKysely(), MANAGED_SCHEMA)).toBeNull();
  } finally {
    await db.closeDb();
    await pool.end();
  }
}

describe.skipIf(process.env.MANAGED_PG_DOCKER !== '1')('the managed container on Docker', () => {
  it('creates, reuses, survives a restart, locks the superuser, and moves off a taken port', async () => {
    const docker = new Docker();
    const md = dockerodeManagedDocker(docker);
    const sfx = randomBytes(4).toString('hex');
    const names = { container: `claude-fleet-postgres-test-${sfx}`, volume: `claude-fleet-postgres-data-test-${sfx}` };
    const stored = { v: null as string | null };
    const d = { docker: md, names, password: { get: async () => stored.v, set: async (v: string) => { stored.v = v; } } };
    try {
      if (!(await md.hasImage(MANAGED_PG_IMAGE))) await md.pull(MANAGED_PG_IMAGE, () => undefined);
      expect(await md.hasImage(MANAGED_PG_IMAGE)).toBe(true);

      const cfg = await ensureManagedPostgres(d, 2);
      const port = portOf(cfg);
      const secret = stored.v!;
      expect(secret).toBeTruthy();

      const info = await docker.getContainer(names.container).inspect();
      expect(info.HostConfig.PortBindings['5432/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: String(port) }]);
      expect(info.Config.Env.some((e) => e.startsWith('POSTGRES_PASSWORD='))).toBe(false);
      expect(JSON.stringify(info)).not.toContain(secret);
      expect((info.ExecIDs ?? []).length).toBeGreaterThan(0);
      for (const id of info.ExecIDs ?? []) expect(JSON.stringify(await docker.getExec(id).inspect())).not.toContain(secret);

      await opensAsApp(cfg);
      const su = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'x', database: 'fleet', ssl: false, connectionTimeoutMillis: 5_000 });
      await expect(su.connect()).rejects.toThrow(/pg_hba\.conf rejects/);

      expect(portOf(await ensureManagedPostgres(d, 2))).toBe(port);
      await stopManagedPostgres(md, names.container);
      expect(portOf(await ensureManagedPostgres(d, 2))).toBe(port);
      await opensAsApp(cfg);

      await stopManagedPostgres(md, names.container);
      const squatter = createServer();
      await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', r));
      try {
        const moved = await ensureManagedPostgres(d, 2);
        expect(portOf(moved)).not.toBe(port);
        await opensAsApp(moved);
      } finally {
        await new Promise((r) => squatter.close(r));
      }
    } finally {
      await docker.getContainer(names.container).remove({ force: true }).catch(() => undefined);
      await docker.getVolume(names.volume).remove().catch(() => undefined);
    }
  }, 600_000);
});
