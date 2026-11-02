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
import { parseIndex, loadoutRefFromSource, type RemoteLoadout, type RegistryCredential } from './ociCore.js';
import { getSecret } from './vault.js';
import { sourceVaultScope, SOURCE_VAULT_KEY } from './vaultScopes.js';
import { logError } from './errorLog.js';

export interface SourcesFile {
  sources: string[];
  provenance: Record<string, { source: string; version: string; downloadedAt: number }>;
  /** Sources that have a vault credential, plus its non-secret username. Never a token. */
  credentials: Record<string, { username?: string }>;
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

/** Pull `<base>/index:latest` into a temp dir, parse + validate index.json. */
async function pullIndex(base: string): Promise<RemoteLoadout[]> {
  const tmp = await mkdtemp(join(tmpdir(), 'cf-index-'));
  try {
    await pullArtifact(`${normalizeBase(base)}/index:latest`, tmp);
    return parseIndex(await readFile(join(tmp, 'index.json'), 'utf8'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const indexCache = new Map<string, RemoteLoadout[]>();

export async function listSources(): Promise<string[]> {
  return (await read()).sources;
}

export async function addSource(base: string): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  const index = await pullIndex(b); // validates: throws on a bad/hostile index
  const cur = await read();
  if (!cur.sources.includes(b)) {
    await write({ ...cur, sources: [...cur.sources, b] });
  }
  indexCache.set(b, index);
  return index;
}

export async function removeSource(base: string): Promise<void> {
  const b = normalizeBase(base);
  const cur = await read();
  await write({ ...cur, sources: cur.sources.filter((s) => s !== b) });
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
  await pullArtifact(ref, loadoutDir(id));
  const cur = await read();
  await write({
    ...cur,
    provenance: { ...cur.provenance, [id]: { source: b, version: version ?? 'latest', downloadedAt: Date.now() } }
  });
}
