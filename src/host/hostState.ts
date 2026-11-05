// The hosted workspace's ULID, minted once (or taken from config) and kept on
// shared storage so every pod reports the same id.
import { link, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import type { Kysely } from 'kysely';
import { ULID_RE } from './config.js';
import type { HostDb } from './hostSchema.js';
import type { Logger } from './log.js';

export const WORKSPACE_ID_FILE = 'workspace-id.json';
const TMP_PREFIX = `.${WORKSPACE_ID_FILE}.`;
// Older than any in-flight mint on another pod.
const STALE_TMP_MS = 10 * 60_000;

async function readId(path: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const id = parsed && typeof parsed === 'object' ? (parsed as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || !ULID_RE.test(id)) throw new Error(`${path} holds no valid workspace id`);
  return id;
}

async function sweepStaleTmp(stateDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TMP_MS;
  for (const n of names) {
    if (!n.startsWith(TMP_PREFIX)) continue;
    const p = join(stateDir, n);
    const st = await stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) await unlink(p).catch(() => undefined);
  }
}

async function writeDurably(path: string, text: string): Promise<void> {
  const fh = await open(path, 'wx', 0o644);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function loadOrMintWorkspaceId(stateDir: string, mint: () => string = ulid): Promise<string> {
  const path = join(stateDir, WORKSPACE_ID_FILE);
  await sweepStaleTmp(stateDir);
  const existing = await readId(path);
  if (existing) return existing;
  await mkdir(stateDir, { recursive: true });
  const tmp = join(stateDir, `${TMP_PREFIX}${randomUUID()}`);
  await writeDurably(tmp, JSON.stringify({ id: mint(), createdAt: Date.now() }) + '\n');
  try {
    // link() fails with EEXIST if another pod minted first; its id wins.
    await link(tmp, path);
    await syncDir(stateDir);
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

export function readWorkspaceIdFile(stateDir: string): Promise<string | null> {
  return readId(join(stateDir, WORKSPACE_ID_FILE));
}

/** Replaces the file atomically (temp file, fsync, rename). */
export async function writeWorkspaceIdFile(stateDir: string, id: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const tmp = join(stateDir, `${TMP_PREFIX}${randomUUID()}`);
  await writeDurably(tmp, JSON.stringify({ id, createdAt: Date.now() }) + '\n');
  try {
    await rename(tmp, join(stateDir, WORKSPACE_ID_FILE));
    await syncDir(stateDir);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * With a host DB, host_meta is authoritative. An empty table is seeded from
 * config workspace.id, else the c1 file, else a new ULID, under c1's rules
 * (a config/file mismatch or an unreadable file refuses start). The file is
 * then rewritten from the row.
 */
export async function resolveHostWorkspaceId(
  k: Kysely<HostDb>,
  stateDir: string,
  configuredId: string | null,
  log: Logger,
  mint: () => string = ulid
): Promise<string> {
  const read = async () => (await k.selectFrom('host_meta').select('workspace_id').executeTakeFirst())?.workspace_id ?? null;
  let id = await read();
  if (!id) {
    const fromFile = await readWorkspaceIdFile(stateDir);
    if (configuredId && fromFile && fromFile !== configuredId) {
      throw new Error(`${join(stateDir, WORKSPACE_ID_FILE)} holds workspace id ${fromFile} but config workspace.id is ${configuredId}; refusing to start`);
    }
    await k
      .insertInto('host_meta')
      .values({ singleton: true, workspace_id: configuredId ?? fromFile ?? mint(), created_at: Date.now() })
      .onConflict((oc) => oc.column('singleton').doNothing())
      .execute();
    id = await read();
    if (!id) throw new Error('host_meta is empty after seeding');
    log.log('info', 'workspace id seeded', { workspaceId: id, from: configuredId ? 'config' : fromFile ? 'file' : 'minted' });
  }
  if (configuredId && id !== configuredId) {
    throw new Error(`host_meta holds workspace id ${id} but config workspace.id is ${configuredId}; refusing to start`);
  }
  const file = await readWorkspaceIdFile(stateDir).catch(() => undefined);
  if (file !== id) {
    if (file !== null) log.log('warn', 'workspace-id.json differs from host_meta; rewriting it', { file: file ?? 'unreadable', workspaceId: id });
    await writeWorkspaceIdFile(stateDir, id);
  }
  return id;
}
