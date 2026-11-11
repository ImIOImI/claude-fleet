// The holder's private MCP socket (single-container mode): sessions share
// fleet-host's uid there, so the 0700 directory is the only gate (SPEC §9).
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function prepareSocketPath(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const st = await lstat(path).catch(() => null);
  if (st) {
    if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
    await unlink(path);
  }
}

export async function finishSocket(path: string): Promise<void> {
  await assertOwnSocket(path);
  await chmod(path, 0o600);
  await assertOwnSocket(path);
}

async function assertOwnSocket(path: string): Promise<void> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isSocket() || st.uid !== process.getuid!()) throw new Error(`${path} is not a socket owned by this process's user`);
}
