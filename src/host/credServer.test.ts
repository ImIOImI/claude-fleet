import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenMinter, DEFAULT_PERMISSIONS, loadAppCredentials } from './appToken.js';
import { CRED_CLOSE_GRACE_MS, listenCredSocket, startCredHelper, type CredServer } from './credServer.js';
import { requestToken } from './credCli.js';
import { createLogger } from './log.js';
import { startFakeGithubApp, type FakeGithubApp } from './testGithubApp.js';

let gh: FakeGithubApp | null = null;
let srv: CredServer | null = null;
afterEach(async () => {
  await srv?.close();
  await gh?.close();
  srv = null;
  gh = null;
});

async function rig(allow: string[] | null = null) {
  gh = await startFakeGithubApp({ appId: '1', installationId: '2', account: 'acme', repos: ['a', 'b'] });
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  const keyFile = join(dir, 'key.pem');
  writeFileSync(keyFile, gh.privatePem, { mode: 0o400 });
  const logs: string[] = [];
  const sock = join(dir, 'run', 'cred.sock');
  srv = await startCredHelper({
    app: { appId: '1', installationId: '2', keyFile },
    socketPath: sock,
    github: () => (allow ? { app: null, repositories: allow, permissions: null } : null),
    log: createLogger((l) => logs.push(l)),
    apiBase: gh.url
  });
  return { gh, sock, dir, logs };
}

describe('credential socket', () => {
  it('is 0600 in a 0700 directory and answers a scoped token', async () => {
    const { sock, gh } = await rig();
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(join(sock, '..')).mode & 0o777).toBe(0o700);
    const token = await requestToken(sock, { owner: 'acme', repositories: ['a'] });
    expect(token).toMatch(/^ghs_fake/);
    expect(gh.requests.at(-1)!.body).toEqual({ repositories: ['a'], permissions: DEFAULT_PERMISSIONS });
  });

  it('relays refusals with their status, and never logs a token or the key', async () => {
    const { sock, gh, logs } = await rig(['a']);
    const token = await requestToken(sock, { repositories: ['a'] });
    await expect(requestToken(sock, { repositories: ['b'] })).rejects.toThrow(/403.*not in github.repositories/);
    await expect(requestToken(sock, { repositories: [] })).rejects.toThrow(/400/);
    const all = logs.join('\n');
    expect(all).toContain('app token issued');
    expect(all).not.toContain(token);
    expect(all).not.toContain(gh.privatePem.split('\n')[1]);
  });

  it('close() is bounded by a hung, half-sent request', async () => {
    const { sock } = await rig();
    const c = connect(sock);
    await new Promise<void>((r) => c.once('connect', () => r()));
    c.on('error', () => undefined);
    c.write('POST /token HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"repo');
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await srv!.close();
    srv = null;
    expect(Date.now() - t0).toBeLessThan(CRED_CLOSE_GRACE_MS + 1_000);
    c.destroy();
  });

  it('replaces a stale socket but refuses to unlink a regular file', async () => {
    const { sock } = await rig();
    await srv!.close();
    srv = null;
    const minter = createTokenMinter({ creds: await loadAppCredentials({ appId: '1', installationId: '2', keyFile: join(sock, '..', '..', 'key.pem') }), apiBase: gh!.url });
    srv = await listenCredSocket(sock, minter, createLogger(() => undefined));
    expect(await requestToken(sock, { repositories: ['a'] })).toMatch(/^ghs_/);
    const file = join(sock, '..', 'not-a-socket');
    writeFileSync(file, 'x');
    await expect(listenCredSocket(file, minter, createLogger(() => undefined))).rejects.toThrow(/not a socket/);
  });

  it('tightens a pre-existing socket directory to 0700', async () => {
    const { sock } = await rig();
    await srv!.close();
    srv = null;
    const dir = join(sock, '..', '..', 'loose');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const minter = createTokenMinter({ creds: await loadAppCredentials({ appId: '1', installationId: '2', keyFile: join(sock, '..', '..', 'key.pem') }), apiBase: gh!.url });
    srv = await listenCredSocket(join(dir, 'cred.sock'), minter, createLogger(() => undefined));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('answers an oversize body with 413', async () => {
    const { sock } = await rig();
    await expect(requestToken(sock, { repositories: ['a'], pad: 'x'.repeat(9000) })).rejects.toThrow(/413/);
  });
});
