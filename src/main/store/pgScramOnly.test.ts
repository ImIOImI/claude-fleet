import { createServer, type AddressInfo, type Server } from 'node:net';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../host/bootstrap.js';
import { rolePoolConfig } from './pgQueryIsolation.js';
import { ClosingClient, pgClientFor, ScramOnlyClient } from './pgScramOnly.js';
import { createPgPool } from './postgres.js';

const SECRET = 'fleet-app-plaintext-secret';

/** A port squatter: answers the startup message with an auth request, then records every byte that follows. */
async function squatter(authCode: 3 | 5): Promise<{ port: number; afterStartup: () => Buffer; server: Server }> {
  let after = Buffer.alloc(0);
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let startupLen = -1;
    sock.on('data', (d) => {
      if (startupLen >= 0) { after = Buffer.concat([after, d]); return; }
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      startupLen = buf.readInt32BE(0);
      if (buf.length > startupLen) after = Buffer.concat([after, buf.subarray(startupLen)]);
      const body = authCode === 5 ? Buffer.from([0, 0, 0, 5, 1, 2, 3, 4]) : Buffer.from([0, 0, 0, 3]);
      const len = Buffer.alloc(4);
      len.writeInt32BE(body.length + 4);
      sock.write(Buffer.concat([Buffer.from('R'), len, body]));
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, afterStartup: () => after, server };
}

/** Asks for SCRAM, then reports whether the client hung up while the server waits for its first SASL message. */
async function scramServer(): Promise<{ port: number; closed: () => boolean; server: Server }> {
  let closed = false;
  const server = createServer((sock) => {
    sock.once('data', () => {
      const body = Buffer.concat([Buffer.from([0, 0, 0, 10]), Buffer.from('SCRAM-SHA-256\0\0', 'latin1')]);
      const len = Buffer.alloc(4);
      len.writeInt32BE(body.length + 4);
      sock.write(Buffer.concat([Buffer.from('R'), len, body]));
    });
    sock.on('close', () => { closed = true; });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, closed: () => closed, server };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const settle = () => new Promise((r) => setTimeout(r, 100));

describe('ScramOnlyClient', () => {
  it('relies on pg private auth hooks that still exist under these names', () => {
    const proto = pg.Client.prototype as unknown as Record<string, unknown>;
    expect(typeof proto._handleAuthCleartextPassword).toBe('function');
    expect(typeof proto._handleAuthMD5Password).toBe('function');
    expect(typeof proto._handleErrorWhileConnecting).toBe('function');
  });

  for (const [code, label] of [[3, 'cleartext'], [5, 'MD5']] as const) {
    it(`refuses a ${label} password request and sends nothing after the startup message`, async () => {
      const s = await squatter(code);
      servers.push(s.server);
      const c = new ScramOnlyClient({ host: '127.0.0.1', port: s.port, user: 'fleet_app', password: SECRET, database: 'fleet' });
      await expect(c.connect()).rejects.toThrow(/refusing .* password authentication/);
      await settle();
      expect(s.afterStartup().length).toBe(0);
    });
  }

  it('a plain pg.Client would have sent the password (the squatter is real)', async () => {
    const s = await squatter(3);
    servers.push(s.server);
    const c = new pg.Client({ host: '127.0.0.1', port: s.port, user: 'fleet_app', password: SECRET, database: 'fleet', connectionTimeoutMillis: 300 });
    await c.connect().catch(() => undefined);
    expect(s.afterStartup().toString('latin1')).toContain(SECRET);
  });
});

describe('a failed login closes its socket', () => {
  // pg reports the error but leaves the socket open; the server backend then waits in authentication until
  // authentication_timeout, stalling every DROP DATABASE on the cluster (ProcSignalBarrier) meanwhile.
  it('a password provider that throws mid-SCRAM hangs up (store pool and isolation role pool)', async () => {
    for (const make of [
      (port: number) => createPgPool({ schema: 'fleet', host: '127.0.0.1', port, user: 'fleet_app', password: async () => { throw new Error('no token'); }, database: 'fleet', ssl: false }),
      (port: number) => new pg.Pool(rolePoolConfig({ schema: 'fleet', host: '127.0.0.1', port, database: 'fleet', ssl: false }, 'q', async () => { throw new Error('no token'); }))
    ]) {
      const s = await scramServer();
      servers.push(s.server);
      const pool = make(s.port);
      try {
        await expect(pool.connect()).rejects.toThrow(/no token/);
        await settle();
        expect(s.closed()).toBe(true);
      } finally {
        await pool.end();
      }
    }
  });

  it('a plain pg.Client leaves it open (the server is real)', async () => {
    const s = await scramServer();
    servers.push(s.server);
    const c = new pg.Client({ host: '127.0.0.1', port: s.port, user: 'fleet_app', password: async () => { throw new Error('no token'); }, database: 'fleet' });
    await expect(c.connect()).rejects.toThrow(/no token/);
    await settle();
    expect(s.closed()).toBe(false);
    (c as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
  });

});

describe('the plaintext guard on store pools', () => {
  it('applies only without TLS', () => {
    expect(pgClientFor(false)).toEqual({ Client: ScramOnlyClient });
    expect(pgClientFor(undefined)).toEqual({ Client: ScramOnlyClient });
    expect(pgClientFor({ rejectUnauthorized: true })).toEqual({ Client: ClosingClient });
  });

  it('a non-TLS store pool refuses a cleartext request', async () => {
    const s = await squatter(3);
    servers.push(s.server);
    const pool = createPgPool({ schema: 'fleet', host: '127.0.0.1', port: s.port, user: 'fleet_app', password: SECRET, database: 'fleet', ssl: false });
    try {
      await expect(pool.connect()).rejects.toThrow(/refusing/);
      await settle();
      expect(s.afterStartup().length).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('a verify-full store pool allows cleartext (RDS IAM sends its token that way over TLS)', async () => {
    const pool = createPgPool({ schema: 'fleet', host: 'db.example', ssl: { rejectUnauthorized: true } });
    try {
      expect((pool as unknown as { Client: unknown }).Client).toBe(ClosingClient);
    } finally {
      await pool.end();
    }
  });

  for (const [code, label] of [[3, 'cleartext'], [5, 'MD5']] as const) {
    it(`fleet-host bootstrap's admin login without TLS refuses a ${label} request and sends nothing`, async () => {
      const s = await squatter(code);
      servers.push(s.server);
      const target = { host: '127.0.0.1', port: s.port, database: 'fleet', user: 'fleet_app', queryUser: 'fleet_app_query', schema: 'fleet', ssl: false as const, iam: false, appPassword: null };
      const admin = { user: 'postgres', password: SECRET, secrets: [SECRET] };
      await expect(bootstrap(target, admin, { log: { log: () => undefined }, connectTimeoutMs: 2_000 })).rejects.toThrow(/refusing/);
      await settle();
      expect(s.afterStartup().length).toBe(0);
    });
  }

  it("4a's isolation role pools get the guard without TLS only", () => {
    expect(rolePoolConfig({ schema: 'fleet', host: '127.0.0.1', ssl: false }, 'r', 'p').Client).toBe(ScramOnlyClient);
    expect(rolePoolConfig({ schema: 'fleet', host: 'db.example', ssl: { rejectUnauthorized: true } }, 'r', 'p').Client).toBe(ClosingClient);
  });
});
