import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execInherit, findRealGh, repoFromCredentialInput, repoFromGhArgs, repoFromGitUrl, runCredCli, type CredIo } from './credCli.js';
import { DEFAULT_PERMISSIONS } from './appToken.js';
import { parseHostConfig, type HostGithubConfig } from './config.js';
import { startCredHelper, type CredServer } from './credServer.js';
import { createLogger } from './log.js';
import { startFakeGithubApp, type FakeGithubApp } from './testGithubApp.js';

function fakeExe(dir: string, name: string, body = 'exit 0'): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const realGh = fakeExe(mkdtempSync(join(tmpdir(), 'credcli-gh-')), 'gh');

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

  async function rig(github: HostGithubConfig | null = null, repos = ['a', 'b']) {
    gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos });
    const dir = mkdtempSync(join(tmpdir(), 'credcli-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const sock = join(dir, 'run', 'cred.sock');
    srv = await startCredHelper({
      app: { appId: '1', installationId: '2', keyFile: join(dir, 'key.pem') }, listen: { path: sock },
      github: () => github, log: createLogger(() => undefined), apiBase: gh.url
    });
    return sock;
  }

  function io(sock: string | null, stdin = '', stdoutIsTty = false, env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const execs: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const o: CredIo = {
      env: { FLEET_HOST_CRED_SOCKET: sock ?? '/nonexistent/cred.sock', FLEET_GH_REAL: realGh, ...env },
      stdin: async () => stdin, out: (s) => out.push(s), err: (s) => err.push(s), stdoutIsTty,
      cwdRemotes: () => [],
      exec: async (file, args, env) => (execs.push({ file, args, env }), 7)
    };
    return { o, out, err, execs };
  }

  it('git-credential get answers with x-access-token for the one repo in the path', async () => {
    const sock = await rig();
    const { o, out } = io(sock, 'protocol=https\nhost=github.com\npath=acme/a.git\n\n');
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(0);
    expect(out.join('')).toMatch(/^username=x-access-token\npassword=ghs_fake\w+\n$/);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['a'], permissions: DEFAULT_PERMISSIONS });
  });

  it('git-credential and gh get a read-only token for a github.readOnlyRepositories repo', async () => {
    const sock = await rig({ app: null, repositories: null, permissions: null, readOnlyRepositories: ['acme/a'] });
    const read = Object.fromEntries(Object.keys(DEFAULT_PERMISSIONS).sort().map((k) => [k, 'read']));
    const push = io(sock, 'protocol=https\nhost=github.com\npath=acme/a.git\n\n');
    expect(await runCredCli(['git-credential', 'get'], push.o)).toBe(0);
    expect(push.out.join('')).toMatch(/^username=x-access-token\npassword=ghs_fake\w+\n$/);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['a'], permissions: read });
    const ghCall = io(sock);
    expect(await runCredCli(['gh', '--', 'pr', 'view', '-R', 'acme/a'], ghCall.o)).toBe(7);
    expect(gh!.requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([{ repositories: ['a'], permissions: read }]);
    const other = io(sock, 'protocol=https\nhost=github.com\npath=acme/b.git\n\n');
    expect(await runCredCli(['git-credential', 'get'], other.o)).toBe(0);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['b'], permissions: DEFAULT_PERMISSIONS });
  });

  it('a host config without readOnlyRepositories still mints only read tokens for the loadouts repo (D168)', async () => {
    const github = parseHostConfig({ workspace: { name: 'w' }, grants: [], github: {} }).github;
    const sock = await rig(github, ['claude-fleet-loadouts']);
    const read = Object.fromEntries(Object.keys(DEFAULT_PERMISSIONS).sort().map((k) => [k, 'read']));
    const push = io(sock, 'protocol=https\nhost=github.com\npath=acme/claude-fleet-loadouts.git\n\n');
    expect(await runCredCli(['git-credential', 'get'], push.o)).toBe(0);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['claude-fleet-loadouts'], permissions: read });
  });

  it('git-credential store/erase and non-GitHub hosts print nothing and succeed', async () => {
    const sock = await rig();
    for (const [argv, stdin] of [[['git-credential', 'store'], ''], [['git-credential', 'get'], 'protocol=https\nhost=example.com\npath=x/y\n']] as const) {
      const { o, out } = io(sock, stdin);
      expect(await runCredCli([...argv], o)).toBe(0);
      expect(out).toEqual([]);
    }
  });

  it('with the helper off (no socket, or nothing listening), git-credential prints nothing and gh runs without a token', async () => {
    const dead = join(mkdtempSync(join(tmpdir(), 'credcli-')), 'cred.sock');
    writeFileSync(dead, '');
    for (const sock of [null, dead]) {
      const g = io(sock, 'protocol=https\nhost=github.com\npath=acme/a\n');
      expect(await runCredCli(['git-credential', 'get'], g.o)).toBe(0);
      expect([g.out, g.err]).toEqual([[], []]);
      const h = io(sock);
      expect(await runCredCli(['gh', '--', 'pr', 'view', '-R', 'acme/a'], h.o)).toBe(7);
      expect([h.out, h.err]).toEqual([[], []]);
      expect(h.execs[0].env.GH_TOKEN).toBeUndefined();
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

  it('gh runs the real gh with the scoped token only in its env, passing args and exit code through', async () => {
    const sock = await rig();
    for (const tty of [false, true]) {
      const a = io(sock, '', tty);
      expect(await runCredCli(['gh', '--', 'pr', 'view', '-R', 'acme/b', '--body', 'x y'], a.o)).toBe(7);
      expect(a.execs).toHaveLength(1);
      expect(a.execs[0].file).toBe(realGh);
      expect(a.execs[0].args).toEqual(['pr', 'view', '-R', 'acme/b', '--body', 'x y']);
      expect(a.execs[0].env.GH_TOKEN).toMatch(/^ghs_fake\w+$/);
      expect(a.execs[0].env.FLEET_HOST_CRED_SOCKET).toBe(sock);
      expect(a.o.env.GH_TOKEN).toBeUndefined();
      expect([a.out, a.err]).toEqual([[], []]);
    }
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['b'], permissions: DEFAULT_PERMISSIONS });
    const none = io(sock);
    expect(await runCredCli(['gh', '--', 'search', 'prs'], none.o)).toBe(7);
    expect(none.execs[0].env.GH_TOKEN).toBeUndefined();
  });

  it('an explicit GH_TOKEN wins and mints nothing', async () => {
    const sock = await rig();
    const posts = () => gh!.requests.filter((r) => r.method === 'POST').length;
    const before = posts();
    const a = io(sock, '', false, { GH_TOKEN: 'mine' });
    expect(await runCredCli(['gh', '--', 'pr', 'view', '-R', 'acme/a'], a.o)).toBe(7);
    expect(a.execs[0].env.GH_TOKEN).toBe('mine');
    expect(posts()).toBe(before);
  });

  it('a helper error reaches stderr as one short line and gh still runs without a token', async () => {
    const sock = join(mkdtempSync(join(tmpdir(), 'credcli-')), 'cred.sock');
    const failing = createServer((_req, res) => res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `not in github.repositories: ${'x'.repeat(300)}\nsecond line` })));
    await new Promise<void>((r) => failing.listen(sock, () => r()));
    try {
      const a = io(sock);
      expect(await runCredCli(['gh', '--', 'pr', 'view', '-R', 'acme/a'], a.o)).toBe(7);
      const e = a.err.join('');
      expect(e).toMatch(/^fleet-host-cred: 403: not in github\.repositories: x+\n$/);
      expect(e.length).toBeLessThanOrEqual(200);
      expect(a.execs[0].env.GH_TOKEN).toBeUndefined();
    } finally {
      await new Promise<void>((r) => failing.close(() => r()));
    }
  });

  it('gh with a malformed FLEET_HOST_CRED_ADDR says so and runs gh without a token', async () => {
    const a = io(null, '', false, { FLEET_HOST_CRED_ADDR: 'http://h:1' });
    expect(await runCredCli(['gh', '--', 'pr', 'view', '-R', 'acme/a'], a.o)).toBe(7);
    expect(a.err.join('')).toMatch(/FLEET_HOST_CRED_ADDR http:\/\/h:1 is not host:port/);
    expect(a.execs[0].env.GH_TOKEN).toBeUndefined();
  });

  it('gh exits 127 when there is no real gh', async () => {
    const a = io(null, '', false, { FLEET_GH_REAL: '/nonexistent/gh' });
    expect(await runCredCli(['gh', '--', 'pr', 'list'], a.o)).toBe(127);
    expect(a.err.join('')).toBe('fleet-host-cred: gh is not installed in this image\n');
    expect(a.execs).toEqual([]);
  });

  it('no subcommand prints a token: gh-token and token are gone, git-credential refuses a terminal', async () => {
    const sock = await rig();
    const posts = () => gh!.requests.filter((r) => r.method === 'POST').length;
    const before = posts();
    for (const argv of [['gh-token', '--', 'pr', 'view', '-R', 'acme/b'], ['token', '--repo', 'acme/a']]) {
      const t = io(sock);
      expect(await runCredCli(argv, t.o)).toBe(2);
      expect(t.out).toEqual([]);
      expect(t.execs).toEqual([]);
      expect(t.err.join('')).toMatch(/^usage: .*gh -- <gh args> \(runs gh with a scoped token\)/);
      expect(t.err.join('')).not.toMatch(/gh-token|token --repo/);
    }
    const g = io(sock, 'protocol=https\nhost=github.com\npath=acme/a\n', true);
    expect(await runCredCli(['git-credential', 'get'], g.o)).toBe(1);
    expect(g.out).toEqual([]);
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
      stdoutIsTty: false, cwdRemotes: () => [], exec: async () => 0
    };
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(0);
    expect(out.join('')).toMatch(/^username=x-access-token\npassword=ghs_fake\w+\n$/);
  });

  it('exits 1 on a malformed FLEET_HOST_CRED_ADDR', async () => {
    const err: string[] = [];
    const o: CredIo = {
      env: { FLEET_HOST_CRED_ADDR: 'http://h:1' }, stdin: async () => '', out: () => undefined, err: (s) => err.push(s),
      stdoutIsTty: false, cwdRemotes: () => [], exec: async () => 0
    };
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(1);
    expect(err.join('')).toBe('fleet-host-cred: FLEET_HOST_CRED_ADDR http://h:1 is not host:port\n');
  });
});

