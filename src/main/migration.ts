// One-shot startup migration to the ULID-keyed workspace model.
//
// The spec calls this "clean slate" — we don't promise observability or
// vault history survives the cut. Two responsibilities:
//
//   1. Legacy state dirs (keyed by workspace *name*, with a manifest that
//      lacks the new `id` / `authMode` / `env` / `labels` fields) get a
//      fresh ULID, the dir is renamed in place, and the manifest is
//      rewritten with sensible defaults so the renderer's new APIs can
//      consume it without a separate compat path.
//
//   2. Every keytar entry under `service=claude-fleet` whose account
//      doesn't fit the new `<workspaceId>:<key>` or `__secrets__:<id>`
//      shape is removed. In practice this means the old `__profiles__:*`
//      entries get purged. Users re-enter env-var secrets via the
//      modal's env editor on next launch.
//
// Idempotent: running this twice is a no-op once the state dir is
// already keyed by id and the keytar entries already conform.

import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { stateRoot, workspaceManifestPath } from './paths.js';
import type { WorkspaceSpec } from './workspaces.js';

const SERVICE = 'claude-fleet';
const SECRET_INDEX_PREFIX = '__secrets__:';

/**
 * Run both halves of the clean-slate migration. Best-effort: errors are
 * logged and swallowed so a broken state dir doesn't keep the app from
 * starting. The startup IPC path tolerates a partly-migrated layout.
 */
export async function runStartupMigration(): Promise<void> {
  try {
    await migrateStateDirs();
  } catch (err) {
    console.warn('[migration] state-dir migration failed:', err);
  }
  try {
    await purgeLegacyKeytarEntries();
  } catch (err) {
    console.warn('[migration] keytar purge failed:', err);
  }
}

interface LegacyManifest {
  // Old-shape fields we care about.
  name?: string;
  workspaceRoot?: string;
  workspaceSubdir?: string;
  profile?: string;
  kind?: 'container' | 'local';
  image?: string;
  createdAt?: number;
  lastUsedAt?: number;
  // New-shape; presence means already migrated.
  id?: string;
  authMode?: string;
  labels?: unknown;
  env?: unknown;
}

async function migrateStateDirs(): Promise<void> {
  const root = stateRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return;
    throw err;
  }

  for (const dirName of entries) {
    const manifestPath = join(root, dirName, 'workspace.json');
    let parsed: LegacyManifest;
    try {
      const raw = await readFile(manifestPath, 'utf8');
      parsed = JSON.parse(raw) as LegacyManifest;
    } catch {
      // No manifest or unreadable — leave it alone. The new
      // readWorkspaceManifest will report null and the dir is invisible
      // to the listing.
      continue;
    }

    // Already migrated: has id, has env shape we recognize.
    if (typeof parsed.id === 'string' && parsed.id === dirName && parsed.env) {
      continue;
    }

    const id = ulid();
    const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : dirName;
    const upgraded: WorkspaceSpec = {
      id,
      name,
      description: undefined,
      labels: [],
      color: undefined,
      workspaceRoot: typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : '',
      workspaceSubdir: typeof parsed.workspaceSubdir === 'string' ? parsed.workspaceSubdir : '',
      kind: parsed.kind === 'local' ? 'local' : 'container',
      image: typeof parsed.image === 'string' ? parsed.image : undefined,
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      resources: undefined,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      lastUsedAt: typeof parsed.lastUsedAt === 'number' ? parsed.lastUsedAt : Date.now()
    };

    const newDir = join(root, id);
    try {
      if (dirName !== id) {
        await rename(join(root, dirName), newDir);
      }
      await writeFile(
        workspaceManifestPath(id),
        JSON.stringify(upgraded, null, 2) + '\n',
        'utf8'
      );
      console.log(`[migration] state dir "${dirName}" → "${id}" (name "${name}")`);
    } catch (err) {
      console.warn(`[migration] failed to migrate state dir "${dirName}":`, err);
    }
  }
}

async function purgeLegacyKeytarEntries(): Promise<void> {
  // Same lazy keytar-loader pattern as vault.ts — keytar links libsecret
  // at module load so we tolerate its absence.
  let keytar: typeof import('keytar');
  try {
    const mod = await import('keytar');
    keytar = (mod.default ?? mod) as typeof import('keytar');
  } catch {
    return;
  }

  let creds: Array<{ account: string; password: string }>;
  try {
    creds = await keytar.findCredentials(SERVICE);
  } catch {
    return;
  }

  // Legal account shapes:
  //   - "__secrets__:<id>"       (per-workspace index of secret keys)
  //   - "<id>:<key>"             (a single secret value)
  // Anything else (notably "__profiles__:*") is legacy and gets dropped.
  const ulidLike = /^[0-9A-HJKMNP-TV-Z]{26}$/i; // Crockford base32, 26 chars
  for (const { account } of creds) {
    let keep = false;
    if (account.startsWith(SECRET_INDEX_PREFIX)) {
      keep = ulidLike.test(account.slice(SECRET_INDEX_PREFIX.length));
    } else {
      const idx = account.indexOf(':');
      if (idx > 0) {
        const id = account.slice(0, idx);
        keep = ulidLike.test(id);
      }
    }
    if (keep) continue;
    try {
      await keytar.deletePassword(SERVICE, account);
      console.log(`[migration] purged legacy keytar entry "${account}"`);
    } catch (err) {
      console.warn(`[migration] failed to purge keytar entry "${account}":`, err);
    }
  }
}
