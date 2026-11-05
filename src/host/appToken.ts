// GitHub App installation tokens, each scoped to the repositories a request
// names. The private key stays a KeyObject in this process; only tokens leave.
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GithubAppConfig } from './config.js';

export const GITHUB_API = 'https://api.github.com';
/** A token handed out is good for at least this long. */
export const REFRESH_BEFORE_MS = 5 * 60_000;
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const PERMISSION = /^[a-z_]{1,64}$/;
const MAX_CACHED = 64;

export type Permissions = Record<string, 'read' | 'write'>;
export interface AppCredentials { appId: string; installationId: string; key: KeyObject }

export class AppTokenError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'AppTokenError';
  }
}

export async function loadAppCredentials(e: GithubAppConfig): Promise<AppCredentials> {
  let pem: string;
  try {
    pem = await readFile(e.keyFile, 'utf8');
  } catch (err) {
    throw new Error(`cannot read github.keyFile: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('github.keyFile is not a PEM private key');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('github.keyFile must be an RSA key');
  return { appId: e.appId, installationId: e.installationId, key };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** iat is backdated 60 s for clock drift; GitHub caps exp − iat at 10 min. */
export function appJwt(c: AppCredentials, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: c.appId }));
  return `${head}.${body}.${b64url(createSign('RSA-SHA256').update(`${head}.${body}`).sign(c.key))}`;
}

export interface TokenRequest { owner?: string; repositories: string[]; permissions?: Permissions }
export interface ScopedToken { token: string; expiresAt: number; repositories: string[] }

export function validateTokenRequest(raw: unknown): TokenRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppTokenError('request must be an object', 400);
  const { owner, repositories, permissions } = raw as Record<string, unknown>;
  if (owner !== undefined && (typeof owner !== 'string' || !OWNER.test(owner))) throw new AppTokenError('owner must be a GitHub login', 400);
  if (!Array.isArray(repositories) || repositories.length === 0 || repositories.length > 100) {
    throw new AppTokenError('repositories must list 1 to 100 repository names', 400);
  }
  for (const r of repositories) if (typeof r !== 'string' || !REPO_NAME.test(r) || r === '.' || r === '..') throw new AppTokenError('repositories must be repository names', 400);
  let perms: Permissions | undefined;
  if (permissions !== undefined) {
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new AppTokenError('permissions must be an object', 400);
    perms = {};
    for (const [k, v] of Object.entries(permissions)) {
      if (!PERMISSION.test(k) || (v !== 'read' && v !== 'write')) throw new AppTokenError('permissions must map names to "read" or "write"', 400);
      perms[k] = v;
    }
  }
  return {
    ...(typeof owner === 'string' ? { owner } : {}),
    repositories: [...new Set((repositories as string[]).map((r) => r.toLowerCase()))].sort(),
    ...(perms ? { permissions: perms } : {})
  };
}

export interface MinterOptions {
  creds: AppCredentials;
  apiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Host config `github.repositories`: when set, nothing outside it is minted. */
  allow?: () => readonly string[] | null;
  /** Host config `github.permissions`: used when a request names none. */
  defaultPermissions?: () => Permissions | null;
}

export interface TokenMinter {
  /** The installation's account login, fetched once. */
  account(): Promise<string>;
  mint(req: unknown): Promise<ScopedToken>;
}

export function createTokenMinter(o: MinterOptions): TokenMinter {
  const api = (o.apiBase ?? GITHUB_API).replace(/\/$/, '');
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const cache = new Map<string, ScopedToken>();
  const inflight = new Map<string, Promise<ScopedToken>>();
  let accountP: Promise<string> | null = null;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await f(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${appJwt(o.creds, now())}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'fleet-host',
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new AppTokenError('GitHub is unreachable', 503);
    }
    if (!res.ok) {
      const msg = await res.json().then(
        (j: unknown) => {
          const m = (j as { message?: unknown } | null)?.message;
          return typeof m === 'string' ? m.slice(0, 200) : '';
        },
        () => ''
      );
      const where = `${method} ${path.replace(/\d+/g, ':id')}`;
      throw new AppTokenError(`GitHub ${where} → ${res.status}${msg ? `: ${msg}` : ''}`, res.status === 422 || res.status === 404 ? 400 : 502);
    }
    return res.json();
  }

  function account(): Promise<string> {
    accountP ??= call('GET', `/app/installations/${o.creds.installationId}`).then((j) => {
      const login = (j as { account?: { login?: unknown } }).account?.login;
      if (typeof login !== 'string') throw new AppTokenError('the installation has no account login');
      return login;
    });
    accountP.catch(() => (accountP = null));
    return accountP;
  }

  async function fetchToken(req: TokenRequest): Promise<ScopedToken> {
    const j = (await call('POST', `/app/installations/${o.creds.installationId}/access_tokens`, {
      repositories: req.repositories,
      ...(req.permissions ? { permissions: req.permissions } : {})
    })) as { token?: unknown; expires_at?: unknown; repositories?: { name?: unknown }[] };
    const expiresAt = typeof j.expires_at === 'string' ? Date.parse(j.expires_at) : NaN;
    if (typeof j.token !== 'string' || !Number.isFinite(expiresAt)) throw new AppTokenError('GitHub returned no token');
    const granted = (j.repositories ?? []).map((r) => String(r.name).toLowerCase()).sort();
    if (granted.join(',') !== req.repositories.join(',')) throw new AppTokenError('GitHub scoped the token to other repositories');
    return { token: j.token, expiresAt, repositories: granted };
  }

  return {
    account,
    async mint(raw) {
      const v = validateTokenRequest(raw);
      const allow = o.allow?.();
      if (allow) {
        const allowed = new Set(allow.map((r) => r.toLowerCase()));
        const outside = v.repositories.filter((r) => !allowed.has(r));
        if (outside.length) throw new AppTokenError(`not in github.repositories: ${outside.join(', ')}`, 403);
      }
      if (v.owner && v.owner.toLowerCase() !== (await account()).toLowerCase()) {
        throw new AppTokenError(`owner ${v.owner} is not this installation's account`, 403);
      }
      const req: TokenRequest = { repositories: v.repositories, permissions: v.permissions ?? o.defaultPermissions?.() ?? undefined };
      const key = JSON.stringify(req);
      const hit = cache.get(key);
      if (hit && hit.expiresAt - now() > REFRESH_BEFORE_MS) return hit;
      let p = inflight.get(key);
      if (!p) {
        p = fetchToken(req).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      const tok = await p;
      cache.delete(key);
      cache.set(key, tok);
      while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      return tok;
    }
  };
}
