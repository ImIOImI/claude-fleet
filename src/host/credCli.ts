// fleet-host-cred: the session side of the App credential helper (git's
// credential protocol and the gh shim) plus `serve` for a standalone server.
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
// gh flags whose value is free text, so a URL in it says nothing about the target.
const TEXT_FLAGS = ['--body', '-b', '--body-file', '--title', '-t', '--notes', '-n', '--message', '-m', '--subject', '--field', '-f', '--raw-field', '-F', '--header', '-H', '--jq', '-q', '--template'];
const REMOTE_ORDER = ['upstream', 'github', 'origin'];

export interface GitRemote { name: string; url: string }

function withoutTextValues(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (TEXT_FLAGS.includes(a)) i++;
    else if (TEXT_FLAGS.some((f) => (f.startsWith('--') ? a.startsWith(`${f}=`) : a.startsWith(f) && a.length > 2))) continue;
    else out.push(a);
  }
  return out;
}

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

/** gh's default-repo order; any remote off github.com means no token. */
function repoFromRemotes(remotes: GitRemote[]): OwnerRepo | null {
  if (remotes.length === 0 || remotes.some((r) => !repoFromGitUrl(r.url))) return null;
  const rank = (r: GitRemote) => (REMOTE_ORDER.includes(r.name) ? REMOTE_ORDER.indexOf(r.name) : REMOTE_ORDER.length);
  const best = remotes.reduce((a, b) => (rank(b) < rank(a) ? b : a));
  return repoFromGitUrl(best.url);
}

export function repoFromGhArgs(all: string[], env: NodeJS.ProcessEnv, cwdRemotes: () => GitRemote[]): OwnerRepo | null {
  const args = withoutTextValues(all);
  if (ghOtherHost(args, env)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-R' || a === '--repo') return ownerRepo(args[i + 1] ?? '');
    if (a.startsWith('--repo=')) return ownerRepo(a.slice('--repo='.length));
    if (a.startsWith('-R') && a.length > 2) return ownerRepo(a.slice(2));
  }
  if (env.GH_REPO) return ownerRepo(env.GH_REPO);
  if (args[0] === 'api' && args[1]) {
    const m = /^(?:https:\/\/api\.github\.com)?\/?repos\/([^/]+)\/([^/?#]+)/i.exec(args[1]);
    if (m) return ownerRepo(`${m[1]}/${m[2]}`);
  }
  for (const a of args) {
    const m = /^https:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(a);
    if (m) return ownerRepo(`${m[1]}/${m[2]}`);
  }
  return repoFromRemotes(cwdRemotes());
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
  /** Tokens are never written to a terminal: anything printed in a session reaches its viewers. */
  stdoutIsTty: boolean;
  /** The cwd repo's `remote.<name>.url` entries. */
  cwdRemotes(): GitRemote[];
}

const USAGE = 'usage: fleet-host-cred git-credential <get|store|erase> | gh-token -- <gh args> | serve';

export async function runCredCli(argv: string[], io: CredIo): Promise<number> {
  const sock = io.env.FLEET_HOST_CRED_SOCKET || DEFAULT_CRED_SOCKET;
  const say = (e: unknown) => io.err(`fleet-host-cred: ${(e as Error).message}\n`);
  const isGet = argv[0] === 'gh-token' || (argv[0] === 'git-credential' && argv[1] === 'get');
  if (isGet && io.stdoutIsTty) {
    io.err('fleet-host-cred: refusing to print a token to a terminal\n');
    return 1;
  }
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
      const r = repoFromGhArgs(argv.slice(argv[1] === '--' ? 2 : 1), io.env, io.cwdRemotes);
      if (!r) return 0;
      try {
        io.out(`${await requestToken(sock, { owner: r.owner, repositories: [r.repo] })}\n`);
      } catch (e) {
        say(e);
      }
      return 0;
    }
    default:
      io.err(`${USAGE}\n`);
      return 2;
  }
}
