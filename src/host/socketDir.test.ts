import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishSocket, prepareSocketPath } from './socketDir.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sd-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const listen = (p: string) => new Promise<() => void>((r) => { const s = createServer().listen(p, () => r(() => s.close())); });

describe('prepareSocketPath / finishSocket', () => {
  it('private mode: makes the directory 0700 and the socket 0600', async () => {
    const p = join(tmp(), 'run', 'mcp.sock');
    await prepareSocketPath(p);
    const close = await listen(p);
    await finishSocket(p);
    expect(statSync(join(p, '..')).mode & 0o777).toBe(0o700);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    close();
  });
  it('private mode: tightens an existing directory to 0700', async () => {
    const d = join(tmp(), 'run');
    mkdirSync(d, { mode: 0o755 });
    await prepareSocketPath(join(d, 'mcp.sock'));
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });
  it('replaces a stale socket and refuses a regular file in its place', async () => {
    const d = tmp();
    const p = join(d, 'mcp.sock');
    const close = await listen(p);
    close();
    await expect(prepareSocketPath(p)).resolves.toBeUndefined();
    writeFileSync(p, 'x');
    await expect(prepareSocketPath(p)).rejects.toThrow(/exists and is not a socket/);
  });
  it('private mode: refuses a symlink at the socket path', async () => {
    const d = tmp();
    const p = join(d, 'mcp.sock');
    symlinkSync(join(d, 'elsewhere'), p);
    await expect(prepareSocketPath(p)).rejects.toThrow(/exists and is not a socket/);
  });
  it('finishSocket refuses anything but a socket this process owns', async () => {
    const d = tmp();
    const file = join(d, 'file');
    writeFileSync(file, 'x');
    await expect(finishSocket(file)).rejects.toThrow(/not a socket owned by/);
    const sock = join(d, 'real.sock');
    const close = await listen(sock);
    chmodSync(sock, 0o640);
    const link = join(d, 'link.sock');
    symlinkSync(sock, link);
    await expect(finishSocket(link)).rejects.toThrow(/not a socket owned by/);
    expect(statSync(sock).mode & 0o777).toBe(0o640);
    close();
  });
});
