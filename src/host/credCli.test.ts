import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoFromCredentialInput, repoFromGhArgs, repoFromGitUrl, runCredCli, type CredIo } from './credCli.js';
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

  it('finds the repo gh acts on: -R/--repo, GH_REPO, gh api repos/…, then the cwd origin', () => {
    const none = () => null;
    expect(repoFromGhArgs(['pr', 'view', '1', '-R', 'acme/a'], {}, none)).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGhArgs(['pr', 'list', '--repo=acme/b'], {}, none)).toEqual({ owner: 'acme', repo: 'b' });
    expect(repoFromGhArgs(['pr', 'list', '-Racme/c'], {}, none)).toEqual({ owner: 'acme', repo: 'c' });
    expect(repoFromGhArgs(['issue', 'list'], { GH_REPO: 'acme/d' }, none)).toEqual({ owner: 'acme', repo: 'd' });
    expect(repoFromGhArgs(['api', 'repos/acme/e/pulls/1'], {}, none)).toEqual({ owner: 'acme', repo: 'e' });
    expect(repoFromGhArgs(['pr', 'view'], {}, () => 'git@github.com:acme/f.git')).toEqual({ owner: 'acme', repo: 'f' });
    expect(repoFromGhArgs(['search', 'prs'], {}, none)).toBeNull();
  });

  it('gives no repo when gh would talk to another host', () => {
    const origin = () => 'https://github.com/acme/f.git';
    expect(repoFromGhArgs(['pr', 'view', '-R', 'evil.example/acme/a'], {}, origin)).toBeNull();
    expect(repoFromGhArgs(['pr', 'view', '-R', 'github.com/acme/a'], {}, origin)).toEqual({ owner: 'acme', repo: 'a' });
    expect(repoFromGhArgs(['pr', 'view'], { GH_REPO: 'evil.example/acme/a' }, origin)).toBeNull();
    expect(repoFromGhArgs(['pr', 'view'], { GH_HOST: 'evil.example' }, origin)).toBeNull();
    expect(repoFromGhArgs(['pr', 'view'], { GH_HOST: 'github.com' }, origin)).toEqual({ owner: 'acme', repo: 'f' });
    expect(repoFromGhArgs(['api', '--hostname', 'evil.example', 'repos/acme/a'], {}, origin)).toBeNull();
    expect(repoFromGhArgs(['api', '--hostname=evil.example', 'repos/acme/a'], {}, origin)).toBeNull();
    expect(repoFromGhArgs(['api', 'https://evil.example/repos/acme/a'], {}, origin)).toBeNull();
    expect(repoFromGhArgs(['pr', 'view'], {}, () => 'https://evil.example/acme/a.git')).toBeNull();
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
      app: { appId: '1', installationId: '2', keyFile: join(dir, 'key.pem') }, socketPath: sock,
      github: () => null, log: createLogger(() => undefined), apiBase: gh.url
    });
    return sock;
  }

  function io(sock: string | null, stdin = '', cwdOrigin: string | null = null) {
    const out: string[] = [];
    const err: string[] = [];
    const o: CredIo = {
      env: sock ? { FLEET_HOST_CRED_SOCKET: sock } : { FLEET_HOST_CRED_SOCKET: '/nonexistent/cred.sock' },
      stdin: async () => stdin, out: (s) => out.push(s), err: (s) => err.push(s), cwdOrigin: () => cwdOrigin
    };
    return { o, out, err };
  }

  it('git-credential get answers with x-access-token for the one repo in the path', async () => {
    const sock = await rig();
    const { o, out } = io(sock, 'protocol=https\nhost=github.com\npath=acme/a.git\n\n');
    expect(await runCredCli(['git-credential', 'get'], o)).toBe(0);
    expect(out.join('')).toMatch(/^username=x-access-token\npassword=ghs_fake\w+\n$/);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['a'] });
  });

  it('git-credential store/erase and non-GitHub hosts print nothing and succeed', async () => {
    const sock = await rig();
    for (const [argv, stdin] of [[['git-credential', 'store'], ''], [['git-credential', 'get'], 'protocol=https\nhost=example.com\npath=x/y\n']] as const) {
      const { o, out } = io(sock, stdin);
      expect(await runCredCli([...argv], o)).toBe(0);
      expect(out).toEqual([]);
    }
  });

  it('with the helper off, git-credential and gh-token print nothing and exit 0', async () => {
    for (const argv of [['git-credential', 'get'], ['gh-token', '--', 'pr', 'view', '-R', 'acme/a']]) {
      const { o, out, err } = io(null, 'protocol=https\nhost=github.com\npath=acme/a\n');
      expect(await runCredCli(argv, o)).toBe(0);
      expect(out).toEqual([]);
      expect(err.join('')).toMatch(/fleet-host-cred: /);
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

  it('token needs at least one --repo and exits 1 on refusal', async () => {
    const sock = await rig();
    const ok = io(sock);
    expect(await runCredCli(['token', '--repo', 'acme/a', '--repo', 'b'], ok.o)).toBe(0);
    expect(gh!.requests.at(-1)!.body).toEqual({ repositories: ['a', 'b'] });
    const bad = io(sock);
    expect(await runCredCli(['token'], bad.o)).toBe(2);
    const refused = io(sock);
    expect(await runCredCli(['token', '--repo', 'zzz'], refused.o)).toBe(1);
    expect(refused.err.join('')).toMatch(/400/);
  });
});
