import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoFromCredentialInput, repoFromGhArgs, repoFromGitUrl, runCredCli, type CredIo } from './credCli.js';
import { DEFAULT_PERMISSIONS } from './appToken.js';
import { startCredHelper, type CredServer } from './credServer.js';
import { createLogger } from './log.js';
import { startFakeGithubApp, type FakeGithubApp } from './testGithubApp.js';

describe('repo parsers', () => {
  it('reads owner/repo from GitHub remote URLs only', () => {
    expect(repoFromGitUrl('https://github.com/SumerSports/fleet-reviews.git')).toEqual({ owner: 'SumerSports', repo: 'fleet-reviews' });
    expect(repoFromGitUrl('https://x-access-token@github.com/acme/a')).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGitUrl('git@github.com:acme/a.git')).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGitUrl('https://gitlab.com/acme/a.git')).toBeNull();
    expect(repoFromGitUrl('https://github.com/acme')).toBeNull();
  });

  it('reads git credential input (useHttpPath) and ignores other hosts', () => {
    expect(repoFromCredentialInput('protocol=https\nhost=github.com\npath=acme/a.git\n\n')).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromCredentialInput('protocol=https\nhost=github.com\n\n')).toBeNull();
    expect(repoFromCredentialInput('protocol=https\nhost=example.com\npath=acme/a\n')).toBeNull();
    expect(repoFromCredentialInput('protocol=http\nhost=github.com\npath=acme/a\n')).toBeNull();
    expect(repoFromCredentialInput('protocol=https\nhost=github.com:8443\npath=acme/a\n')).toBeNull();
  });

  const none = () => [];
  const remotes = (...r: [string, string][]) => () => r.map(([name, url]) => ({ name, url }));
  const origin = remotes(['origin', 'https://github.com/acme/f.git']);

  it('finds the repo gh acts on: -R/--repo, GH_REPO, gh api repos/…, a github.com URL, then the remotes', () => {
    expect(repoFromGhArgs(['pr', 'view', '1', '-R', 'acme/a'], {}, none)).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGhArgs(['pr', 'list', '--repo=acme/b'], {}, none)).toEqual({ owner: 'acme', repo: 'b' });
    expect(repoFromGhArgs(['pr', 'list', '-Racme/c'], {}, none)).toEqual({ owner: 'acme', repo: 'c' });
    expect(repoFromGhArgs(['issue', 'list'], { GH_REPO: 'acme/d' }, none)).toEqual({ owner: 'acme', repo: 'd' });
    expect(repoFromGhArgs(['api', 'repos/acme/e/pulls/1'], {}, none)).toEqual({ owner: 'acme', repo: 'e' });
    expect(repoFromGhArgs(['api', 'https://api.github.com/repos/acme/e2/pulls'], {}, none)).toEqual({ owner: 'acme', repo: 'e2' });
    expect(repoFromGhArgs(['pr', 'view', 'https://github.com/acme/g/pull/7'], {}, origin)).toEqual({ owner: 'acme', repo: 'g' });
    expect(repoFromGhArgs(['pr', 'view'], {}, remotes(['origin', 'git@github.com:acme/f.git']))).toEqual({ owner: 'acme', repo: 'f' });
    expect(repoFromGhArgs(['search', 'prs'], {}, none)).toBeNull();
  });

  it('picks the remote the way gh does: upstream, github, origin, then the first', () => {
    const u = (n: string) => `https://github.com/acme/${n}.git`;
    expect(repoFromGhArgs(['pr', 'list'], {}, remotes(['fork', u('x')], ['origin', u('o')], ['upstream', u('u')]))).toEqual({ owner: 'acme', repo: 'u' });
    expect(repoFromGhArgs(['pr', 'list'], {}, remotes(['origin', u('o')], ['github', u('g')]))).toEqual({ owner: 'acme', repo: 'g' });
    expect(repoFromGhArgs(['pr', 'list'], {}, remotes(['fork', u('x')], ['origin', u('o')]))).toEqual({ owner: 'acme', repo: 'o' });
    expect(repoFromGhArgs(['pr', 'list'], {}, remotes(['fork', u('x')]))).toEqual({ owner: 'acme', repo: 'x' });
  });

  it('ignores URLs that are the values of text flags', () => {
    expect(repoFromGhArgs(['pr', 'create', '--body', 'see https://evil.example/x', '-R', 'acme/a'], {}, none)).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGhArgs(['pr', 'create', '-t', 'https://evil.example/x'], {}, origin)).toEqual({ owner: 'acme', repo: 'f' });
    expect(repoFromGhArgs(['pr', 'create', '--title=https://evil.example/x'], {}, origin)).toEqual({ owner: 'acme', repo: 'f' });
    expect(repoFromGhArgs(['pr', 'comment', '-b', 'https://github.com/acme/z/pull/1'], {}, origin)).toEqual({ owner: 'acme', repo: 'f' });
    expect(repoFromGhArgs(['pr', 'create', '--body', '-R', 'acme/a'], {}, origin)).toEqual({ owner: 'acme', repo: 'f' });
  });

  it('gives no repo when gh would talk to another host', () => {
    expect(repoFromGhArgs(['pr', 'view', '-R', 'evil.example/acme/a'], {}, origin)).toBeNull();
    expect(repoFromGhArgs(['pr', 'view', '-R', 'github.com/acme/a'], {}, origin)).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGhArgs(['pr', 'view'], { GH_REPO: 'evil.example/acme/a' }, origin)).toBeNull();
    expect(repoFromGhArgs(['pr', 'view'], { GH_HOST: 'evil.example' }, origin)).toBeNull();
    expect(repoFromGhArgs(['pr', 'view'], { GH_HOST: 'github.com' }, origin)).toEqual({ owner: 'acme', repo: 'f' });
    expect(repoFromGhArgs(['api', '--hostname', 'evil.example', 'repos/acme/a'], {}, origin)).toBeNull();
    expect(repoFromGhArgs(['api', '--hostname=evil.example', 'repos/acme/a'], {}, origin)).toBeNull();
    expect(repoFromGhArgs(['api', 'https://evil.example/repos/acme/a'], {}, origin)).toBeNull();
    expect(repoFromGhArgs(['pr', 'view'], {}, remotes(['origin', 'https://evil.example/acme/a.git']))).toBeNull();
    expect(repoFromGhArgs(['pr', 'view'], {}, remotes(['origin', 'https://github.com/acme/a.git'], ['mirror', 'https://gitlab.example/acme/a.git']))).toBeNull();
    expect(repoFromGhArgs(['pr', 'view'], {}, remotes(['origin', 'https://github.com/acme/a.git'], ['local', '../a']))).toBeNull();
  });
});

