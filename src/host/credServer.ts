// The App credential socket. Sessions ask for a token scoped to named repos;
// the key never leaves this process. See SPEC §9 for what it does not protect.
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';
import { AppTokenError, createTokenMinter, loadAppCredentials, type TokenMinter } from './appToken.js';
import type { GithubAppConfig, HostGithubConfig } from './config.js';
import type { Logger } from './log.js';

export const DEFAULT_CRED_SOCKET = '/run/fleet-host/cred.sock';
const MAX_BODY = 8 * 1024;

export interface CredServer { close(): Promise<void> }

export async function listenCredSocket(socketPath: string, minter: TokenMinter, log: Logger): Promise<CredServer> {
  const dir = dirname(socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const st = await lstat(socketPath).catch(() => null);
  if (st) {
    if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
    await unlink(socketPath);
  }
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/token') return send(404, { error: 'not found' });
    let raw = '';
    let size = 0;
    req.setEncoding('utf8');
    // Drain an oversize body rather than reset it, so the client reads the 413.
    req.on('data', (c: string) => {
      size += Buffer.byteLength(c);
      if (size <= MAX_BODY) raw += c;
    });
    req.on('end', async () => {
      if (size > MAX_BODY) return send(413, { error: 'body too large' });
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { error: 'body must be JSON' });
      }
      try {
        const t = await minter.mint(body);
        log.log('info', 'app token issued', { repositories: t.repositories });
        send(200, { token: t.token, expiresAt: new Date(t.expiresAt).toISOString() });
      } catch (err) {
        const status = err instanceof AppTokenError ? err.status : 500;
        const error = err instanceof AppTokenError ? err.message : 'internal error';
        log.log(status >= 500 ? 'error' : 'warn', 'app token refused', { status, error });
        send(status, { error });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return { close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface CredHelperOptions {
  app: GithubAppConfig;
  socketPath: string;
  /** Read per request, so a config reload applies. */
  github(): HostGithubConfig | null;
  log: Logger;
  apiBase?: string;
}

/** Loads the key and serves the socket. A failed account check is logged, not fatal: tokens are minted on demand. */
export async function startCredHelper(o: CredHelperOptions): Promise<CredServer> {
  const creds = await loadAppCredentials(o.app);
  const minter = createTokenMinter({
    creds,
    apiBase: o.apiBase,
    allow: () => o.github()?.repositories ?? null,
    defaultPermissions: () => o.github()?.permissions ?? null
  });
  minter.account().then(
    (account) => o.log.log('info', 'github app ready', { appId: o.app.appId, account }),
    (err: Error) => o.log.log('warn', 'github app check failed; tokens are minted on demand', { error: err.message })
  );
  return listenCredSocket(o.socketPath, minter, o.log);
}
