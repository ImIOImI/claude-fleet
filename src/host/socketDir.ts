// Socket files the holder serves to sessions: a private directory when sessions
// share fleet-host's uid, else a directory prep made for fleet-host alone to
// write, which the session group may only traverse (SPEC §9).
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const PREP = 'run fleet-host-entry prep first';

export async function prepareSocketPath(path: string, group: number | null): Promise<void> {
  const dir = dirname(path);
  if (group === null) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const st = await lstat(path).catch(() => null);
    if (st) {
      if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
      await unlink(path);
    }
    return;
  }
  const st = await lstat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`${dir} is not a directory; ${PREP}`);
  if (st.uid !== process.getuid!() || st.gid !== group) throw new Error(`${dir} must be owned by this user and group ${group}; ${PREP}`);
  // Group r-x only: sessions can connect but can't create anything beside the socket.
  if ((st.mode & 0o077) !== 0o050) throw new Error(`${dir} must be group r-x, no group write and no access for others; ${PREP}`);
  await unlink(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}

export async function finishSocket(path: string, group: number | null): Promise<void> {
  await assertOwnSocket(path);
  if (group === null) await chmod(path, 0o600);
  else {
    await chown(path, -1, group);
    await chmod(path, 0o660);
  }
  await assertOwnSocket(path);
}

async function assertOwnSocket(path: string): Promise<void> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isSocket() || st.uid !== process.getuid!()) throw new Error(`${path} is not a socket owned by this process's user`);
}
