import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appJwt, createTokenMinter, DEFAULT_PERMISSIONS, loadAppCredentials, REFRESH_BEFORE_MS } from './appToken.js';
import { startFakeGithubApp, type FakeGithubApp } from './testGithubApp.js';

const APP = '5612251';
const INST = '777';
let gh: FakeGithubApp | null = null;
afterEach(async () => {
  await gh?.close();
  gh = null;
});

async function rig(repos = ['fleet-reviews', 'fleet-expertise', 'claude-fleet']) {
  gh = await startFakeGithubApp({ appId: APP, installationId: INST, account: 'SumerSports', repos });
  const keyFile = join(mkdtempSync(join(tmpdir(), 'app-')), 'key.pem');
  writeFileSync(keyFile, gh.privatePem, { mode: 0o400 });
  return { gh, creds: await loadAppCredentials({ appId: APP, installationId: INST, keyFile }) };
}

const posts = (g: FakeGithubApp) => g.requests.filter((r) => r.method === 'POST').length;

describe('createTokenMinter', () => {
  it('signs an RS256 JWT the API accepts: iss = app id, iat −60 s, lifetime under 10 min', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url });
    expect(await m.account()).toBe('SumerSports');
    expect(gh.requests[0].jwt.iss).toBe(APP);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const body = JSON.parse(Buffer.from(appJwt(creds, now).split('.')[1], 'base64url').toString());
    expect(body.iat).toBe(now / 1000 - 60);
    expect(body.exp - body.iat).toBeLessThan(600);
    expect(body.exp).toBeGreaterThan(now / 1000);
  });

  it('scopes each token to exactly the requested repositories', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url });
    const t = await m.mint({ repositories: ['Fleet-Reviews'] });
    expect(t.repositories).toEqual(['fleet-reviews']);
    expect(gh.requests.at(-1)!.body).toEqual({ repositories: ['fleet-reviews'], permissions: DEFAULT_PERMISSIONS });
  });

  it('without config, every token carries the built-in permission set and nothing beyond it', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url });
    expect(DEFAULT_PERMISSIONS).toEqual({
      contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read', actions: 'read', statuses: 'read', metadata: 'read'
    });
    await m.mint({ repositories: ['fleet-reviews'] });
    expect(gh.requests.at(-1)!.body).toEqual({ repositories: ['fleet-reviews'], permissions: DEFAULT_PERMISSIONS });
    await expect(m.mint({ repositories: ['fleet-reviews'], permissions: { administration: 'write' } })).rejects.toMatchObject({ status: 403 });
    await expect(m.mint({ repositories: ['fleet-reviews'], permissions: { checks: 'write' } })).rejects.toMatchObject({ status: 403 });
    expect(posts(gh)).toBe(1);
  });

  it('github.permissions is the default and the ceiling; write implies read', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url, permissions: () => ({ contents: 'write', pull_requests: 'read' }) });
    await m.mint({ repositories: ['fleet-reviews'] });
    expect(gh.requests.at(-1)!.body).toEqual({ repositories: ['fleet-reviews'], permissions: { contents: 'write', pull_requests: 'read' } });
    await m.mint({ repositories: ['fleet-reviews'], permissions: { contents: 'read' } });
    expect(gh.requests.at(-1)!.body).toEqual({ repositories: ['fleet-reviews'], permissions: { contents: 'read' } });
    await expect(m.mint({ repositories: ['fleet-reviews'], permissions: { pull_requests: 'write' } })).rejects.toMatchObject({ status: 403 });
    await expect(m.mint({ repositories: ['fleet-reviews'], permissions: { issues: 'read' } })).rejects.toMatchObject({ status: 403 });
    expect(posts(gh)).toBe(2);
  });

  it('refuses, and does not cache, a token GitHub granted wider permissions than asked', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url });
    gh.grantPermissions = { ...DEFAULT_PERMISSIONS, administration: 'write' };
    await expect(m.mint({ repositories: ['fleet-reviews'] })).rejects.toThrow(/wider permissions/);
    gh.grantPermissions = { contents: 'write' };
    await expect(m.mint({ repositories: ['fleet-reviews'], permissions: { contents: 'read' } })).rejects.toThrow(/wider permissions/);
    gh.grantPermissions = null;
    await m.mint({ repositories: ['fleet-reviews'] });
    expect(posts(gh)).toBe(3);
  });

  it('a missing installation is a 502 naming github.installationId', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds: { ...creds, installationId: '999' }, apiBase: gh.url });
    await expect(m.account()).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/check github.installationId/) });
    await expect(m.mint({ repositories: ['fleet-reviews'] })).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/check github.installationId/) });
  });

  it.each([
    ['retry-after', { 'retry-after': '30' }, 30_000],
    ['x-ratelimit-reset', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'RESET' }, 20_000],
    ['an over-long retry-after (capped at 60 s)', { 'retry-after': '3600' }, 60_000]
  ])('a rate limit (%s) refuses mints for a short window without calling GitHub', async (_l, headers, windowMs) => {
    const { gh, creds } = await rig();
    let now = Date.now();
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v === 'RESET' ? String(Math.ceil((now + windowMs) / 1000)) : v]));
    const m = createTokenMinter({ creds, apiBase: gh.url, now: () => now });
    gh.rateLimitOnce = { status: 'retry-after' in h ? 429 : 403, headers: h };
    await expect(m.mint({ repositories: ['fleet-reviews'] })).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/rate limit/) });
    const before = gh.requests.length;
    now += windowMs - 2_000;
    await expect(m.mint({ repositories: ['claude-fleet'] })).rejects.toMatchObject({ status: 503 });
    expect(gh.requests.length).toBe(before);
    now += 3_000;
    expect((await m.mint({ repositories: ['claude-fleet'] })).repositories).toEqual(['claude-fleet']);
  });

  it('runs at most 4 distinct GitHub mints at once and queues the rest', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url });
    gh.delayMs = 40;
    const sets = [['fleet-reviews'], ['fleet-expertise'], ['claude-fleet'], ['fleet-reviews', 'claude-fleet'], ['fleet-expertise', 'claude-fleet'], ['fleet-reviews', 'fleet-expertise']];
    const toks = await Promise.all(sets.map((repositories) => m.mint({ repositories })));
    expect(new Set(toks.map((t) => t.token)).size).toBe(6);
    expect(gh.maxConcurrent).toBe(4);
  });

  it('refuses a token GitHub scoped wider than asked', async () => {
    const { gh, creds } = await rig();
    gh.widen = true;
    await expect(createTokenMinter({ creds, apiBase: gh.url }).mint({ repositories: ['fleet-reviews'] })).rejects.toThrow(/other repositories/);
  });

  it('caches per scope until 5 min before expiry; concurrent requests share one call', async () => {
    const { gh, creds } = await rig();
    let now = Date.now();
    const m = createTokenMinter({ creds, apiBase: gh.url, now: () => now });
    gh.delayMs = 50;
    const [a, b] = await Promise.all([m.mint({ repositories: ['fleet-reviews'] }), m.mint({ repositories: ['fleet-reviews'] })]);
    expect(a.token).toBe(b.token);
    expect(posts(gh)).toBe(1);
    expect((await m.mint({ repositories: ['claude-fleet'] })).token).not.toBe(a.token);
    expect(posts(gh)).toBe(2);
    now = a.expiresAt - REFRESH_BEFORE_MS - 1;
    expect((await m.mint({ repositories: ['fleet-reviews'] })).token).toBe(a.token);
    now = a.expiresAt - REFRESH_BEFORE_MS + 1;
    expect((await m.mint({ repositories: ['fleet-reviews'] })).token).not.toBe(a.token);
    expect(posts(gh)).toBe(3);
  });

  it('refuses repos outside github.repositories, unscoped requests and another owner, without minting', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url, allow: () => ['fleet-reviews'] });
    await expect(m.mint({ repositories: ['claude-fleet'] })).rejects.toMatchObject({ status: 403 });
    await expect(m.mint({ repositories: [] })).rejects.toMatchObject({ status: 400 });
    await expect(m.mint({ repositories: ['../x'] })).rejects.toMatchObject({ status: 400 });
    await expect(m.mint({ owner: 'someone-else', repositories: ['fleet-reviews'] })).rejects.toMatchObject({ status: 403 });
    expect(posts(gh)).toBe(0);
    expect((await m.mint({ owner: 'sumersports', repositories: ['fleet-reviews'] })).repositories).toEqual(['fleet-reviews']);
  });

  it('a repo the installation cannot reach is a 400 carrying GitHub’s reason', async () => {
    const { gh, creds } = await rig(['fleet-reviews']);
    await expect(createTokenMinter({ creds, apiBase: gh.url }).mint({ repositories: ['secret-repo'] }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not accessible/) });
  });

  it('never puts the key, a JWT or a token in an error', async () => {
    const { gh, creds } = await rig();
    const m = createTokenMinter({ creds, apiBase: gh.url });
    const t = await m.mint({ repositories: ['fleet-reviews'] });
    const errs: string[] = [];
    for (const bad of [{ repositories: ['nope'] }, { repositories: 'x' }]) {
      await m.mint(bad).catch((e: Error) => errs.push(`${e.message} ${e.stack}`));
    }
    await createTokenMinter({ creds, apiBase: 'http://127.0.0.1:1' }).mint({ repositories: ['fleet-reviews'] })
      .catch((e: Error) => errs.push(`${e.message} ${e.stack}`));
    expect(errs).toHaveLength(3);
    const keyLine = gh.privatePem.split('\n')[1];
    for (const e of errs) {
      expect(e).not.toContain(t.token);
      expect(e).not.toContain(keyLine);
      expect(e).not.toMatch(/eyJ/);
    }
  });

  it('a bad or unreadable key fails without echoing the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-'));
    writeFileSync(join(dir, 'k'), '-----BEGIN PRIVATE KEY-----\nnotakey\n-----END PRIVATE KEY-----\n');
    await expect(loadAppCredentials({ appId: APP, installationId: INST, keyFile: join(dir, 'k') }))
      .rejects.toThrow(/^github.keyFile is not a PEM private key$/);
    await expect(loadAppCredentials({ appId: APP, installationId: INST, keyFile: join(dir, 'missing') })).rejects.toThrow(/^cannot read github.keyFile: ENOENT$/);
  });
});
