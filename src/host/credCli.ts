// fleet-host-cred: the session side of the App credential helper (git's
// credential protocol, the gh shim, scripts) plus `serve` for a standalone server.
import { request } from 'node:http';
import { DEFAULT_CRED_SOCKET } from './credServer.js';

export interface OwnerRepo { owner: string; repo: string }

const OWNER_REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/;

function ownerRepo(s: string): OwnerRepo | null {
  const m = OWNER_REPO.exec(s.replace(/^github\.com\//, ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function repoFromGitUrl(url: string): OwnerRepo | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+)$/.exec(url.trim());
  return m ? ownerRepo(m[1]) : null;
}

/** git sends `key=value` lines; with useHttpPath it includes `path=owner/repo(.git)`. */
export function repoFromCredentialInput(text: string): OwnerRepo | null {
  const kv = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1));
  }
  if (kv.get('protocol') !== 'https' || kv.get('host') !== 'github.com' || !kv.get('path')) return null;
  return ownerRepo(kv.get('path')!);
}

const GITHUB_HOSTS = new Set(['github.com', 'api.github.com']);

/** gh pointed at any other host must not carry a github.com token. */
function ghOtherHost(args: string[], env: NodeJS.ProcessEnv): boolean {
  if (env.GH_HOST && !GITHUB_HOSTS.has(env.GH_HOST.toLowerCase())) return true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const h = a === '--hostname' ? (args[i + 1] ?? '') : a.startsWith('--hostname=') ? a.slice('--hostname='.length) : null;
    if (h !== null && !GITHUB_HOSTS.has(h.toLowerCase())) return true;
    const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(a);
    if (url && !GITHUB_HOSTS.has(url[1].replace(/^[^@]*@/, '').toLowerCase())) return true;
  }
  return false;
}

export function repoFromGhArgs(args: string[], env: NodeJS.ProcessEnv, cwdOrigin: () => string | null): OwnerRepo | null {
  if (ghOtherHost(args, env)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-R' || a === '--repo') return ownerRepo(args[i + 1] ?? '');
    if (a.startsWith('--repo=')) return ownerRepo(a.slice('--repo='.length));
    if (a.startsWith('-R') && a.length > 2) return ownerRepo(a.slice(2));
  }
  if (env.GH_REPO) return ownerRepo(env.GH_REPO);
  if (args[0] === 'api' && args[1]) {
    const m = /^\/?repos\/([^/]+)\/([^/?#]+)/.exec(args[1]);
    if (m) return ownerRepo(`${m[1]}/${m[2]}`);
  }
  const origin = cwdOrigin();
  return origin ? repoFromGitUrl(origin) : null;
}

export function requestToken(socketPath: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/token', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 15_000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (raw += c));
      res.on('end', () => {
        let j: { token?: unknown; error?: unknown } = {};
        try {
          j = JSON.parse(raw);
        } catch {
          /* status says it */
        }
        if (res.statusCode === 200 && typeof j.token === 'string') resolve(j.token);
        else reject(new Error(`${res.statusCode}: ${typeof j.error === 'string' ? j.error : 'no token'}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(new Error(`credential helper unavailable (${e.code ?? e.message})`)));
    req.end(JSON.stringify(body));
  });
}

export interface CredIo {
  env: NodeJS.ProcessEnv;
  stdin(): Promise<string>;
  out(s: string): void;
  err(s: string): void;
  /** `git remote get-url origin` in the cwd, or null. */
  cwdOrigin(): string | null;
}

const USAGE = 'usage: fleet-host-cred token --repo <name|owner/name>... | git-credential <get|store|erase> | gh-token -- <gh args> | serve';

export async function runCredCli(argv: string[], io: CredIo): Promise<number> {
  const sock = io.env.FLEET_HOST_CRED_SOCKET || DEFAULT_CRED_SOCKET;
  const say = (e: unknown) => io.err(`fleet-host-cred: ${(e as Error).message}\n`);
  switch (argv[0]) {
    case 'git-credential': {
      const input = await io.stdin();
      if (argv[1] !== 'get') return 0;
      const r = repoFromCredentialInput(input);
      if (!r) return 0;
      try {
        const token = await requestToken(sock, { owner: r.owner, repositories: [r.repo] });
        io.out(`username=x-access-token\npassword=${token}\n`);
      } catch (e) {
        say(e);
      }
      return 0;
    }
    case 'gh-token': {
      const r = repoFromGhArgs(argv.slice(argv[1] === '--' ? 2 : 1), io.env, io.cwdOrigin);
      if (!r) return 0;
      try {
        io.out(`${await requestToken(sock, { owner: r.owner, repositories: [r.repo] })}\n`);
      } catch (e) {
        say(e);
      }
      return 0;
    }
    case 'token': {
      const repos: string[] = [];
      let owner: string | undefined;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] !== '--repo' || !argv[i + 1]) return (io.err(`${USAGE}\n`), 2);
        const v = argv[++i];
        const r = v.includes('/') ? ownerRepo(v) : { owner: undefined, repo: v };
        if (!r) return (io.err(`${USAGE}\n`), 2);
        if (r.owner) owner = r.owner;
        repos.push(r.repo);
      }
      if (repos.length === 0) return (io.err(`${USAGE}\n`), 2);
      try {
        io.out(`${await requestToken(sock, { ...(owner ? { owner } : {}), repositories: repos })}\n`);
        return 0;
      } catch (e) {
        say(e);
        return 1;
      }
    }
    default:
      io.err(`${USAGE}\n`);
      return 2;
  }
}
