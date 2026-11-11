import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestToken } from './credCli.js';
import { serveCred } from './credServe.js';
import { createLogger } from './log.js';
import { startFakeGithubApp, type FakeGithubApp } from './testGithubApp.js';

let gh: FakeGithubApp | null = null;
let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  await gh?.close();
  stop = null;
  gh = null;
});

describe('fleet-host-cred serve', () => {
  it('reloads github.repositories on SIGHUP and refuses to start without the App keys', async () => {
    gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos: ['a', 'b'] });
    const dir = mkdtempSync(join(tmpdir(), 'serve-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const cfg = join(dir, 'config.yaml');
    const app = `appId: 1, installationId: 2, keyFile: ${join(dir, 'key.pem')}`;
    writeFileSync(cfg, `workspace: { name: w }\ngithub: { ${app}, repositories: [a] }\n`);
    const sock = join(dir, 'run', 'cred.sock');
    const proc = new EventEmitter();
    const logs: string[] = [];
    const env = { FLEET_HOST_CONFIG: cfg, FLEET_HOST_CRED_SOCKET: sock };
    stop = (await serveCred({ env, log: createLogger((l) => logs.push(l)), proc, apiBase: gh.url })).close;
    await expect(requestToken(sock, { repositories: ['b'] })).rejects.toThrow(/403/);
    writeFileSync(cfg, `workspace: { name: w }\ngithub: { ${app}, repositories: [a, b] }\n`);
    proc.emit('SIGHUP');
    await expect.poll(() => logs.filter((l) => l.includes('config reloaded')).length).toBe(2);
    expect(await requestToken(sock, { repositories: ['b'] })).toMatch(/^ghs_fake/);

    writeFileSync(join(dir, 'bare.yaml'), 'workspace: { name: w }\n');
    await expect(serveCred({ env: { FLEET_HOST_CONFIG: join(dir, 'bare.yaml'), FLEET_HOST_CRED_SOCKET: join(dir, 'x.sock') }, log: createLogger(() => undefined), proc })).rejects.toThrow(/github.appId/);
  });

  it('stays on the socket when FLEET_HOST_CRED_TCP_PORT is set', async () => {
    gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos: ['a'] });
    const dir = mkdtempSync(join(tmpdir(), 'serve-tcp-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const cfg = join(dir, 'config.yaml');
    writeFileSync(cfg, `workspace: { name: w }\ngithub: { appId: 1, installationId: 2, keyFile: ${join(dir, 'key.pem')} }\n`);
    const sock = join(dir, 'run', 'cred.sock');
    const server = await serveCred({ env: { FLEET_HOST_CONFIG: cfg, FLEET_HOST_CRED_SOCKET: sock, FLEET_HOST_CRED_TCP_PORT: '1' }, log: createLogger(() => undefined), proc: new EventEmitter(), apiBase: gh.url });
    stop = server.close;
    expect(server.port).toBeNull();
    expect(await requestToken(sock, { repositories: ['a'] })).toMatch(/^ghs_fake/);
  });
});
