// The hosted workspace's ULID, minted once (or taken from config) and kept on
// shared storage so every pod reports the same id.
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { ULID_RE } from './config.js';

export const WORKSPACE_ID_FILE = 'workspace-id.json';

async function readId(path: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const id = (JSON.parse(text) as { id?: unknown }).id;
  if (typeof id !== 'string' || !ULID_RE.test(id)) throw new Error(`${path} holds no valid workspace id`);
  return id;
}

export async function loadOrMintWorkspaceId(stateDir: string, mint: () => string = ulid): Promise<string> {
  const path = join(stateDir, WORKSPACE_ID_FILE);
  const existing = await readId(path);
  if (existing) return existing;
  await mkdir(stateDir, { recursive: true });
  const tmp = join(stateDir, `.${WORKSPACE_ID_FILE}.${randomUUID()}`);
  await writeFile(tmp, JSON.stringify({ id: mint(), createdAt: Date.now() }) + '\n', { mode: 0o644 });
  try {
    // link() fails with EEXIST if another pod minted first; its id wins.
    await link(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  const id = await readId(path);
  if (!id) throw new Error(`${path} vanished after mint`);
  return id;
}

/** A configured `workspace.id` is authoritative; a file holding another id is refused, never overwritten. */
export async function resolveWorkspaceId(stateDir: string, configuredId: string | null, mint: () => string = ulid): Promise<string> {
  if (!configuredId) return loadOrMintWorkspaceId(stateDir, mint);
  const id = await loadOrMintWorkspaceId(stateDir, () => configuredId);
  if (id !== configuredId) {
    throw new Error(`${join(stateDir, WORKSPACE_ID_FILE)} holds workspace id ${id} but config workspace.id is ${configuredId}; refusing to start`);
  }
  return id;
}
