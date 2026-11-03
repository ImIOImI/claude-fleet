// Remote loadout sources (loadout-library-v2 Phase 2; private sources #444):
// persist the user's GHCR source list + per-loadout download provenance + which
// sources have a credential in <userData>/loadouts/sources.json, resolve a
// source's credential (vault → env → signed-in GitHub token → anonymous),
// browse a source's index artifact, and download a loadout's artifact into the
// host-private library. Networking is in ociClient; pure helpers in ociCore.
// Tokens live only in the vault (scope loadout-source:<base>) — never here.

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadoutsRoot, loadoutDir } from './paths.js';
import { pullArtifact } from './ociClient.js';
import { writeFileAtomic } from './atomicWrite.js';
import {
  parseIndex,
  loadoutRefFromSource,
  RegistryAuthError,
  isTokenShaped,
  type RemoteLoadout,
  type RegistryCredential
} from './ociCore.js';
import { getSecret, setSecret, deleteAllForWorkspace } from './vault.js';
import { sourceVaultScope, SOURCE_VAULT_KEY } from './vaultScopes.js';
import { logError } from './errorLog.js';

export interface SourcesFile {
  sources: string[];
  provenance: Record<string, { source: string; version: string; downloadedAt: number }>;
  /** Sources that have a vault credential, plus its non-secret username. Never a token. */
  credentials: Record<string, { username?: string }>;
}

/** What the renderer sees per source (loadouts:listSources). Never the token. */
export interface SourceInfo {
  base: string;
  hasCredential: boolean;
  username?: string;
}

/** What the renderer may submit (loadouts:addSource / setSourceCredential). */
export interface SourceCredentialInput {
  token: string;
  username?: string;
}

function sourcesPath(): string {
  return join(loadoutsRoot(), 'sources.json');
}

/**
 * Canonical form of a source base: trimmed, no `oci://`, no trailing `/`,
 * lower-cased (OCI repository names are lower-case). One repo ⇒ one vault
 * scope, and the default-source exclusion can't be dodged by case or prefix.
 */
function normalizeBase(base: string): string {
  if (typeof base !== 'string') throw new Error('source must be a string');
  return base.trim().replace(/^oci:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Sources a fresh install starts with (seeded only when sources.json doesn't
 * exist yet; removing one writes the file, so it is never re-added).
 */
export const DEFAULT_SOURCES = ['ghcr.io/imioimi/claude-fleet-loadouts'];

function parseCredentials(v: unknown): SourcesFile['credentials'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: SourcesFile['credentials'] = {};
  for (const [base, entry] of Object.entries(v as Record<string, unknown>)) {
    const username = (entry as { username?: unknown } | null)?.username;
    out[normalizeBase(base)] = typeof username === 'string' && username ? { username } : {};
  }
  return out;
}

// Every sources.json read-modify-write (and each paired vault + JSON write)
// runs under this one promise-chain mutex, like vault.ts withLock, so
// concurrent IPC calls can't lose each other's updates. Not re-entrant: code
// running under the lock calls read()/write() directly, never withSourcesLock.
let sourcesChain: Promise<unknown> = Promise.resolve();
function withSourcesLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = sourcesChain.then(fn, fn);
  sourcesChain = next.catch(() => undefined);
  return next;
}

/**
 * Read sources.json. Caller holds the lock (it may write the fresh-install
 * seed). Fails closed: a corrupt or unreadable file throws rather than
 * returning an empty list the next write would persist over the user's data.
 * Only ENOENT (fresh install) yields the seeded defaults.
 */
async function read(): Promise<SourcesFile> {
  let raw: string;
  try {
    raw = await readFile(sourcesPath(), 'utf8');
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      throw new Error(`sources.json is unreadable (${(err as { code?: string }).code ?? 'error'})`);
    }
    const seeded: SourcesFile = { sources: [...DEFAULT_SOURCES], provenance: {}, credentials: {} };
    await write(seeded).catch(() => undefined); // still seeded for this read if the write fails
    return seeded;
  }
  let parsed: Partial<SourcesFile>;
  try {
    parsed = JSON.parse(raw) as Partial<SourcesFile>;
  } catch {
    throw new Error('sources.json is corrupt (invalid JSON); fix or delete it');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('sources.json is corrupt (not an object); fix or delete it');
  }
  const list = Array.isArray(parsed.sources) ? parsed.sources.filter((s): s is string => typeof s === 'string') : [];
  return {
    sources: [...new Set(list.map(normalizeBase))],
    provenance: parsed.provenance && typeof parsed.provenance === 'object' ? parsed.provenance : {},
    credentials: parseCredentials(parsed.credentials)
  };
}

