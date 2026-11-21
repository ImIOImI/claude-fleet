import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultBranch, downloadTarball, readCapped, resolveTag, type GithubSource } from './loadoutFetch.js';
import { extractLoadout } from './loadoutTar.js';
import { annotatedSha, loadoutFiles, sha, startFakeGithubRepo, type FakeGithubRepo } from './testGithubRepo.js';

const R = '/repos/SumerSports/claude-fleet-loadouts';
let gh: FakeGithubRepo;
let src: GithubSource;
let dir: string;
const signal = (): AbortSignal => AbortSignal.timeout(5_000);
const failure = (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: Error) => e
  );

beforeEach(async () => {
  gh = await startFakeGithubRepo({ owner: 'SumerSports', repo: 'claude-fleet-loadouts' });
  src = { api: gh.url, owner: 'SumerSports', repo: 'claude-fleet-loadouts', token: gh.token };
  dir = await mkdtemp(join(tmpdir(), 'lfetch-'));
});
afterEach(async () => {
  await gh.close();
  await rm(dir, { recursive: true, force: true });
});

describe('loadoutFetch', () => {
  it('reads the default branch with the token', async () => {
    expect(await defaultBranch(src, signal())).toBe('main');
    expect(gh.requests).toEqual([{ method: 'GET', path: R, auth: `Bearer ${gh.token}` }]);
  });

  it('resolves a lightweight tag on the default branch', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    expect(await resolveTag(src, 'demo/v1.0.0', 'main', signal())).toBe(sha(1));
    expect(gh.requests.map((r) => r.path)).toEqual([`${R}/git/ref/tags/demo/v1.0.0`, `${R}/compare/${sha(1)}...main`]);
  });

  it('dereferences an annotated tag', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: {}, annotated: true });
    expect(await resolveTag(src, 'demo/v1.0.0', 'main', signal())).toBe(sha(1));
    expect(gh.requests.map((r) => r.path)).toContain(`${R}/git/tags/${annotatedSha(sha(1))}`);
  });

  it('refuses a tag whose commit is not on the default branch', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: {}, onMain: false });
    await expect(resolveTag(src, 'demo/v1.0.0', 'main', signal())).rejects.toThrow('resolve: tag demo/v1.0.0 is not on main');
  });

  it('reports a missing tag as a 404', async () => {
    await expect(resolveTag(src, 'demo/v9.9.9', 'main', signal())).rejects.toMatchObject({
      stage: 'resolve',
      status: 404,
      message: 'resolve: tag demo/v9.9.9 → HTTP 404'
    });
  });

  it('never puts the token in an error', async () => {
    const bad = { ...src, token: `ghs_${'x'.repeat(36)}` };
    const e = await failure(defaultBranch(bad, signal()));
    expect(e.message).toBe('resolve: repository → HTTP 401');
    expect(e.message).not.toContain(bad.token);
  });

  it('downloads through the codeload redirect without the token', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    const tgz = await downloadTarball(src, sha(1), signal());
    expect(await extractLoadout(tgz, 'demo', dir)).toEqual(['loadout.md', 'skills/demo/SKILL.md']);
    expect(gh.requests.find((r) => r.path.startsWith('/codeload/'))).toEqual({ method: 'GET', path: `/codeload/${sha(1)}`, auth: null });
  });

  it('refuses a plain-http redirect to another origin', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    gh.location = () => 'http://evil.example/x';
    await expect(downloadTarball(src, sha(1), signal())).rejects.toThrow('download: redirect to http: refused');
  });

  it('caps the body', async () => {
    await expect(readCapped(new Response(Buffer.alloc(10)), 5)).rejects.toThrow('download: tarball is over 5 bytes');
    await expect(readCapped(new Response('x', { headers: { 'content-length': '6' } }), 5)).rejects.toThrow('download: tarball is over 5 bytes');
    expect(await readCapped(new Response(Buffer.alloc(5)), 5)).toHaveLength(5);
  });

  it('refuses a malformed token without sending it', async () => {
    await expect(defaultBranch({ ...src, token: 'has space' }, signal())).rejects.toThrow('resolve: the token is malformed');
    await expect(downloadTarball({ ...src, token: '' }, sha(1), signal())).rejects.toThrow('download: the token is malformed');
    expect(gh.requests).toEqual([]);
  });

  it('follows one redirect only', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    gh.location = (c) => `${gh.url}/bounce/${c}`;
    await expect(downloadTarball(src, sha(1), signal())).rejects.toThrow('download: tarball → HTTP 302');
    expect(gh.requests.some((r) => r.path.startsWith('/codeload/'))).toBe(false);
  });

  it('sends no token to an https redirect on another origin', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    gh.location = () => 'https://codeload.invalid/x?token=codeload-only';
    const seen: Headers[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://codeload.invalid/')) {
        seen.push(new Headers(init?.headers));
        return new Response('gz');
      }
      return real(input, init);
    }) as typeof fetch;
    try {
      expect((await downloadTarball(src, sha(1), signal())).toString()).toBe('gz');
    } finally {
      globalThis.fetch = real;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].get('authorization')).toBeNull();
  });

  it('keeps the URL and the token out of a network error', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    gh.location = () => 'https://codeload.invalid/x?token=codeload-secret';
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://codeload.invalid/')) throw new TypeError(`fetch failed: ${String(input)}`);
      if (String(input).endsWith('/claude-fleet-loadouts')) throw new TypeError(`bad header: Bearer ${gh.token}`);
      return real(input, init);
    }) as typeof fetch;
    try {
      const e = await failure(downloadTarball(src, sha(1), signal()));
      expect(e.message).toBe('download: unreachable (codeload.invalid)');
      const r = await failure(defaultBranch(src, signal()));
      expect(r.message).toMatch(/^resolve: unreachable \(127\.0\.0\.1:\d+\)$/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('refuses a ref that is not a commit, an API redirect and a non-sha download', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes('/git/ref/tags/')) return Response.json({ object: { type: 'tree', sha: sha(1) } });
      if (u.endsWith('/claude-fleet-loadouts')) return Response.json({ default_branch: 'main' }, { status: 301, headers: { location: 'https://x' } });
      return Response.json({ status: 'ahead' });
    }) as typeof fetch;
    try {
      await expect(resolveTag(src, 'demo/v1.0.0', 'main', signal())).rejects.toThrow('resolve: tag demo/v1.0.0 does not point at a commit');
      await expect(defaultBranch(src, signal())).rejects.toThrow('resolve: repository → HTTP 301');
    } finally {
      globalThis.fetch = real;
    }
    await expect(downloadTarball(src, 'main', signal())).rejects.toThrow('download: not a commit sha');
    expect(gh.requests).toEqual([]);
  });

  it('times out a stalled download', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    gh.hangTarball = true;
    await expect(downloadTarball(src, sha(1), AbortSignal.timeout(200))).rejects.toThrow(/^download: timed out \(127\.0\.0\.1:\d+\)$/);
  });
});
