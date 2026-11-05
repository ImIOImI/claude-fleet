import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CA_FILE, parseStoreConfig, pgPoolConfig, StoreConfigError, type PostgresStoreConfig,
} from './storeConfig.js';
import { fakePgAuth } from './fakePgAuth.js';
import { createPgPool } from './postgres.js';

const noDefaultCa = () => false;
const DESKTOP = { allowStaticSecrets: false, fileExists: noDefaultCa };
const HOST = { allowStaticSecrets: true, fileExists: noDefaultCa };
const SECRET = 'hunter2-Zq9';

const thrown = (f: () => unknown): Error => {
  try { f(); } catch (e) { return e as Error; }
  throw new Error('did not throw');
};

describe('parseStoreConfig', () => {
  it('absent or sqlite is SQLite', () => {
    expect(parseStoreConfig(undefined, DESKTOP)).toEqual({ kind: 'sqlite' });
    expect(parseStoreConfig({ kind: 'sqlite' }, DESKTOP)).toEqual({ kind: 'sqlite' });
  });

  it('parses the three connection forms with defaults', () => {
    expect(parseStoreConfig({ kind: 'postgres', connectionString: 'postgres://u@db.local:5432/fleet?sslmode=verify-full' }, DESKTOP))
      .toEqual({ kind: 'postgres', schema: 'fleet', poolMax: 4, connection: { connectionString: 'postgres://u@db.local:5432/fleet?sslmode=verify-full' } });
    expect(parseStoreConfig({ kind: 'postgres', env: 'DATABASE_URL', schema: 'mine', poolMax: 8 }, DESKTOP))
      .toEqual({ kind: 'postgres', schema: 'mine', poolMax: 8, connection: { env: 'DATABASE_URL' } });
    expect(parseStoreConfig({
      kind: 'postgres', host: 'w.cluster-x.us-east-1.rds.amazonaws.com', database: 'fleet', user: 'fleet_agent',
      password: { kind: 'aws-rds-iam', region: 'us-east-1' }, caFile: '/ca.pem',
    }, HOST)).toEqual({
      kind: 'postgres', schema: 'fleet', poolMax: 4,
      connection: {
        host: 'w.cluster-x.us-east-1.rds.amazonaws.com', port: 5432, database: 'fleet', user: 'fleet_agent',
        password: { kind: 'aws-rds-iam', region: 'us-east-1' }, ssl: 'verify-full', caFile: '/ca.pem',
      },
    });
  });

  it('verify-full without caFile uses the host image RDS bundle when it exists', () => {
    const v = { kind: 'postgres', host: 'h', database: 'fleet', user: 'fleet_agent', password: { kind: 'aws-rds-iam', region: 'us-east-1' } };
    expect(DEFAULT_CA_FILE).toBe('/etc/ssl/certs/rds-global-bundle.pem');
    const seen: string[] = [];
    const cfg = parseStoreConfig(v, { allowStaticSecrets: true, fileExists: (p) => { seen.push(p); return p === DEFAULT_CA_FILE; } });
    expect(cfg).toMatchObject({ connection: { ssl: 'verify-full', caFile: DEFAULT_CA_FILE } });
    expect(seen).toEqual([DEFAULT_CA_FILE]);
    expect(() => parseStoreConfig(v, HOST)).toThrow(/needs caFile/);
  });

  it.each([
    [{ kind: 'mysql' }, /kind must be/],
    [{ kind: 'postgres', schema: 'Bad-Name', env: 'X' }, /schema must match/],
    [{ kind: 'postgres', poolMax: 0, env: 'X' }, /poolMax/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'env', name: 'P' }, ssl: 'verify-full' }, /needs caFile/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'aws-rds-iam' }, ssl: 'require' }, /ssl must be/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'aws-rds-iam' }, ssl: 'disable' }, /aws-rds-iam needs ssl "verify-full"/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'magic' }, ssl: 'disable' }, /password.kind/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'static', value: 'pw' }, ssl: 'disable' }, /"static" is not allowed in config.json/],
    [{ kind: 'postgres', connectionString: 'postgres://u:pw@h/d' }, /must not embed a password/],
    [{ kind: 'postgres', connectionString: 'postgres://u@h/d?password=pw' }, /must not embed a password/],
    // strictness
    [{ kind: 'sqlite', path: '/x' }, /unknown key "path"/],
    [{ kind: 'postgres', env: 'X', host: 'h' }, /exactly one of/],
    [{ kind: 'postgres', connectionString: 'postgres://u@h/d', env: 'X' }, /exactly one of/],
    [{ kind: 'postgres', env: 'X', ssl: 'disable' }, /unknown key "ssl"/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'env', name: 'P', value: 'pw' }, ssl: 'disable' }, /unknown key "value"/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'aws-rds-iam', region: 'nowhere' }, caFile: '/ca.pem' }, /region/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'env', name: 'BAD NAME' }, ssl: 'disable' }, /name must be an env var name/],
    [{ kind: 'postgres', env: '1X' }, /env must be an env var name/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'env', name: 'P' }, caFile: 'relative.pem' }, /caFile must be an absolute path/],
    [{ kind: 'postgres', host: 'h', port: '5432', database: 'd', user: 'u', password: { kind: 'env', name: 'P' }, ssl: 'disable' }, /port must be/],
    [{ kind: 'postgres', host: 'h', database: 'd', user: 'u', ssl: 'disable' }, /password must be/],
    [{ kind: 'postgres', connectionString: 'mysql://u@h/d' }, /postgres:\/\//],
    // no TLS downgrade through the connection string
    [{ kind: 'postgres', connectionString: 'postgres://u@h/d?sslmode=require' }, /sslmode must be/],
    [{ kind: 'postgres', connectionString: 'postgres://u@h/d?sslmode=no-verify' }, /sslmode must be/],
    [{ kind: 'postgres', connectionString: 'postgres://u@h/d?sslmode=verify-full&uselibpqcompat=true' }, /"uselibpqcompat" is not allowed/],
    [{ kind: 'postgres', connectionString: 'postgres://u@h/d?ssl=true' }, /"ssl" is not allowed/],
    [{ kind: 'postgres', connectionString: 'postgres://u@h/d?sslrootcert=/x.pem' }, /"sslrootcert" is not allowed/],
    ['postgres://u@h/d', /must be an object/],
  ])('rejects %j on the desktop', (v, re) => {
    expect(() => parseStoreConfig(v, DESKTOP)).toThrow(StoreConfigError);
    expect(() => parseStoreConfig(v, DESKTOP)).toThrow(re);
  });

  it('fleet-host may use static secrets', () => {
    expect(parseStoreConfig({ kind: 'postgres', connectionString: 'postgres://u:pw@h/d' }, HOST))
      .toMatchObject({ connection: { connectionString: 'postgres://u:pw@h/d' } });
    expect(parseStoreConfig({ kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'static', value: 'pw' }, ssl: 'disable' }, HOST))
      .toMatchObject({ connection: { password: { kind: 'static', value: 'pw' } } });
  });

  it('never echoes a value in its errors', () => {
    const cases: unknown[] = [
      { kind: 'postgres', connectionString: `postgres://u:${SECRET}@h/d` },
      { kind: 'postgres', connectionString: `postgres://u@h/d?password=${SECRET}` },
      { kind: 'postgres', connectionString: `not a url ${SECRET}` },
      { kind: 'postgres', connectionString: `postgres://u:${SECRET}@h/d?sslmode=${SECRET}` },
      { kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'static', value: SECRET }, ssl: 'disable' },
      { kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'env', name: 'P', [SECRET]: SECRET }, ssl: 'disable' },
      { kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: SECRET }, ssl: 'disable' },
      { kind: SECRET },
    ];
    for (const v of cases) {
      const e = thrown(() => parseStoreConfig(v, DESKTOP));
      expect(e).toBeInstanceOf(StoreConfigError);
      expect(`${String(e)} ${e.stack} ${JSON.stringify(e)}`).not.toContain(SECRET);
    }
  });
});

