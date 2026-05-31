// Per-workspace secret storage backed by the OS keychain via keytar.
//
// Each workspace owns its own bag of secret env-var values. Accounts are
// keyed `<workspace-id>:<key>` (e.g. `01ARZ3NDEK…:ANTHROPIC_API_KEY`); a
// per-workspace index lives at `__secrets__:<workspace-id>` holding a
// JSON array of the keys that exist for that workspace. The index lets
// us list keys for a workspace without iterating the entire keychain.
//
// Why an index per workspace (instead of one global index)? Listing keys
// for a single workspace is the common case (env editor in the modal),
// and a per-workspace index makes that an O(1) keychain read. Deleting a
// workspace (`deleteAllForWorkspace`) is also cheap because the index
// already enumerates every account to remove.

const SERVICE = 'claude-fleet';
const SECRET_INDEX_PREFIX = '__secrets__:';

// keytar links libsecret-1.so.0 at module load on Linux. Loading it lazily
// and catching the dlopen failure lets the rest of the app survive on
// systems without it (bare WSL, CI without libsecret-1-0). The renderer
// degrades gracefully when isVaultAvailable() returns false — API-key
// auth mode stays disabled and OAuth handles the rest.
type Keytar = typeof import('keytar');
let cachedKeytar: Keytar | null | undefined;
async function loadKeytar(): Promise<Keytar | null> {
  if (cachedKeytar !== undefined) return cachedKeytar;
  try {
    const mod = await import('keytar');
    cachedKeytar = (mod.default ?? mod) as Keytar;
  } catch {
    cachedKeytar = null;
  }
  return cachedKeytar;
}

function accountFor(workspaceId: string, key: string): string {
  return `${workspaceId}:${key}`;
}

function indexAccountFor(workspaceId: string): string {
  return `${SECRET_INDEX_PREFIX}${workspaceId}`;
}

async function readIndex(workspaceId: string): Promise<string[]> {
  const kt = await loadKeytar();
  if (!kt) return [];
  try {
    const raw = await kt.getPassword(SERVICE, indexAccountFor(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    return [];
  }
}

async function writeIndex(workspaceId: string, keys: string[]): Promise<void> {
  const kt = await loadKeytar();
  if (!kt) throw new Error('Vault unavailable (libsecret missing or keyring unreachable).');
  await kt.setPassword(SERVICE, indexAccountFor(workspaceId), JSON.stringify(keys));
}

/** Probe whether the OS keychain is reachable. Cached after first call. */
let probeResult: boolean | null = null;
export async function isVaultAvailable(): Promise<boolean> {
  if (probeResult !== null) return probeResult;
  const kt = await loadKeytar();
  if (!kt) {
    probeResult = false;
    return false;
  }
  try {
    await kt.getPassword(SERVICE, '__probe__');
    probeResult = true;
  } catch {
    probeResult = false;
  }
  return probeResult;
}

/** List the secret keys stored for a workspace. Empty array when no keychain. */
export async function listKeys(workspaceId: string): Promise<string[]> {
  return readIndex(workspaceId);
}

/** Fetch a secret value. Returns null if missing (or no keychain). */
export async function getSecret(workspaceId: string, key: string): Promise<string | null> {
  const kt = await loadKeytar();
  if (!kt) return null;
  try {
    return await kt.getPassword(SERVICE, accountFor(workspaceId, key));
  } catch {
    return null;
  }
}

/**
 * Store or update a secret for a workspace. Adds the key to the workspace's
 * index if not already there. Throws if the keychain isn't reachable —
 * callers should branch on `isVaultAvailable()` first.
 */
export async function setSecret(
  workspaceId: string,
  key: string,
  value: string
): Promise<void> {
  const kt = await loadKeytar();
  if (!kt) throw new Error('Vault unavailable (libsecret missing or keyring unreachable).');
  await kt.setPassword(SERVICE, accountFor(workspaceId, key), value);
  const idx = await readIndex(workspaceId);
  if (!idx.includes(key)) {
    idx.push(key);
    await writeIndex(workspaceId, idx);
  }
}

/** Delete a single secret for a workspace. No-op if missing. */
export async function deleteSecret(workspaceId: string, key: string): Promise<void> {
  const kt = await loadKeytar();
  if (!kt) return;
  try {
    await kt.deletePassword(SERVICE, accountFor(workspaceId, key));
  } catch {
    // Best effort — the index is the source of truth.
  }
  const idx = (await readIndex(workspaceId)).filter((k) => k !== key);
  if (idx.length === 0) {
    // Drop the index entirely when no keys remain.
    try {
      await kt.deletePassword(SERVICE, indexAccountFor(workspaceId));
    } catch {
      // ignore
    }
  } else {
    await writeIndex(workspaceId, idx);
  }
}

/**
 * Delete every secret stored for a workspace plus its index. Called when
 * a workspace is purged from the Saved list.
 */
export async function deleteAllForWorkspace(workspaceId: string): Promise<void> {
  const kt = await loadKeytar();
  if (!kt) return;
  const keys = await readIndex(workspaceId);
  for (const key of keys) {
    try {
      await kt.deletePassword(SERVICE, accountFor(workspaceId, key));
    } catch {
      // ignore
    }
  }
  try {
    await kt.deletePassword(SERVICE, indexAccountFor(workspaceId));
  } catch {
    // ignore
  }
}

/**
 * Resolve a workspace's full env: merge the manifest's plain env with
 * the secret values pulled from the keychain. Used at container-start
 * time. Missing-key paths return an empty string so the container still
 * starts — surfacing the missing key in logs is the caller's job.
 */
export async function resolveEnv(
  workspaceId: string,
  plain: Record<string, string>,
  secretKeys: string[]
): Promise<Record<string, string>> {
  const merged: Record<string, string> = { ...plain };
  for (const key of secretKeys) {
    const value = await getSecret(workspaceId, key);
    merged[key] = value ?? '';
  }
  return merged;
}
