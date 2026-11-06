import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bootstrapSql, ensureManagedPostgres, ManagedPgError, MANAGED_PG_CONTAINER, MANAGED_PG_IMAGE, MANAGED_PG_VOLUME,
  STORE_LABEL, STORE_MAJOR_LABEL, stopManagedPostgres, type ManagedContainer, type ManagedContainerSpec, type ManagedDocker,
} from './managedPostgres.js';

class FakeDocker implements ManagedDocker {
  up = true;
  images = new Set<string>();
  volumes = new Map<string, Record<string, string>>();
  container: (ManagedContainer & { spec?: ManagedContainerSpec }) | null = null;
  calls: string[] = [];
  readyAfter = 0;
  execs: Array<{ cmd: string[]; env?: string[]; timeoutMs?: number }> = [];
  bootstrapExit = 0;
  startFailures: Error[] = [];
  async ping() { return this.up; }
  async hasImage(ref: string) { return this.images.has(ref); }
  async pull(ref: string) { this.calls.push(`pull ${ref}`); this.images.add(ref); }
  async inspectVolume(name: string) { const l = this.volumes.get(name); return l ? { labels: l } : null; }
  async createVolume(name: string, labels: Record<string, string>) { this.calls.push(`volume ${name}`); this.volumes.set(name, labels); }
  async inspectContainer() {
    if (!this.container) return null;
    const { running, image, hostPort, hostIp, labels } = this.container;
    return { running, image, hostPort, hostIp, labels };
  }
  async createContainer(spec: ManagedContainerSpec) {
    this.calls.push(`create ${spec.hostPort}`);
    this.container = { running: false, image: spec.image, hostPort: spec.hostPort, hostIp: '127.0.0.1', labels: spec.labels, spec };
  }
  async start() {
    this.calls.push('start');
    const e = this.startFailures.shift();
    if (e) throw e;
    this.container!.running = true;
  }
  async stop() { this.calls.push('stop'); this.container!.running = false; }
  async remove() { this.calls.push('remove'); this.container = null; }
  async exec(_name: string, cmd: string[], env?: string[], timeoutMs?: number) {
    this.execs.push({ cmd, env, timeoutMs });
    if (cmd[0] === 'pg_isready') return { exitCode: this.readyAfter-- > 0 ? 2 : 0, output: '' };
    return { exitCode: this.bootstrapExit, output: this.bootstrapExit ? `ERROR: at ALTER ROLE fleet_app PASSWORD '${(env?.[0] ?? '').match(/SCRAM-SHA-256\$[^']+/)?.[0]}'` : '' };
  }
}

const OURS = { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '16' };
const existing = (o: Partial<ManagedContainer> = {}): ManagedContainer =>
  ({ running: false, image: MANAGED_PG_IMAGE, hostPort: 40000, hostIp: '127.0.0.1', labels: OURS, ...o });

function deps(docker: FakeDocker, stored: { v: string | null } = { v: null }, ports: number[] = [54321, 54322]) {
  return {
    docker,
    password: { get: async () => stored.v, set: async (v: string) => { stored.v = v; } },
    sleep: async () => undefined,
    freePort: async () => ports.shift()!,
    readyTimeoutMs: 1_000,
  };
}