describe('pgPoolConfig', () => {
  it('resolves an env connection string at open time', () => {
    const cfg = parseStoreConfig({ kind: 'postgres', env: 'DATABASE_URL' }, DESKTOP) as PostgresStoreConfig;
    expect(pgPoolConfig(cfg, { DATABASE_URL: 'postgres://u@h/d' })).toEqual({ schema: 'fleet', max: 4, connectionString: 'postgres://u@h/d', ssl: false });
    expect(() => pgPoolConfig(cfg, {})).toThrow(/DATABASE_URL is not set/);
  });

  it('an env connection string may carry a password but gets the same TLS rules, without echoing it', () => {
    const cfg = parseStoreConfig({ kind: 'postgres', env: 'DATABASE_URL' }, DESKTOP) as PostgresStoreConfig;
    expect(pgPoolConfig(cfg, { DATABASE_URL: `postgres://u:${SECRET}@h/d` })).toMatchObject({ connectionString: `postgres://u:${SECRET}@h/d` });
    for (const bad of [`postgres://u:${SECRET}@h/d?sslmode=no-verify`, `postgres://u:${SECRET}@h/d?ssl=1`, `%%${SECRET}`]) {
      const e = thrown(() => pgPoolConfig(cfg, { DATABASE_URL: bad }, noDefaultCa));
      expect(e).toBeInstanceOf(StoreConfigError);
      expect(`${String(e)} ${e.stack}`).not.toContain(SECRET);
    }
  });

  it('sslmode=verify-full in a connection string becomes verify-full TLS on the CA file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-storecfg-'));
    try {
      writeFileSync(join(dir, 'ca.pem'), 'CA-PEM');
      const cs = parseStoreConfig({ kind: 'postgres', connectionString: 'postgres://u@h/d?sslmode=verify-full&application_name=x', caFile: join(dir, 'ca.pem') }, DESKTOP) as PostgresStoreConfig;
      expect(pgPoolConfig(cs, {}, noDefaultCa)).toEqual({
        schema: 'fleet', max: 4, connectionString: 'postgres://u@h/d?application_name=x', ssl: { ca: 'CA-PEM', rejectUnauthorized: true },
      });
      const env = parseStoreConfig({ kind: 'postgres', env: 'DATABASE_URL' }, DESKTOP) as PostgresStoreConfig;
      expect(() => pgPoolConfig(env, { DATABASE_URL: 'postgres://u@h/d?sslmode=verify-full' }, noDefaultCa)).toThrow(/needs caFile/);
      // Reads the default bundle (absent in the test env, hence ENOENT on that path).
      expect(() => pgPoolConfig(env, { DATABASE_URL: 'postgres://u@h/d?sslmode=verify-full' }, (p) => p === DEFAULT_CA_FILE))
        .toThrow(DEFAULT_CA_FILE);
      expect(pgPoolConfig(env, { DATABASE_URL: 'postgres://u@h/d?sslmode=disable' }, noDefaultCa))
        .toEqual({ schema: 'fleet', max: 4, connectionString: 'postgres://u@h/d', ssl: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fields get a per-connection password function and verify-full TLS on the CA file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-storecfg-'));
    try {
      writeFileSync(join(dir, 'ca.pem'), 'CA-PEM');
      const cfg = parseStoreConfig({
        kind: 'postgres', host: 'h', database: 'd', user: 'u', password: { kind: 'env', name: 'PGPW' }, caFile: join(dir, 'ca.pem'),
      }, DESKTOP) as PostgresStoreConfig;
      const opts = pgPoolConfig(cfg, { PGPW: 'secret' });
      expect(opts).toMatchObject({ schema: 'fleet', max: 4, host: 'h', port: 5432, database: 'd', user: 'u', ssl: { ca: 'CA-PEM', rejectUnauthorized: true } });
      expect(await (opts.password as () => Promise<string>)()).toBe('secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aws-rds-iam without verify-full is refused even when parseStoreConfig is bypassed', () => {
    expect(() => pgPoolConfig({
      kind: 'postgres', schema: 'fleet', poolMax: 1,
      connection: { host: 'h', port: 5432, database: 'd', user: 'u', password: { kind: 'aws-rds-iam', region: 'us-east-1' }, ssl: 'disable' },
    }, {})).toThrow(/aws-rds-iam needs ssl "verify-full"/);
  });

  it('the pool asks the provider again for every new connection', async () => {
    const fake = await fakePgAuth();
    const env: NodeJS.ProcessEnv = { PGPW: 'one' };
    const cfg = parseStoreConfig({
      kind: 'postgres', host: '127.0.0.1', port: fake.port, database: 'd', user: 'u', password: { kind: 'env', name: 'PGPW' }, ssl: 'disable',
    }, DESKTOP) as PostgresStoreConfig;
    const pool = createPgPool(pgPoolConfig(cfg, env));
    try {
      const a = await pool.connect();
      env.PGPW = 'two';
      const b = await pool.connect();
      a.release();
      b.release();
      expect(fake.passwords).toEqual(['one', 'two']);
    } finally {
      await pool.end();
      await fake.close();
    }
  });
});
