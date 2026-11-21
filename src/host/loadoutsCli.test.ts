import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadoutsCli, runScript } from './loadoutsCli.js';
import { createLogger } from './log.js';
import { loadoutFiles, sha, startFakeGithubRepo, type FakeGithubRepo } from './testGithubRepo.js';

let gh: FakeGithubRepo;
let target: string;
let cred: Server;
let credPort: number;
let bodies: unknown[];

beforeEach(async () => {
  gh = await startFakeGithubRepo({ owner: 'SumerSports', repo: 'claude-fleet-loadouts' });
  target = await mkdtemp(join(tmpdir(), 'lcli-'));
  bodies = [];
  cred = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: gh.token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    });
  });
  await new Promise<void>((r) => cred.listen(0, '127.0.0.1', () => r()));
  credPort = (cred.address() as AddressInfo).port;
});
afterEach(async () => {
  await gh.close();
  await new Promise<void>((r) => cred.close(() => r()));
  await rm(target, { recursive: true, force: true });
});

describe('loadoutsCli', () => {
  it('syncs with a contents:read token from the credential server', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    const out: string[] = [];
    const env = { FLEET_LOADOUTS: 'demo@1.0.0', FLEET_LOADOUTS_API: gh.url, FLEET_HOST_CRED_ADDR: `127.0.0.1:${credPort}` };
    expect(await loadoutsCli(['sync'], env, target, createLogger((l) => out.push(l)))).toBe(0);
    expect(bodies).toEqual([{ owner: 'SumerSports', repositories: ['claude-fleet-loadouts'], permissions: { contents: 'read' } }]);
    expect(await readFile(join(target, '.claude/skills/demo/SKILL.md'), 'utf8')).toContain('demo 1.0.0');
    expect(out.join('\n')).not.toContain(gh.token);
    expect(out.join('\n')).toContain('"msg":"loadout sync done"');
  });

  it("never puts the token in a loadout script's environment", async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    gh.tags.get('demo/v1.0.0')!.files['loadouts/demo/loadout.md'] =
      '---\ntitle: demo\ndescription: d\nversion: 1.0.0\nscripts:\n  - label: dump\n    run: cat /proc/self/environ > .script-env\n---\n';
    const env = { ...process.env, FLEET_LOADOUTS: 'demo@1.0.0', FLEET_LOADOUTS_API: gh.url, FLEET_HOST_CRED_ADDR: `127.0.0.1:${credPort}` };
    expect(await loadoutsCli(['sync'], env, target, createLogger(() => undefined))).toBe(0);
    expect(bodies).toHaveLength(1);
    const dump = await readFile(join(target, '.script-env'), 'utf8');
    // Booleans, so a failure never prints the environment.
    expect(dump.includes('FLEET_LOADOUTS=demo@1.0.0')).toBe(true);
    expect(dump.includes(gh.token)).toBe(false);
    expect(Object.values(process.env).includes(gh.token)).toBe(false);
  });

  it('logs a bad credential address as a token failure and exits 0', async () => {
    gh.tags.set('demo/v1.0.0', { commit: sha(1), files: loadoutFiles('demo', '1.0.0') });
    const out: string[] = [];
    const env = { FLEET_LOADOUTS: 'demo@1.0.0', FLEET_LOADOUTS_API: gh.url, FLEET_HOST_CRED_ADDR: 'not-an-address' };
    expect(await loadoutsCli(['sync'], env, target, createLogger((l) => out.push(l)))).toBe(0);
    expect(out.join('\n')).toContain('"stage":"token"');
  });

  it('ignores a bad timeout with a warning', async () => {
    const out: string[] = [];
    expect(await loadoutsCli(['sync'], { FLEET_LOADOUTS_TIMEOUT_S: '0' }, target, createLogger((l) => out.push(l)))).toBe(0);
    expect(out.join('\n')).toContain('"msg":"loadout sync timeout ignored"');
  });

  it('exits 2 on usage errors', async () => {
    const quiet = createLogger(() => undefined);
    expect(await loadoutsCli([], {}, target, quiet)).toBe(2);
    expect(await loadoutsCli(['sync', 'extra'], {}, target, quiet)).toBe(2);
    expect(await loadoutsCli(['bogus'], {}, target, quiet)).toBe(2);
  });
});

describe('runScript', () => {
  it('runs sh -lc in the target and reports the exit code and output', async () => {
    const r = await runScript('pwd -P; exit 3', target, 5_000);
    expect(r.exitCode).toBe(3);
    expect(r.output.trim()).toBe(await realpath(target));
  });

  it('kills a script that outlives its time', async () => {
    const t0 = Date.now();
    const r = await runScript('sleep 5', target, 200);
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});
