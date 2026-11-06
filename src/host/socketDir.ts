// Socket files the holder serves to sessions: a private directory when sessions
// share fleet-host's uid, else the split's prepped group directory (SPEC §9).
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function prepareSocketPath(path: string, group: number | null): Promise<void> {
  const dir = dirname(path);
  if (group === null) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  } else {
    const st = await lstat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`${dir} is not a directory; run fleet-host-entry prep first`);
    if (st.gid !== group || (st.mode & 0o070) !== 0o070 || (st.mode & 0o007) !== 0) {
      throw new Error(`${dir} must be group ${group} with group rwx and no access for others; run fleet-host-entry prep first`);
    }
  }
  const st = await lstat(path).catch(() => null);
  if (st) {
    if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
    await unlink(path);
  }
}

export async function finishSocket(path: string, group: number | null): Promise<void> {
  if (group === null) return chmod(path, 0o600);
  await chown(path, -1, group);
  await chmod(path, 0o660);
}