/** Read under the lock, for callers that only look. */
function readLocked(): Promise<SourcesFile> {
  return withSourcesLock(read);
}

/** Atomic replace (tmp file beside it + rename). Caller holds the lock. */
async function write(next: SourcesFile): Promise<void> {
  await mkdir(loadoutsRoot(), { recursive: true });
  await writeFileAtomic(sourcesPath(), JSON.stringify(next, null, 2) + '\n');
}

/**
 * `FLEET_LOADOUT_TOKEN_<SANITISED_BASE>`: base upper-cased, every
 * non-alphanumeric → `_` (headless/remote hosts, spec #444). The mapping is
 * lossy: distinct bases can share a name (`ghcr.io/a-b/x` and `ghcr.io/a/b-x`
 * → `…_GHCR_IO_A_B_X`), so one env token may be offered to both. That is
 * acceptable because a token is still only ever sent to its registry host
 * (ociClient's realm guard + registry pin) — never to another host.
 */
export function sourceEnvVarName(base: string): string {
  return `FLEET_LOADOUT_TOKEN_${normalizeBase(base).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

let githubTokenProvider: (() => Promise<string | null>) | undefined;

/**
 * Extension point for GitHub sign-in (remote-workspaces sub-project (b)): once
 * registered, ghcr.io sources without a vault/env token use the signed-in
 * user's read:packages token. Nothing registers a provider yet.
 */
export function setGithubTokenProvider(fn: (() => Promise<string | null>) | undefined): void {
  githubTokenProvider = fn;
}

/**
 * Resolve a source's credential, main process only: the vault token, then the
 * per-source env var, then (ghcr.io only) the signed-in GitHub token, then
 * FLEET_LOADOUT_TOKEN for a non-default source, else null (anonymous).
 */
export async function credentialFor(base: string): Promise<RegistryCredential | null> {
  const b = normalizeBase(base);
  const vaultToken = await getSecret(sourceVaultScope(b), SOURCE_VAULT_KEY);
  if (vaultToken) {
    const username = (await readLocked()).credentials[b]?.username;
    return username ? { token: vaultToken, username } : { token: vaultToken };
  }
  const envToken = process.env[sourceEnvVarName(b)];
  if (envToken) return { token: envToken };
  if (b.startsWith('ghcr.io/') && githubTokenProvider) {
    const gh = await githubTokenProvider();
    if (gh) return { token: gh };
  }
  const generic = process.env.FLEET_LOADOUT_TOKEN;
  if (generic && !DEFAULT_SOURCES.includes(b)) return { token: generic };
  return null;
}

/**
 * Map a registry auth failure to the IPC error contract. Electron carries only
 * an Error's message across ipcMain.handle, so the kind is a parseable prefix
 * (renderer: sourceErrors.ts). Names the source, never the token.
 */
async function withSourceAuth<T>(b: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RegistryAuthError) {
      throw new Error(
        err.kind === 'needs-credential' ? `needs-credential: ${b}` : `credential-rejected: ${b} (HTTP ${err.status})`
      );
    }
    throw err;
  }
}

const MAX_USERNAME_LENGTH = 256;

/**
 * Validate a renderer-submitted credential before it ever reaches the vault:
 * trim the token, require it to be non-empty and header-shaped
 * (ociCore.isTokenShaped — the rule assertTokenShape enforces, length-capped),
 * and require any username to be short, control-free and colon-free (it is
 * the `user:` half of a Basic credential). The malformed-credential rejection
 * carries no token and no HTTP status (#444 security review).
 */
function cleanCredential(base: string, cred: SourceCredentialInput): SourceCredentialInput {
  const token = typeof cred?.token === 'string' ? cred.token.trim() : '';
  if (!token) throw new Error('A token is required');
  if (!isTokenShaped(token)) throw new Error(`malformed-credential: ${base}`);
  const username = typeof cred.username === 'string' && cred.username.trim() ? cred.username.trim() : undefined;
  if (
    username !== undefined &&
    (username.length > MAX_USERNAME_LENGTH || username.includes(':') || /[\x00-\x1f\x7f]/.test(username))
  ) {
    throw new Error(`malformed-credential: ${base}`);
  }
  return username ? { token, username } : { token };
}

/** What a source's credential looked like before a store, for rollback. */
interface CredentialSnapshot {
  token: string | null;
  entry: { username?: string } | undefined;
}

/** Store a credential (vault + sources.json). Caller holds the lock; returns the prior state. */
async function storeCredentialLocked(b: string, cred: SourceCredentialInput, cur: SourcesFile): Promise<CredentialSnapshot> {
  const snap: CredentialSnapshot = { token: await getSecret(sourceVaultScope(b), SOURCE_VAULT_KEY), entry: cur.credentials[b] };
  await setSecret(sourceVaultScope(b), SOURCE_VAULT_KEY, cred.token);
  await write({ ...cur, credentials: { ...cur.credentials, [b]: cred.username ? { username: cred.username } : {} } });
  return snap;
}

/**
 * Put a source's credential back as it was (or clear it, if none existed).
 * `storedToken` is the token *this call* wrote before validating; if the vault
 * no longer holds that value, a concurrent call already changed it (a second
 * credential write landed, or the source was removed — removeSource purges
 * the scope first), so this rolls back nothing rather than clobbering
 * whatever is there now (#444 security review).
 */
function restoreCredential(b: string, snap: CredentialSnapshot, storedToken: string): Promise<void> {
  return withSourcesLock(async () => {
    const current = await getSecret(sourceVaultScope(b), SOURCE_VAULT_KEY);
    if (current !== storedToken) return;
    if (snap.token !== null) await setSecret(sourceVaultScope(b), SOURCE_VAULT_KEY, snap.token);
    else await deleteAllForWorkspace(sourceVaultScope(b));
    const cur = await read();
    const credentials = { ...cur.credentials };
    if (snap.entry) credentials[b] = snap.entry;
    else delete credentials[b];
    await write({ ...cur, credentials });
  });
}

/** Restore after a failed validation; a failed restore is logged (base only, never the token). */
async function rollbackCredential(b: string, snap: CredentialSnapshot, storedToken: string): Promise<void> {
  try {
    await restoreCredential(b, snap, storedToken);
  } catch (err) {
    logError({
      source: 'main',
      type: 'loadoutSources.credentialRollback',
      message: `could not roll back the credential for source ${b}: ${(err as Error).message}`
    });
  }
}

/** Pull `<base>/index:latest` (with the source's credential) into a temp dir,
 *  parse + validate index.json. */
async function pullIndex(base: string): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  const cred: RegistryCredential | null = await credentialFor(b);
  const tmp = await mkdtemp(join(tmpdir(), 'cf-index-'));
  try {
    await withSourceAuth(b, () => pullArtifact(`${b}/index:latest`, tmp, { cred }));
    return parseIndex(await readFile(join(tmp, 'index.json'), 'utf8'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const indexCache = new Map<string, RemoteLoadout[]>();

export async function listSources(): Promise<string[]> {
  return (await readLocked()).sources;
}

export async function listSourceInfo(): Promise<SourceInfo[]> {
  const { sources, credentials } = await readLocked();
  return sources.map((base) => {
    const c = credentials[base];
    if (!c) return { base, hasCredential: false };
    return c.username ? { base, hasCredential: true, username: c.username } : { base, hasCredential: true };
  });
}

/**
 * Validate (pull + parse the index) and add a source. With `cred`, the token is
 * stored in the vault first so validation can use it. If validation fails for
 * any reason — an auth rejection, a network error, a bad index, anything —
 * the previous credential is restored (or cleared, for a source that had
 * none), so a bad re-add never destroys a working token (#444 security
 * review: this used to restore only on an auth failure). The network pull
 * runs outside the sources.json lock; the list is re-read under it afterwards.
 */
export async function addSource(base: string, cred?: SourceCredentialInput): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  const clean = cred ? cleanCredential(b, cred) : undefined;
  let snap: CredentialSnapshot | undefined;
  if (clean) snap = await withSourcesLock(async () => storeCredentialLocked(b, clean, await read()));
  else await readLocked(); // fail closed on a corrupt file before any network
  let index: RemoteLoadout[];
  try {
    index = await pullIndex(b); // validates: throws on a bad/hostile index or an auth failure
  } catch (err) {
    if (snap) await rollbackCredential(b, snap, clean!.token);
    throw err;
  }
  await withSourcesLock(async () => {
    const cur = await read();
    if (!cur.sources.includes(b)) await write({ ...cur, sources: [...cur.sources, b] });
  });
  indexCache.set(b, index);
  return index;
}

/**
 * Set/replace (or, with null, remove) a configured source's token, then
 * force-refresh it. A replacement that fails validation for any reason is
 * rolled back to the previous credential (or cleared, if there was none)
 * before rethrowing (#444 security review: this used to restore only on an
 * auth failure).
 */
export async function setSourceCredential(base: string, cred: SourceCredentialInput | null): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  const clean = cred ? cleanCredential(b, cred) : null;
  const snap = await withSourcesLock(async () => {
    const cur = await read();
    if (!cur.sources.includes(b)) throw new Error(`unknown source: ${b}`);
    if (clean) return storeCredentialLocked(b, clean, cur);
    await deleteAllForWorkspace(sourceVaultScope(b));
    if (b in cur.credentials) {
      const credentials = { ...cur.credentials };
      delete credentials[b];
      await write({ ...cur, credentials });
    }
    return undefined;
  });
  try {
    return await browseSource(b, { refresh: true });
  } catch (err) {
    if (snap) await rollbackCredential(b, snap, clean!.token);
    throw err;
  }
}

/** Purge the source's vault scope first, then drop it from the list (one locked step). */
export async function removeSource(base: string): Promise<void> {
  const b = normalizeBase(base);
  await withSourcesLock(async () => {
    const cur = await read();
    await deleteAllForWorkspace(sourceVaultScope(b));
    const credentials = { ...cur.credentials };
    delete credentials[b];
    await write({ ...cur, sources: cur.sources.filter((s) => s !== b), credentials });
  });
  indexCache.delete(b);
}

export async function browseSource(base: string, opts: { refresh?: boolean } = {}): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  if (!opts.refresh && indexCache.has(b)) return indexCache.get(b)!;
  const index = await pullIndex(b);
  indexCache.set(b, index);
  return index;
}

/** Every configured source's index, failed sources skipped (logged), for the catalog. */
export async function allRemote(): Promise<{ source: string; loadouts: RemoteLoadout[] }[]> {
  const srcs = await listSources();
  const out: { source: string; loadouts: RemoteLoadout[] }[] = [];
  for (const source of srcs) {
    try {
      // Force refresh so allRemote always reflects current remote state.
      out.push({ source, loadouts: await browseSource(source, { refresh: true }) });
    } catch (err) {
      logError({
        source: 'main',
        type: 'loadoutSources.allRemote',
        message: `source ${source} failed: ${(err as Error).message}`,
        stack: (err as Error).stack,
      });
    }
  }
  return out;
}

export async function provenanceFor(id: string): Promise<{ source: string; version: string } | null> {
  const p = (await readLocked()).provenance[id];
  return p ? { source: p.source, version: p.version } : null;
}

/** Pull a loadout's artifact into <userData>/loadouts/<id>/ and record provenance. */
export async function download(source: string, id: string, version?: string): Promise<void> {
  const b = normalizeBase(source);
  const ref = loadoutRefFromSource(b, id, version);
  const cred = await credentialFor(b);
  await withSourceAuth(b, () => pullArtifact(ref, loadoutDir(id), { cred }));
  await withSourcesLock(async () => {
    const cur = await read();
    await write({
      ...cur,
      provenance: { ...cur.provenance, [id]: { source: b, version: version ?? 'latest', downloadedAt: Date.now() } }
    });
  });
}