describe('runCredCli', () => {
  let gh: FakeGithubApp | null = null;
  let srv: CredServer | null = null;
  afterEach(async () => {
    await srv?.close();
    await gh?.close();
  });

  async function rig() {
    gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos: ['a', 'b'] });
    const dir = mkdtempSync(join(tmpdir(), 'credcli-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const sock = join(dir, 'run', 'cred.sock');
    srv = await startCredHelper({
      app: { appId: '1', installationId: '2', keyFile: join(dir, 'key.pem') }, listen: { path: sock },
      github: () => null, log: createLogger(() => undefined), apiBase: gh.url
    });
    return sock;
  }

  function io(sock: string | null, stdin = '', stdoutIsTty = false) {
    const out: string[] = [];
    const err: string[] = [];
    const o: CredIo = {
      env: sock ? { FLEET_HOST_CRED_SOCKET: sock } : { FLEET_HOST_CRED_SOCKET: '/nonexistent/cred.sock' },
      stdin: async () => stdin, out: (s) => out.push(s), err: (s) => err.push(s), stdoutIsTty,
      cwdRemotes: () => []
    };
    return { o, out, err };
  }

  it('git-credential get answers with x-access-token for the one repo in the path', async () => {
    const sock = await rig();
    const { o, out } = io(sock, 'protocol=https\nhost=github.com\npath=acme/a.git\n\n');
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(0);
    expect(out.join('')).toMatch(/^username=x-access-token\npassword=ghs_fake\w+\n$/);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['a'], permissions: DEFAULT_PERMISSIONS });
  });

  it('git-credential store/erase and non-GitHub hosts print nothing and succeed', async () => {
    const sock = await rig();
    for (const [argv, stdin] of [[['git-credential', 'store'], ''], [['git-credential', 'get'], 'protocol=https\nhost=example.com\npath=x/y\n']] as const) {
      const { o, out } = io(sock, stdin);
      expect(await runCredCli([...argv], o)).toBe(0);
      expect(out).toEqual([]);
    }
  });

  it('with the helper off (no socket, or nothing listening), git-credential and gh-token print nothing and exit 0', async () => {
    const dead = join(mkdtempSync(join(tmpdir(), 'credcli-')), 'cred.sock');
    writeFileSync(dead, '');
    for (const sock of [null, dead]) {
      for (const argv of [['git-credential', 'get'], ['gh-token', '--', 'pr', 'view', '-R', 'acme/a']]) {
        const { o, out, err } = io(sock, 'protocol=https\nhost=github.com\npath=acme/a\n');
        expect(await runCredCli(argv, o)).toBe(0);
        expect(out).toEqual([]);
        expect(err).toEqual([]);
      }
    }
  });

  it('a helper error is reported on stderr and still exits 0', async () => {
    const sock = join(mkdtempSync(join(tmpdir(), 'credcli-')), 'cred.sock');
    const failing = createServer((_req, res) => res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal error"}'));
    await new Promise<void>((r) => failing.listen(sock, () => r()));
    try {
      const { o, out, err } = io(sock, 'protocol=https\nhost=github.com\npath=acme/a\n');
      expect(await runCredCli(['git-credential', 'get'], o)).toBe(0);
      expect(out).toEqual([]);
      expect(err.join('')).toMatch(/fleet-host-cred: 500: internal error/);
    } finally {
      await new Promise<void>((r) => failing.close(() => r()));
    }
  });

  it('gh-token prints a token for the repo gh acts on, or nothing', async () => {
    const sock = await rig();
    const a = io(sock);
    expect(await runCredCli(['gh-token', '--', 'pr', 'view', '-R', 'acme/b'], a.o)).toBe(0);
    expect(a.out.join('')).toMatch(/^ghs_fake\w+\n$/);
    const none = io(sock);
    expect(await runCredCli(['gh-token', '--', 'search', 'prs'], none.o)).toBe(0);
    expect(none.out).toEqual([]);
  });

  it('never prints a token to a terminal, and has no token subcommand', async () => {
    const sock = await rig();
    const posts = () => gh!.requests.filter((r) => r.method === 'POST').length;
    const before = posts();
    const t = io(sock, '', true);
    expect(await runCredCli(['gh-token', '--', 'pr', 'view', '-R', 'acme/b'], t.o)).toBe(1);
    expect(t.out).toEqual([]);
    expect(t.err.join('')).toMatch(/terminal/);
    const g = io(sock, 'protocol=https\nhost=github.com\npath=acme/a\n', true);
    expect(await runCredCli(['git-credential', 'get'], g.o)).toBe(1);
    expect(g.out).toEqual([]);
    const tok = io(sock);
    expect(await runCredCli(['token', '--repo', 'acme/a'], tok.o)).toBe(2);
    expect(tok.out).toEqual([]);
    expect(tok.err.join('')).not.toMatch(/token --repo/);
    expect(posts()).toBe(before);
  });

  it('posts to FLEET_HOST_CRED_ADDR over TCP when it is set', async () => {
    gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos: ['a'] });
    const dir = mkdtempSync(join(tmpdir(), 'credcli-tcp-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    srv = await startCredHelper({
      app: { appId: '1', installationId: '2', keyFile: join(dir, 'key.pem') }, listen: { port: 0, host: '127.0.0.1' },
      github: () => null, log: createLogger(() => undefined), apiBase: gh.url
    });
    const out: string[] = [];
    const o: CredIo = {
      env: { FLEET_HOST_CRED_ADDR: `127.0.0.1:${srv.port}`, FLEET_HOST_CRED_SOCKET: '/nonexistent/cred.sock' },
      stdin: async () => 'protocol=https\nhost=github.com\npath=acme/a.git\n\n', out: (s) => out.push(s), err: () => undefined,
      stdoutIsTty: false, cwdRemotes: () => []
    };
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(0);
    expect(out.join('')).toMatch(/^username=x-access-token\npassword=ghs_fake\w+\n$/);
  });

  it('exits 1 on a malformed FLEET_HOST_CRED_ADDR', async () => {
    const err: string[] = [];
    const o: CredIo = {
      env: { FLEET_HOST_CRED_ADDR: 'http://h:1' }, stdin: async () => '', out: () => undefined, err: (s) => err.push(s),
      stdoutIsTty: false, cwdRemotes: () => []
    };
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(1);
    expect(err.join('')).toBe('fleet-host-cred: FLEET_HOST_CRED_ADDR http://h:1 is not host:port\n');
  });
});
