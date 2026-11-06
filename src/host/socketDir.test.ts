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
  it('group mode: needs a real directory in the group with no access for others, and makes the socket 0660', async () => {
    const gid = process.getgid!();
    const d = join(tmp(), 'run');
    mkdirSync(d);
    chmodSync(d, 0o770);
    const p = join(d, 'mcp.sock');
    await prepareSocketPath(p, gid);
    const close = await listen(p);
    await finishSocket(p, gid);
    const st = statSync(p);
    expect([st.mode & 0o777, st.gid]).toEqual([0o660, gid]);
    close();
    chmodSync(d, 0o777);
    await expect(prepareSocketPath(p, gid)).rejects.toThrow(/fleet-host-entry prep/);
    chmodSync(d, 0o750);
    await expect(prepareSocketPath(p, gid)).rejects.toThrow(/group rwx/);
    chmodSync(d, 0o770);
    await expect(prepareSocketPath(p, gid + 1)).rejects.toThrow(new RegExp(`must be group ${gid + 1}`));
    const link = join(tmp(), 'link');
    symlinkSync(d, link);
    await expect(prepareSocketPath(join(link, 'mcp.sock'), gid)).rejects.toThrow(/not a directory/);
    await expect(prepareSocketPath(join(tmp(), 'missing', 'mcp.sock'), gid)).rejects.toThrow(/not a directory/);
  });
});