describe('ensureManagedPostgres', () => {
  it('first run: pulls, creates the volume and a loopback container, waits, bootstraps, returns the loopback config', async () => {
    const docker = new FakeDocker();
    docker.readyAfter = 2;
    const stored = { v: null as string | null };
    const cfg = await ensureManagedPostgres(deps(docker, stored), 4);
    expect(docker.calls).toEqual([`pull ${MANAGED_PG_IMAGE}`, `volume ${MANAGED_PG_VOLUME}`, 'create 54321', 'start']);
    expect(docker.volumes.get(MANAGED_PG_VOLUME)).toEqual({ [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '16' });
    expect(docker.container!.spec!.labels).toEqual({ [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '16' });
    expect(docker.container!.spec!.labels['com.claude-fleet.managed']).toBeUndefined();
    expect(docker.container!.spec!.env).toEqual(expect.arrayContaining(['POSTGRES_DB=fleet', 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8']));
    expect(docker.execs.filter((e) => e.cmd[0] === 'pg_isready').length).toBe(3);
    expect(docker.execs.find((e) => e.cmd[0] === 'pg_isready')!.cmd).toContain('127.0.0.1');
    expect(stored.v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cfg).toEqual({
      kind: 'postgres', schema: 'fleet', poolMax: 4,
      connection: { host: '127.0.0.1', port: 54321, database: 'fleet', user: 'fleet_app', password: { kind: 'static', value: stored.v }, ssl: 'disable' },
    });
  });

  it('the password never reaches an exec argument or the SQL: only its SCRAM verifier does', async () => {
    const docker = new FakeDocker();
    const stored = { v: 'vault-held-secret-value' };
    await ensureManagedPostgres(deps(docker, stored), 4);
    const boot = docker.execs.find((e) => e.cmd[0] === 'sh')!;
    expect(JSON.stringify(boot)).not.toContain('vault-held-secret-value');
    expect(boot.env![0]).toMatch(/^FLEET_PG_SQL=.*PASSWORD 'SCRAM-SHA-256\$4096:/s);
    expect(boot.env![0]).toContain('ALTER ROLE postgres PASSWORD NULL;');
  });

  it('locks the superuser first, rejects it over TCP, and never puts its password in the container env', async () => {
    const docker = new FakeDocker();
    await ensureManagedPostgres(deps(docker), 4);
    const env = docker.container!.spec!.env;
    expect(env).toContain('POSTGRES_PASSWORD_FILE=/proc/sys/kernel/random/uuid');
    expect(env.some((e) => e.startsWith('POSTGRES_PASSWORD='))).toBe(false);
    const boot = docker.execs.find((e) => e.cmd[0] === 'sh')!;
    const sqlText = boot.env![0].slice('FLEET_PG_SQL='.length);
    expect(sqlText.startsWith('ALTER ROLE postgres PASSWORD NULL;')).toBe(true);
    expect(sqlText.trimEnd().endsWith('SELECT pg_reload_conf();')).toBe(true);
    const script = boot.cmd[2];
    expect(script).toContain('"$PGDATA/pg_hba.conf"');
    const hba = script.slice(0, script.indexOf('psql'));
    expect(hba.indexOf("'local all all trust'")).toBeGreaterThan(-1);
    expect(hba.indexOf("'host all postgres all reject'")).toBeGreaterThan(hba.indexOf("'local all all trust'"));
    expect(hba.indexOf("'host all all all scram-sha-256'")).toBeGreaterThan(hba.indexOf("'host all postgres all reject'"));
  });

  it('bounds every readiness probe', async () => {
    const docker = new FakeDocker();
    docker.readyAfter = 1;
    await ensureManagedPostgres(deps(docker), 4);
    for (const e of docker.execs.filter((x) => x.cmd[0] === 'pg_isready')) {
      expect(e.cmd).toEqual(expect.arrayContaining(['-t', '3']));
      expect(e.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('a host port taken by something else: recreates on a fresh loopback port, keeping the volume', async () => {
    const docker = new FakeDocker();
    docker.images.add(MANAGED_PG_IMAGE);
    docker.volumes.set(MANAGED_PG_VOLUME, OURS);
    docker.container = existing();
    docker.startFailures.push(Object.assign(new Error('driver failed programming external connectivity on endpoint claude-fleet-postgres: Bind for 127.0.0.1:40000 failed: port is already allocated'), { statusCode: 500 }));
    const cfg = await ensureManagedPostgres(deps(docker), 4);
    expect(docker.calls).toEqual(['start', 'remove', 'create 54321', 'start']);
    expect(docker.container!.spec!.volume).toBe(MANAGED_PG_VOLUME);
    expect(cfg.connection).toMatchObject({ port: 54321 });
  });

  it('any other start failure is a start error', async () => {
    const docker = new FakeDocker();
    docker.startFailures.push(Object.assign(new Error('OCI runtime create failed'), { statusCode: 500 }));
    const e = await ensureManagedPostgres(deps(docker), 4).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ManagedPgError);
    expect((e as ManagedPgError).reason).toBe('start');
    expect(docker.calls).not.toContain('remove');
  });

  it('a container that is not ours or not on loopback is recreated on the same port', async () => {
    for (const bad of [existing({ labels: {} }), existing({ hostIp: '0.0.0.0' })]) {
      const docker = new FakeDocker();
      docker.images.add(MANAGED_PG_IMAGE);
      docker.volumes.set(MANAGED_PG_VOLUME, OURS);
      docker.container = bad;
      await ensureManagedPostgres(deps(docker), 4);
      expect(docker.calls).toEqual(['remove', 'create 40000', 'start']);
      expect(docker.container!.hostIp).toBe('127.0.0.1');
    }
  });

  it('a later start reuses the container, its port and the stored password', async () => {
    const docker = new FakeDocker();
    docker.images.add(MANAGED_PG_IMAGE);
    docker.volumes.set(MANAGED_PG_VOLUME, { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '16' });
    docker.container = existing();
    const cfg = await ensureManagedPostgres(deps(docker, { v: 'kept' }), 4);
    expect(docker.calls).toEqual(['start']);
    expect(cfg.connection).toMatchObject({ port: 40000, password: { kind: 'static', value: 'kept' } });
  });

  it('a new pinned image recreates the container on the same volume and port', async () => {
    const docker = new FakeDocker();
    docker.images.add(MANAGED_PG_IMAGE);
    docker.volumes.set(MANAGED_PG_VOLUME, { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '16' });
    docker.container = existing({ running: true, image: 'pgvector/pgvector:0.8.0-pg16@sha256:old' });
    await ensureManagedPostgres(deps(docker), 4);
    expect(docker.calls).toEqual(['stop', 'remove', 'create 40000', 'start']);
    expect(docker.container!.spec!.volume).toBe(MANAGED_PG_VOLUME);
  });

  it('refuses a volume of another major or not ours, and Docker being down', async () => {
    const other = new FakeDocker();
    other.volumes.set(MANAGED_PG_VOLUME, { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: '17' });
    await expect(ensureManagedPostgres(deps(other), 4)).rejects.toThrow(/holds Postgres 17 data/);
    const foreign = new FakeDocker();
    foreign.volumes.set(MANAGED_PG_VOLUME, {});
    await expect(ensureManagedPostgres(deps(foreign), 4)).rejects.toThrow(/wasn't created by claude-fleet/);
    const down = new FakeDocker();
    down.up = false;
    const e = await ensureManagedPostgres(deps(down), 4).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ManagedPgError);
    expect((e as ManagedPgError).reason).toBe('docker-down');
    expect(other.container).toBeNull();
  });

  it('gives up when Postgres never becomes ready, and redacts the verifier from a bootstrap error', async () => {
    const slow = new FakeDocker();
    slow.readyAfter = Number.POSITIVE_INFINITY;
    await expect(ensureManagedPostgres({ ...deps(slow), readyTimeoutMs: 0 }, 4)).rejects.toThrow(/did not become ready/);
    const bad = new FakeDocker();
    bad.bootstrapExit = 3;
    const e = (await ensureManagedPostgres(deps(bad), 4).catch((x: unknown) => x)) as Error;
    expect(e.message).toMatch(/bootstrap failed/);
    expect(e.message).not.toMatch(/SCRAM-SHA-256\$/);
  });

  it('stopManagedPostgres stops a running container only', async () => {
    const docker = new FakeDocker();
    await stopManagedPostgres(docker);
    docker.container = existing({ running: true, hostPort: 1 });
    await stopManagedPostgres(docker);
    expect(docker.calls).toEqual(['stop']);
    expect(MANAGED_PG_CONTAINER).toBe('claude-fleet-postgres');
  });
});

describe('MANAGED_PG_IMAGE', () => {
  it('is pinned by digest', () => {
    expect(MANAGED_PG_IMAGE).toMatch(/^pgvector\/pgvector:[^@]+@sha256:[0-9a-f]{64}$/);
  });

  it("is CI's Postgres service image", () => {
    const wf = readFileSync('.github/workflows/build-app.yml', 'utf8');
    const images = [...wf.matchAll(/image: (pgvector\/pgvector\S*)/g)].map((m) => m[1]);
    expect(images.length).toBeGreaterThan(0);
    for (const i of images) expect(i).toBe(MANAGED_PG_IMAGE);
  });
});

describe('bootstrapSql', () => {
  it('creates the role with CREATEROLE, the schema it owns, and pgvector; it is idempotent text', () => {
    const s = bootstrapSql({ user: 'fleet_app', schema: 'fleet', verifier: 'SCRAM-SHA-256$4096:x$y:z' });
    expect(s).toContain("ALTER ROLE fleet_app LOGIN CREATEROLE PASSWORD 'SCRAM-SHA-256$4096:x$y:z';");
    expect(s).toContain('CREATE SCHEMA IF NOT EXISTS fleet AUTHORIZATION fleet_app;');
    expect(s).toContain('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;');
  });
});