describe('findRealGh', () => {
  it('takes FLEET_GH_REAL, else the first executable gh on PATH that is not the shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'credcli-path-'));
    const shim = fakeExe(join(root, 'shim'), 'gh');
    const link = join(root, 'link');
    mkdirSync(link);
    symlinkSync(shim, join(link, 'gh'));
    const noexec = join(root, 'noexec');
    mkdirSync(noexec);
    writeFileSync(join(noexec, 'gh'), '');
    const real = fakeExe(join(root, 'real'), 'gh');
    const later = fakeExe(join(root, 'later'), 'gh');
    const PATH = ['', 'rel', join(root, 'shim'), link, noexec, join(root, 'empty'), join(root, 'real'), join(root, 'later')].join(':');
    expect(findRealGh({ PATH }, shim)).toBe(real);
    expect(findRealGh({ PATH: [join(root, 'shim'), link].join(':') }, shim)).toBeNull();
    expect(findRealGh({ PATH, FLEET_GH_REAL: later }, shim)).toBe(later);
    expect(findRealGh({ PATH, FLEET_GH_REAL: join(noexec, 'gh') }, shim)).toBeNull();
  });
});

describe('execInherit', () => {
  it('passes args and env to the child and returns its exit code, or 128+n when signalled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'credcli-exec-'));
    const rec = join(dir, 'rec');
    const child = fakeExe(dir, 'child', `printf '%s|' "$GH_TOKEN" "$@" > "${rec}"; [ "$1" = kill ] && kill -TERM $$; exit 3`);
    expect(await execInherit(child, ['a b', '-R', 'acme/a'], { GH_TOKEN: 'ghs_FAKE' })).toBe(3);
    expect(readFileSync(rec, 'utf8')).toBe('ghs_FAKE|a b|-R|acme/a|');
    expect(await execInherit(child, ['kill'], {})).toBe(128 + 15);
    expect(await execInherit(join(dir, 'missing'), [], {})).toBe(127);
  });
});
