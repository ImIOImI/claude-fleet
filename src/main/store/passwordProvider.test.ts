import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passwordProvider } from './passwordProvider.js';
import { createPgPool } from './postgres.js';
import { parseStoreConfig, pgPoolConfig, type PostgresStoreConfig } from './storeConfig.js';
import { fakePgAuth } from './fakePgAuth.js';

let hasOpenssl = true;
try { execFileSync('openssl', ['version']); } catch { hasOpenssl = false; }

const TARGET = { host: 'fleet.cluster-abc.us-east-1.rds.amazonaws.com', port: 5432, user: 'fleet_agent' };

describe('passwordProvider', () => {
  it('static returns the value; env reads the variable on every call', async () => {
    expect(await passwordProvider({ kind: 'static', value: 's3' }, TARGET)()).toBe('s3');
    const env: NodeJS.ProcessEnv = { PGPW: 'one' };
    const p = passwordProvider({ kind: 'env', name: 'PGPW' }, TARGET, env);
    expect(await p()).toBe('one');
    env.PGPW = 'two';
    expect(await p()).toBe('two');
    delete env.PGPW;
    await expect(p()).rejects.toThrow(/PGPW is not set/);
  });

  // The default chain loads and probes lazily; first calls can be slow under load.
  describe('aws-rds-iam via the container (EKS Pod Identity) credential endpoint', { timeout: 20_000 }, () => {
    const saved = { ...process.env };
    let server: Server;
    let dir: string;
    let calls: Array<string | undefined>;
    beforeEach(async () => {
      calls = [];
      server = createServer((req, res) => {
        calls.push(req.headers.authorization);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          AccessKeyId: 'AKIDPODIDENTITY', SecretAccessKey: 'secret', Token: 'sessiontoken',
          Expiration: new Date(Date.now() + 3600_000).toISOString(),
        }));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      dir = mkdtempSync(join(tmpdir(), 'cf-podid-'));
      writeFileSync(join(dir, 'token'), 'pod-identity-token');
      for (const k of Object.keys(process.env)) if (k.startsWith('AWS_')) delete process.env[k];
      process.env.AWS_CONFIG_FILE = join(dir, 'none');
      process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'none');
      process.env.AWS_EC2_METADATA_DISABLED = 'true';
      const port = (server.address() as { port: number }).port;
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${port}/v1/credentials`;
      process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = join(dir, 'token');
    });
    afterEach(async () => {
      process.env = { ...saved };
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    });

    it('signs a connect token for the exact host, port and user with the pod credentials', async () => {
      const token = await passwordProvider({ kind: 'aws-rds-iam', region: 'us-east-1' }, TARGET)();
      expect(token.startsWith(`${TARGET.host}:5432/?`)).toBe(true);
      const q = new URLSearchParams(token.slice(token.indexOf('?') + 1));
      expect(q.get('Action')).toBe('connect');
      expect(q.get('DBUser')).toBe('fleet_agent');
      expect(q.get('X-Amz-Credential')).toMatch(/^AKIDPODIDENTITY\/\d{8}\/us-east-1\/rds-db\/aws4_request$/);
      expect(q.get('X-Amz-Security-Token')).toBe('sessiontoken');
      expect(q.get('X-Amz-Expires')).toBe('900');
      expect(calls).toContain('pod-identity-token');
    });

    it('mints a fresh token per call (one per new pool connection)', async () => {
      const p = passwordProvider({ kind: 'aws-rds-iam', region: 'us-east-1' }, TARGET);
      const a = await p();
      await new Promise((r) => setTimeout(r, 1100));
      expect(await p()).not.toBe(a);
    });

    it.skipIf(!hasOpenssl)('each new pool connection authenticates over verify-full TLS with a freshly signed token', async () => {
      const certs = mkdtempSync(join(tmpdir(), 'cf-iam-tls-'));
      const o = (args: string[]) => execFileSync('openssl', args, { cwd: certs, stdio: 'pipe' });
      o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=test-ca', '-keyout', 'ca.key', '-out', 'ca.pem']);
      o(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'srv.key', '-out', 'srv.csr']);
      writeFileSync(join(certs, 'ext'), 'subjectAltName=DNS:localhost\n');
      o(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext', '-out', 'srv.pem']);
      const fake = await fakePgAuth({ key: readFileSync(join(certs, 'srv.key'), 'utf8'), cert: readFileSync(join(certs, 'srv.pem'), 'utf8') });
      const cfg = parseStoreConfig({
        kind: 'postgres', host: 'localhost', port: fake.port, database: 'fleet', user: 'fleet_agent',
        password: { kind: 'aws-rds-iam', region: 'us-east-1' }, caFile: join(certs, 'ca.pem'), poolMax: 2,
      }, { allowStaticSecrets: false }) as PostgresStoreConfig;
      const pool = createPgPool(pgPoolConfig(cfg));
      try {
        const a = await pool.connect();
        await new Promise((r) => setTimeout(r, 1100));
        const b = await pool.connect();
        a.release();
        b.release();
        expect(fake.passwords).toHaveLength(2);
        for (const t of fake.passwords) expect(t).toMatch(new RegExp(`^localhost:${fake.port}/\\?.*Action=connect.*DBUser=fleet_agent`));
        expect(fake.passwords[0]).not.toBe(fake.passwords[1]);
      } finally {
        await pool.end();
        await fake.close();
        rmSync(certs, { recursive: true, force: true });
      }
    });

    it('needs a region', () => {
      expect(() => passwordProvider({ kind: 'aws-rds-iam' }, TARGET, {})).toThrow(/region/);
    });
  });
});
