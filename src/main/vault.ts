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
//
// Three kinds of scope share this store: workspace bags (bare id, resolved
// via vaultModel's inherit/override lines), the app root env (`app:env`,
// each key's canonical value) + its metadata index (`app:index`), and other
// reserved host-only bags (endpoint:/identity:/store:/loadout-source:).

import { app, safeStorage } from 'electron';
import { perfSpanAsync } from './perf.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ENV_SCOPE, APP_INDEX_SCOPE } from './vaultScopes.js';
import * as model from './vaultModel.js';
import type { ModelEntry, Store, WorkspaceEdit } from './vaultModel.js';

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
 * purged from the Saved list. A workspace scope (no ':') cascades through
 * the model (drops inherit links + orphaned metadata too); a reserved scope
 * is just a flat bag, dropped whole.
 */
export async function deleteAllForWorkspace(workspaceId: string): Promise<void> {
  if (!workspaceId.includes(':')) {
    await mutate((s) => model.removeWorkspace(s, workspaceId));
    return;
  }
  await withLock(async () => {
    const store = await load();
    if (!(workspaceId in store)) return;
    const nextStore = { ...store };
    delete nextStore[workspaceId];
    await persist(nextStore);
  });
}

/** Apply a store transform, persisting it. Throws when encryption isn't available. */
async function mutate(fn: (s: Store) => Store): Promise<void> {
  if (!encryptionAvailable()) {
    throw new Error('Vault unavailable (secret encryption not available on this system).');
  }
  await withLock(async () => {
    const store = await load();
    await persist(fn(store));
  });
}

export async function listModelEntries(): Promise<ModelEntry[]> {
  return model.listEntries(await load());
}

export async function getRootValue(key: string): Promise<string | null> {
  const s = await load();
  return s[APP_ENV_SCOPE]?.[key] ?? null;
}

export async function revealValue(key: string, ws: string | null): Promise<string | null> {
  const s = await load();
  if (ws === null) return s[APP_ENV_SCOPE]?.[key] ?? null;
  return model.lineMode(s, key, ws) ? (model.resolveWorkspaceEnv(s, ws)[key] ?? null) : null;
}

export function putKey(a: { key: string; secret: boolean; tags: string[]; rootValue?: string | null }): Promise<void> {
  return mutate((s) => model.putKey(s, a));
}

export function renameKey(key: string, next: string): Promise<void> {
  return mutate((s) => model.renameKey(s, key, next));
}

export function deleteKey(key: string): Promise<void> {
  return mutate((s) => model.deleteKey(s, key));
}

export function setLine(key: string, ws: string, line: { mode: 'inherit' } | { mode: 'override'; value: string }): Promise<void> {
  return mutate((s) => model.setLine(s, key, ws, line));
}

export function removeLine(key: string, ws: string): Promise<void> {
  return mutate((s) => model.removeLine(s, key, ws));
}

export function copyWorkspace(from: string, to: string): Promise<void> {
  return mutate((s) => model.copyWorkspace(s, from, to));
}

export function applyWorkspaceEdits(ws: string, edits: WorkspaceEdit[]): Promise<void> {
  return mutate((s) => model.applyWorkspaceEdits(s, ws, edits));
}

/** Resolve a workspace's full env from the vault. Used at container/local-spawn start time. */
export async function resolveWorkspaceEnv(ws: string): Promise<Record<string, string>> {
  return perfSpanAsync('claude_fleet.vault.resolve_env', async () => model.resolveWorkspaceEnv(await load(), ws), { workspace_id: ws });
}

export async function workspaceKeys(ws: string): Promise<{ key: string; secret: boolean }[]> {
  return model.workspaceKeys(await load(), ws);
}

export async function workspaceSecretValues(ws: string): Promise<{ key: string; value: string }[]> {
  return model.workspaceSecretValues(await load(), ws);
}

/** One-shot manifest→vault migration. Returns false (store untouched) once already migrated. */
export async function migrateManifestEnv(
  manifests: { id: string; plain: Record<string, string>; secretKeys: string[] }[]
): Promise<boolean> {
  let ran = false;
  await mutate((s) => {
    if (s[APP_INDEX_SCOPE]?.[model.MIGRATED_MARKER]) return s;
    ran = true;
    return model.migrateManifestEnv(s, manifests);
  });
  return ran;
}

export async function isMigrated(): Promise<boolean> {
  const s = await load();
  return Boolean(s[APP_INDEX_SCOPE]?.[model.MIGRATED_MARKER]);
}

/** Test-only: drop the in-memory cache + probe + encryption-ensured flag so a fresh read/probe hits disk. */
export function _resetVaultCacheForTests(): void {
  cache = null;
  probeResult = null;
  encryptionEnsured = false;
}
