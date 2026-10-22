// Atomic file replace: write a uniquely named temp file beside the target, then
// rename it over the target, so a concurrent reader sees the old file or the new
// one, never an empty or half-written one. The temp name is unique per write
// (two overlapping writers must not share one), and the rename is retried
// briefly because on Windows it fails with EPERM/EBUSY/EACCES while another
// process (a reader, an indexer, antivirus) has the target open.

import { randomBytes } from 'node:crypto';
import { rename as fsRename, rm, writeFile } from 'node:fs/promises';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface AtomicWriteDeps {
  rename: (from: string, to: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: AtomicWriteDeps = {
  rename: fsRename,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};

export async function writeFileAtomic(path: string, data: string, deps: AtomicWriteDeps = defaultDeps): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, 'utf8');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.rename(tmp, path);
        return;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code ?? '';
        if (!RETRY_CODES.has(code) || attempt >= 5) throw err;
        await deps.sleep(20 * (attempt + 1));
      }
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
