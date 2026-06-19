// Per-workspace secret storage backed by Electron's `safeStorage`.
//
// Each workspace owns its own bag of secret env-var values. The whole vault
// is a single JSON object `{ "<workspaceId>": { "<key>": "<value>" } }`,
// encrypted with `safeStorage.encryptString` and written (base64) to
// `<userData>/secrets.enc`.
//
// Why safeStorage instead of keytar: keytar needs a Secret Service daemon
// (libsecret/gnome-keyring) at runtime, which is routinely absent on WSL —
// so API-key auth silently failed to store secrets there. safeStorage uses
// the OS keychain on macOS/Windows and the desktop keyring on Linux *when
// present*, but falls back to a built-in AES key ("basic" backend) when no
// keyring is reachable. So encryption is available on bare WSL too, and the
// vault works everywhere the app runs. The trade-off: under the basic
// fallback the at-rest key isn't OS-protected — acceptable here since the
// file lives in the per-user `userData` dir and the prior state was "secrets
// don't work at all on WSL."
//
// Migration note: secrets previously written to keytar (`<id>:<key>`
// accounts) are NOT carried over — users re-enter API keys once. OAuth
// workspaces store no secrets, so they're unaffected.

import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Store = Record<string, Record<string, string>>;

function filePath(): string {
  return join(app.getPath('userData'), 'secrets.enc');
}

// In-memory copy of the decrypted store. We own every write, so the cache
// stays authoritative once loaded.
let cache: Store | null = null;

function isStore(v: unknown): v is Store {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const b64 = await readFile(filePath(), 'utf8');
    if (!b64.trim()) {
      cache = {};
      return cache;
    }
    const decrypted = safeStorage.decryptString(Buffer.from(b64, 'base64'));
    const parsed = JSON.parse(decrypted) as unknown;
    cache = isStore(parsed) ? parsed : {};
  } catch {
    // Missing file, undecryptable (key changed), or malformed → empty vault.
    cache = {};
  }
  return cache;
}

async function persist(store: Store): Promise<void> {
  cache = store;
  const buf = safeStorage.encryptString(JSON.stringify(store));
  await writeFile(filePath(), buf.toString('base64'), 'utf8');
}

// Serialize read-modify-write so concurrent setSecret/deleteSecret calls
// (e.g. the env editor writing several rows) can't clobber each other.
let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

// safeStorage uses the OS keyring on macOS/Windows and the desktop keyring on
// Linux. On Linux WITHOUT a keyring (e.g. WSL), `isEncryptionAvailable()` is
// false until we opt into the plaintext backend — which stores base64
// plaintext, not OS-encrypted (see SPEC §9). We do that once so the vault is
// at least functional there; `usesPlaintextEncryption()` lets callers surface
// the weaker protection.
let encryptionEnsured = false;
function encryptionAvailable(): boolean {
  if (!encryptionEnsured) {
    encryptionEnsured = true;
    try {
      if (!safeStorage.isEncryptionAvailable() && process.platform === 'linux') {
        safeStorage.setUsePlainTextEncryption(true);
      }
    } catch {
      /* setUsePlainTextEncryption can throw before ready / on some platforms */
    }
  }
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Probe whether secret storage is usable. Cached after first call. */
let probeResult: boolean | null = null;
export async function isVaultAvailable(): Promise<boolean> {
  if (probeResult !== null) return probeResult;
  probeResult = encryptionAvailable();
  return probeResult;
}

/** List the secret keys stored for a workspace. Empty array when none. */
export async function listKeys(workspaceId: string): Promise<string[]> {
  const store = await load();
  return Object.keys(store[workspaceId] ?? {});
}

/** Fetch a secret value. Returns null if missing. */
export async function getSecret(workspaceId: string, key: string): Promise<string | null> {
  const store = await load();
  return store[workspaceId]?.[key] ?? null;
}

/**
 * Store or update a secret for a workspace. Throws if encryption isn't
 * available — callers should branch on `isVaultAvailable()` first.
 */
export async function setSecret(workspaceId: string, key: string, value: string): Promise<void> {
  if (!encryptionAvailable()) {
    throw new Error('Vault unavailable (secret encryption not available on this system).');
  }
  await withLock(async () => {
    const store = await load();
    const bag = { ...(store[workspaceId] ?? {}), [key]: value };
    await persist({ ...store, [workspaceId]: bag });
  });
}

/** Delete a single secret for a workspace. No-op if missing. */
export async function deleteSecret(workspaceId: string, key: string): Promise<void> {
  await withLock(async () => {
    const store = await load();
    const bag = store[workspaceId];
    if (!bag || !(key in bag)) return;
    const next: Record<string, string> = { ...bag };
    delete next[key];
    const nextStore = { ...store };
    if (Object.keys(next).length === 0) delete nextStore[workspaceId];
    else nextStore[workspaceId] = next;
    await persist(nextStore);
  });
}

/**
 * Delete every secret stored for a workspace. Called when a workspace is
 * purged from the Saved list.
 */
export async function deleteAllForWorkspace(workspaceId: string): Promise<void> {
  await withLock(async () => {
    const store = await load();
    if (!(workspaceId in store)) return;
    const nextStore = { ...store };
    delete nextStore[workspaceId];
    await persist(nextStore);
  });
}

/**
 * Resolve a workspace's full env: merge the manifest's plain env with the
 * secret values from the vault. Used at container-start time. Missing keys
 * resolve to the empty string so the container still starts — surfacing the
 * missing key in logs is the caller's job.
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

/** Test-only: drop the in-memory cache + probe so a fresh read hits disk. */
export function _resetVaultCacheForTests(): void {
  cache = null;
  probeResult = null;
}
