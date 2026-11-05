// Fake GitHub App API for tests (not shipped): verifies the App JWT, mints fake
// installation tokens and records every request.
import { createServer, type Server } from 'node:http';
import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface FakeGithubApp {
  url: string;
  privatePem: string;
  publicKey: KeyObject;
  requests: { method: string; path: string; body: unknown; jwt: Record<string, unknown> }[];
  /** Repos the installation can reach. */
  repos: Set<string>;
  delayMs: number;
  ttlMs: number;
  /** Answer with every installation repo, whatever was asked. */
  widen: boolean;
  close(): Promise<void>;
}

function verifyJwt(auth: string, key: KeyObject): Record<string, unknown> | null {
  const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth);
  if (!m) return null;
  if (!createVerify('RSA-SHA256').update(`${m[1]}.${m[2]}`).verify(key, Buffer.from(m[3], 'base64url'))) return null;
  if (JSON.parse(Buffer.from(m[1], 'base64url').toString()).alg !== 'RS256') return null;
  return JSON.parse(Buffer.from(m[2], 'base64url').toString());
}

export async function startFakeGithubApp(o: { appId: string; installationId: string; account: string; repos: string[] }): Promise<FakeGithubApp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fake = {
    privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicKey,
    requests: [] as FakeGithubApp['requests'],
    repos: new Set(o.repos),
    delayMs: 0,
    ttlMs: 60 * 60_000,
    widen: false
  } as FakeGithubApp;
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const jwt = verifyJwt(String(req.headers.authorization ?? ''), publicKey);
      const body = raw ? JSON.parse(raw) : undefined;
      fake.requests.push({ method: req.method!, path: req.url!, body, jwt: jwt ?? {} });
      if (!jwt || jwt.iss !== o.appId) return send(401, { message: 'A JSON web token could not be decoded' });
      if (req.method === 'GET' && req.url === `/app/installations/${o.installationId}`) {
        return send(200, { id: Number(o.installationId), account: { login: o.account } });
      }
      if (req.method === 'POST' && req.url === `/app/installations/${o.installationId}/access_tokens`) {
        const want: string[] = body?.repositories ?? [];
        if (want.some((r) => !fake.repos.has(r))) {
          return send(422, { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' });
        }
        if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
        n++;
        return send(201, {
          token: `ghs_fake${String(n).padStart(4, '0')}${'x'.repeat(28)}`,
          expires_at: new Date(Date.now() + fake.ttlMs).toISOString(),
          permissions: body?.permissions ?? { contents: 'write' },
          repositories: (want.length && !fake.widen ? want : [...fake.repos]).map((name) => ({ name, full_name: `${o.account}/${name}` }))
        });
      }
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}
