// Remote loadout sources (loadout-library-v2 Phase 2; private sources #444):
// persist the user's GHCR source list + per-loadout download provenance + which
// sources have a credential in <userData>/loadouts/sources.json, resolve a
// source's credential (vault → env → signed-in GitHub token → anonymous),
// browse a source's index artifact, and download a loadout's artifact into the
// host-private library. Networking is in ociClient; pure helpers in ociCore.
// Tokens live only in the vault (scope loadout-source:<base>) — never here.

import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadoutsRoot, loadoutDir } from './paths.js';
import { pullArtifact } from './ociClient.js';
import { parseIndex, loadoutRefFromSource, RegistryAuthError, type RemoteLoadout, type RegistryCredential } from './ociCore.js';
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

function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
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
    out[base] = typeof username === 'string' && username ? { username } : {};
  }
  return out;
}

async function read(): Promise<SourcesFile> {
  let raw: string;
  try {
    raw = await readFile(sourcesPath(), 'utf8');
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'ENOENT') return { sources: [], provenance: {}, credentials: {} };
    const seeded: SourcesFile = { sources: [...DEFAULT_SOURCES], provenance: {}, credentials: {} };
    await write(seeded).catch(() => undefined); // still seeded for this read if the write fails
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SourcesFile>;
    return {
      sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s): s is string => typeof s === 'string') : [],
      provenance: parsed.provenance && typeof parsed.provenance === 'object' ? parsed.provenance : {},
      credentials: parseCredentials(parsed.credentials)
    };
  } catch {
    return { sources: [], provenance: {}, credentials: {} };
  }
}

async function write(next: SourcesFile): Promise<void> {
  await mkdir(loadoutsRoot(), { recursive: true });
  await writeFile(sourcesPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/** `FLEET_LOADOUT_TOKEN_<SANITISED_BASE>`: base upper-cased, every
 *  non-alphanumeric → `_` (headless/remote hosts, spec #444). */
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
    const username = (await read()).credentials[b]?.username;
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

/**
 * Validate a renderer-submitted credential before it ever reaches the vault:
 * trim the token, require it to be non-empty, and require it to be shaped
 * like a header value (`assertTokenShape`'s rule). The malformed-credential
 * rejection carries no token and no HTTP status (#444 security review).
 */
function cleanCredential(base: string, cred: SourceCredentialInput): SourceCredentialInput {
  const token = typeof cred?.token === 'string' ? cred.token.trim() : '';
  if (!token) throw new Error('A token is required');
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error(`malformed-credential: ${base}`);
  const username = typeof cred.username === 'string' && cred.username.trim() ? cred.username.trim() : undefined;
  return username ? { token, username } : { token };
}

async function storeCredential(b: string, cred: SourceCredentialInput): Promise<void> {
  await setSecret(sourceVaultScope(b), SOURCE_VAULT_KEY, cred.token);
  const cur = await read();
  await write({ ...cur, credentials: { ...cur.credentials, [b]: cred.username ? { username: cred.username } : {} } });
}

async function clearCredential(b: string): Promise<void> {
  await deleteAllForWorkspace(sourceVaultScope(b));
  const cur = await read();
  if (!(b in cur.credentials)) return;
  const credentials = { ...cur.credentials };
  delete credentials[b];
  await write({ ...cur, credentials });
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
  return (await read()).sources;
}

export async function listSourceInfo(): Promise<SourceInfo[]> {
  const { sources, credentials } = await read();
  return sources.map((base) => {
    const c = credentials[base];
    if (!c) return { base, hasCredential: false };
    return c.username ? { base, hasCredential: true, username: c.username } : { base, hasCredential: true };
  });
}

/**
 * Validate (pull + parse the index) and add a source. With `cred`, the token is
 * stored in the vault first so validation can use it; if validation then fails
 * for a source that wasn't already configured, the token is deleted again.
 */
export async function addSource(base: string, cred?: SourceCredentialInput): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  const before = await read();
  const known = before.sources.includes(b);
  const hadCredential = b in before.credentials;
  if (cred) await storeCredential(b, cleanCredential(b, cred));
  let index: RemoteLoadout[];
  try {
    index = await pullIndex(b); // validates: throws on a bad/hostile index or an auth failure
  } catch (err) {
    if (cred && !known && !hadCredential) await clearCredential(b).catch(() => undefined);
    throw err;
  }
  const cur = await read();
  if (!cur.sources.includes(b)) {
    await write({ ...cur, sources: [...cur.sources, b] });
  }
  indexCache.set(b, index);
  return index;
}

/** Set/replace (or, with null, remove) a configured source's token, then force-refresh it. */
export async function setSourceCredential(base: string, cred: SourceCredentialInput | null): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  if (!(await read()).sources.includes(b)) throw new Error(`unknown source: ${b}`);
  if (cred) await storeCredential(b, cleanCredential(b, cred));
  else await clearCredential(b);
  return browseSource(b, { refresh: true });
}

export async function removeSource(base: string): Promise<void> {
  const b = normalizeBase(base);
  const cur = await read();
  await write({ ...cur, sources: cur.sources.filter((s) => s !== b) });
  await clearCredential(b);
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
  const p = (await read()).provenance[id];
  return p ? { source: p.source, version: p.version } : null;
}

/** Pull a loadout's artifact into <userData>/loadouts/<id>/ and record provenance. */
export async function download(source: string, id: string, version?: string): Promise<void> {
  const b = normalizeBase(source);
  const ref = loadoutRefFromSource(b, id, version);
  const cred = await credentialFor(b);
  await withSourceAuth(b, () => pullArtifact(ref, loadoutDir(id), { cred }));
  const cur = await read();
  await write({
    ...cur,
    provenance: { ...cur.provenance, [id]: { source: b, version: version ?? 'latest', downloadedAt: Date.now() } }
  });
}
