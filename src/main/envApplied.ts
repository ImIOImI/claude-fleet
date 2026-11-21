// Tracks whether a workspace's container/process env matches the vault's
// current resolution for it, without persisting the values themselves —
// only a hash, written beside the workspace's state (<stateDir>/<id>/env-applied.json).

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';
import { workspaceStateDir } from './paths.js';
import { envHash } from './vaultModel.js';

function filePath(workspaceId: string): string {
  return join(workspaceStateDir(workspaceId), 'env-applied.json');
}

export async function recordEnvApplied(workspaceId: string, env: Record<string, string>): Promise<void> {
  await mkdir(workspaceStateDir(workspaceId), { recursive: true });
  await writeFileAtomic(filePath(workspaceId), JSON.stringify({ hash: envHash(env), at: Date.now() }));
}

export async function readEnvApplied(workspaceId: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath(workspaceId), 'utf8');
    const parsed = JSON.parse(raw) as { hash?: unknown };
    return typeof parsed.hash === 'string' ? parsed.hash : null;
  } catch {
    return null;
  }
}

/** True when the env last applied differs from the vault's current resolution.
 *  A local workspace's env only applies to a running process, so a stopped
 *  one is never pending; a container keeps its env until recreated. */
export async function isEnvPending(
  ws: string,
  d: {
    kind: (ws: string) => Promise<'container' | 'local' | 'remote' | null>;
    localLive: (ws: string) => Promise<boolean>;
    applied: (ws: string) => Promise<string | null>;
    current: (ws: string) => Promise<Record<string, string>>;
  }
): Promise<boolean> {
  const h = await d.applied(ws);
  if (h === null) return false;
  if ((await d.kind(ws)) === 'local' && !(await d.localLive(ws))) return false;
  return h !== envHash(await d.current(ws));
}
