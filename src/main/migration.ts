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

import { lstat, mkdir, readdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { sharedClaudeCredentialsPath, stateRoot, workspaceClaudeDir, workspaceManifestPath } from './paths.js';
import { fleetPrivateDir, fleetSharedDir } from './config.js';
import { listWorkspaceManifests, writeWorkspaceManifest, FACTORY_MIRROR } from './workspaces.js';
import type { WorkspaceSpec } from './workspaces.js';

const SERVICE = 'claude-fleet';
const SECRET_INDEX_PREFIX = '__secrets__:';

/**
 * Run every startup migration step. Best-effort: errors are logged and
 * swallowed so a broken state dir doesn't keep the app from starting.
 * Order matters — state-dir renames must finish before credentials
 * migration walks state dirs by id.
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
  try {
    await migrateOAuthCredentials();
  } catch (err) {
    console.warn('[migration] credentials migration failed:', err);
  }
  try {
    await migrateFleetFolders();
  } catch (err) {
    console.warn('[migration] fleet-folder migration failed:', err);
  }
}

/**
 * Fleet-folder model: each workspace's private dir is now `<fleetRoot>/<id>`
 * and a single `<fleetRoot>/shared` is mounted into every container. For each
 * existing workspace, create its private folder (and the shared folder) so the
 * "Path"/"Shared" links work before the container is next recreated, and
 * rewrite the manifest's `workspaceRoot` to the canonical private dir (older
 * manifests stored a user-picked host path). Idempotent.
 */
async function migrateFleetFolders(): Promise<void> {
  await mkdir(await fleetSharedDir(), { recursive: true });
  const manifests = await listWorkspaceManifests();
  for (const m of manifests) {
    const privateDir = await fleetPrivateDir(m.id);
    await mkdir(privateDir, { recursive: true });
    if (m.workspaceRoot !== privateDir) {
      await writeWorkspaceManifest({ ...m, workspaceRoot: privateDir });
    }
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
      mirror: FACTORY_MIRROR,
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

/**
 * Move every workspace's per-workspace `.claude/.credentials.json` to
 * a single shared location and replace the per-workspace files with
 * symlinks to it. Idempotent.
 *
 * The shared file backs Phase 3 of the workspace-modal redesign
 * (issue #57): one Claude.ai login covers every OAuth workspace. The
 * actual bind-mount lives in `docker.ts createWorkspace`; this
 * migration just consolidates pre-existing per-workspace files so the
 * shared file picks up real credentials on first run rather than
 * staying empty until the user logs in again.
 *
 * Rules:
 *   - "Real file" = exists, is a regular file, is non-empty. Empty
 *     files (from a stale touch) and symlinks are treated as
 *     already-migrated.
 *   - If the shared file isn't real yet and at least one workspace has
 *     a real credentials file, promote the most-recently-modified one
 *     to the shared path.
 *   - For every other workspace that still has a real credentials
 *     file: back it up as `.credentials.json.old` and replace the
 *     original with a symlink to the shared path.
 *   - For the workspace whose file became the shared one: also create
 *     the symlink so the per-workspace path keeps resolving to real
 *     credentials.
 */
async function migrateOAuthCredentials(): Promise<void> {
  const root = stateRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return;
    throw err;
  }

  // Probe each workspace's credentials.json — collect the ones that
  // are real, non-empty files (not symlinks, not directories).
  interface RealCredsFile {
    id: string;
    path: string;
    mtimeMs: number;
  }
  const realFiles: RealCredsFile[] = [];
  for (const id of entries) {
    let credsPath: string;
    try {
      credsPath = join(workspaceClaudeDir(id), '.credentials.json');
    } catch {
      // Invalid id (path-safety check) — skip.
      continue;
    }
    try {
      const lst = await lstat(credsPath);
      if (lst.isSymbolicLink()) continue;
      if (!lst.isFile()) continue;
      if (lst.size === 0) continue;
      realFiles.push({ id, path: credsPath, mtimeMs: lst.mtimeMs });
    } catch {
      // No file — fine, nothing to migrate for this workspace.
      continue;
    }
  }

  const sharedPath = sharedClaudeCredentialsPath();
  await mkdir(dirname(sharedPath), { recursive: true });

  // "Real" shared file = exists, regular file, non-empty.
  let sharedIsReal = false;
  try {
    const lst = await lstat(sharedPath);
    sharedIsReal = lst.isFile() && lst.size > 0;
  } catch {
    sharedIsReal = false;
  }

  // Promote: if the shared file isn't real yet but at least one
  // workspace has credentials, move the most-recently-modified one
  // into the shared path.
  if (!sharedIsReal && realFiles.length > 0) {
    realFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const winner = realFiles[0];
    // Drop the existing shared file (likely empty stub from a prior
    // run that called ensureSharedCredentialsFile but never logged in).
    try {
      await unlink(sharedPath);
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }
    await rename(winner.path, sharedPath);
    console.log(
      `[migration] promoted ${winner.id}'s credentials to shared (mtime ${new Date(winner.mtimeMs).toISOString()})`
    );
    sharedIsReal = true;
    // Symlink the winner's path back to shared so the workspace's
    // .claude/.credentials.json keeps resolving.
    await symlink(sharedPath, winner.path);
  }

  // Back up + symlink everyone else.
  for (const { id, path: credsPath } of realFiles) {
    // Use lstat so a symlink (from the promotion step above, or a
    // previous run's migration) is recognized — stat would follow it
    // and we'd treat the symlink itself as a "real file" worth
    // backing up.
    const lst = await lstat(credsPath).catch(() => null);
    if (!lst || !lst.isFile()) continue;
    const backupPath = credsPath + '.old';
    try {
      await rename(credsPath, backupPath);
    } catch (err) {
      console.warn(`[migration] failed to back up ${id}'s credentials:`, err);
      continue;
    }
    try {
      await symlink(sharedPath, credsPath);
      console.log(`[migration] backed up ${id}'s credentials → .old + symlinked to shared`);
    } catch (err) {
      console.warn(`[migration] failed to symlink ${id}'s credentials:`, err);
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
