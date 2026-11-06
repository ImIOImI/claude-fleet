import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
    await prepareSocketPath(p, null);
    const close = await listen(p);
    await finishSocket(p, null);
    expect(statSync(join(p, '..')).mode & 0o777).toBe(0o700);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    close();
  });
  it('private mode: tightens an existing directory to 0700', async () => {
    const d = join(tmp(), 'run');
    mkdirSync(d, { mode: 0o755 });
    await prepareSocketPath(join(d, 'mcp.sock'), null);
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });
  it('replaces a stale socket and refuses a regular file in its place', async () => {
    const d = tmp();
    const p = join(d, 'mcp.sock');
    const close = await listen(p);
    close();
    await expect(prepareSocketPath(p, null)).resolves.toBeUndefined();
    writeFileSync(p, 'x');
    await expect(prepareSocketPath(p, null)).rejects.toThrow(/exists and is not a socket/);
  });
  it('group mode: needs our own directory in the group, group r-x only, and makes the socket 0660', async () => {
    const gid = process.getgid!();
    const d = join(tmp(), 'mcp');
    mkdirSync(d);
    chmodSync(d, 0o2750);
    const p = join(d, 'mcp.sock');
    await prepareSocketPath(p, gid);
    const close = await listen(p);
    await finishSocket(p, gid);
    const st = statSync(p);
    expect([st.mode & 0o777, st.gid]).toEqual([0o660, gid]);
    close();
    for (const mode of [0o2770, 0o2730, 0o2755, 0o2751, 0o2740, 0o2700]) {
      chmodSync(d, mode);
      await expect(prepareSocketPath(p, gid), mode.toString(8)).rejects.toThrow(/group r-x, no group write and no access for others; run fleet-host-entry prep first/);
    }
    chmodSync(d, 0o750);
    await expect(prepareSocketPath(p, gid)).resolves.toBeUndefined();
    await expect(prepareSocketPath(p, gid + 1)).rejects.toThrow(new RegExp(`must be owned by this user and group ${gid + 1}`));
    const link = join(tmp(), 'link');
    symlinkSync(d, link);
    await expect(prepareSocketPath(join(link, 'mcp.sock'), gid)).rejects.toThrow(/not a directory/);
    await expect(prepareSocketPath(join(tmp(), 'missing', 'mcp.sock'), gid)).rejects.toThrow(/not a directory/);
  });

  const groupDir = (): string => {
    const d = join(tmp(), 'mcp');
    mkdirSync(d);
    chmodSync(d, 0o2750);
    return d;
  };
  it('group mode: replaces a planted regular file or symlink, never touching the target', async () => {
    const gid = process.getgid!();
    const d = groupDir();
    const p = join(d, 'mcp.sock');
    writeFileSync(p, 'planted');
    await prepareSocketPath(p, gid);
    expect(existsSync(p)).toBe(false);
    const target = join(tmp(), 'target');
    writeFileSync(target, 'keep');
    symlinkSync(target, p);
    await prepareSocketPath(p, gid);
    expect(existsSync(p)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });
  it('private mode: refuses a symlink at the socket path', async () => {
    const d = tmp();
    const p = join(d, 'mcp.sock');
    symlinkSync(join(d, 'elsewhere'), p);
    await expect(prepareSocketPath(p, null)).rejects.toThrow(/exists and is not a socket/);
  });
  it('finishSocket refuses anything but a socket this process owns', async () => {
    const d = tmp();
    const file = join(d, 'file');
    writeFileSync(file, 'x');
    await expect(finishSocket(file, null)).rejects.toThrow(/not a socket owned by/);
    const sock = join(d, 'real.sock');
    const close = await listen(sock);
    chmodSync(sock, 0o640);
    const link = join(d, 'link.sock');
    symlinkSync(sock, link);
    await expect(finishSocket(link, null)).rejects.toThrow(/not a socket owned by/);
    expect(statSync(sock).mode & 0o777).toBe(0o640);
    close();
  });
});
