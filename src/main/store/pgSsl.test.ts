import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { pgSsl } from './pgSsl.js';

let hasOpenssl = true;
try { execFileSync('openssl', ['version']); } catch { hasOpenssl = false; }

/** A fake Postgres that accepts SSLRequest, completes TLS with `cert`, then hangs up. */
function fakeTlsPostgres(key: string, cert: string): Promise<{ server: Server; port: number }> {
  const server = createServer((sock) => {
    sock.once('data', () => {
      sock.write('S');
      const tls = new TLSSocket(sock, { isServer: true, key, cert });
      tls.on('secure', () => tls.destroy());
      tls.on('error', () => sock.destroy());
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as { port: number }).port })));
}

describe('pgSsl', () => {
  it('maps modes; nothing between disable and verify-full', () => {
    expect(pgSsl(undefined)).toBe(false);
    expect(pgSsl('disable')).toBe(false);
    for (const m of ['require', 'prefer', 'verify-ca', 'no-verify']) expect(() => pgSsl(m as never)).toThrow(/ssl mode/);
    expect(() => pgSsl('verify-full')).toThrow(/caFile/);
  });

  it('verify-full pins the CA and keeps Node\'s certificate and hostname checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-pgssl-'));
    try {
      writeFileSync(join(dir, 'ca.pem'), 'CA-PEM');
      const o = pgSsl('verify-full', join(dir, 'ca.pem'));
      expect(o).toEqual({ ca: 'CA-PEM', rejectUnauthorized: true });
      expect(Object.isFrozen(o)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe.skipIf(!hasOpenssl)('verify-full against a TLS server', () => {
    let dir: string;
    let fake: { server: Server; port: number };
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'cf-pgssl-'));
      const o = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
      o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=test-ca', '-keyout', 'ca.key', '-out', 'ca.pem']);
      o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=other-ca', '-keyout', 'other.key', '-out', 'other.pem']);
      o(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'srv.key', '-out', 'srv.csr']);
      writeFileSync(join(dir, 'ext'), 'subjectAltName=DNS:localhost\n');
      o(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext', '-out', 'srv.pem']);
      fake = await fakeTlsPostgres(readFileSync(join(dir, 'srv.key'), 'utf8'), readFileSync(join(dir, 'srv.pem'), 'utf8'));
    });
    afterAll(() => { fake.server.close(); rmSync(dir, { recursive: true, force: true }); });

    const attempt = async (host: string, ca: string): Promise<string> => {
      const c = new pg.Client({ host, port: fake.port, user: 'u', database: 'd', ssl: pgSsl('verify-full', join(dir, ca)) });
      try {
        await c.connect();
        return 'connected';
      } catch (e) {
        return (e as Error & { code?: string }).code ?? (e as Error).message;
      }
    };

    it('accepts a cert that chains to caFile and names the host', async () => {
      expect(await attempt('localhost', 'ca.pem')).not.toMatch(/CERT|SELF_SIGNED|ALTNAME|verify/i);
    });
    it('rejects a cert from another CA', async () => {
      expect(await attempt('localhost', 'other.pem')).toMatch(/UNABLE_TO_VERIFY|SELF_SIGNED|unable to verify/i);
    });
    it('rejects a hostname the cert does not name', async () => {
      expect(await attempt('127.0.0.1', 'ca.pem')).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    });
  });
});
