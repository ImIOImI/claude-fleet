// Remote loadout sources (loadout-library-v2 Phase 2): persist the user's GHCR
// source list + per-loadout download provenance in <userData>/loadouts/sources.json,
// browse a source's index artifact, and download a loadout's artifact into the
// host-private library. Networking is in ociClient; pure helpers in ociCore.
// A source may carry a token (vault, never sources.json) for private packages;
// sources without one fall back to $GH_TOKEN.

import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadoutsRoot, loadoutDir } from './paths.js';
import { pullArtifact } from './ociClient.js';
import { parseIndex, loadoutRefFromSource, INDEX_ARTIFACT_TYPE, LOADOUT_ARTIFACT_TYPE, type RemoteLoadout } from './ociCore.js';
import { logError } from './errorLog.js';
import { parseLoadout } from './loadoutCore.js';
import { getSecret, setSecret, deleteSecret } from './vault.js';

export interface SourcesFile {
  sources: string[];
  provenance: Record<string, { source: string; version: string; downloadedAt: number }>;
}

function sourcesPath(): string {
  return join(loadoutsRoot(), 'sources.json');
}

function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

const SOURCE_VAULT_KEY = 'TOKEN';
function sourceVaultScope(base: string): string {
  return `loadout-source:${base}`;
}

/** Stored per-source token, else $GH_TOKEN. Safe only while ociCore.parseImageRef is ghcr.io-only. */
async function credentialFor(base: string): Promise<string | undefined> {
  return (await getSecret(sourceVaultScope(base), SOURCE_VAULT_KEY)) ?? (process.env.GH_TOKEN || undefined);
}

/**
 * Sources a fresh install starts with (seeded only when sources.json doesn't
 * exist yet; removing one writes the file, so it is never re-added).
 */
export const DEFAULT_SOURCES = ['ghcr.io/imioimi/claude-fleet-loadouts'];

async function read(): Promise<SourcesFile> {
  let raw: string;
  try {
    raw = await readFile(sourcesPath(), 'utf8');
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'ENOENT') return { sources: [], provenance: {} };
    const seeded: SourcesFile = { sources: [...DEFAULT_SOURCES], provenance: {} };
    await write(seeded).catch(() => undefined); // still seeded for this read if the write fails
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SourcesFile>;
    return {
      sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s): s is string => typeof s === 'string') : [],
      provenance: parsed.provenance && typeof parsed.provenance === 'object' ? parsed.provenance : {}
    };
  } catch {
    return { sources: [], provenance: {} };
  }
}

async function write(next: SourcesFile): Promise<void> {
  await mkdir(loadoutsRoot(), { recursive: true });
  await writeFile(sourcesPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/** Pull `<base>/index:latest` into a temp dir, parse + validate index.json. */
async function pullIndex(base: string, credential?: string): Promise<RemoteLoadout[]> {
  const tmp = await mkdtemp(join(tmpdir(), 'cf-index-'));
  try {
    const b = normalizeBase(base);
    await pullArtifact(`${b}/index:latest`, tmp, { credential: credential ?? (await credentialFor(b)), artifactType: INDEX_ARTIFACT_TYPE });
    return parseIndex(await readFile(join(tmp, 'index.json'), 'utf8'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const indexCache = new Map<string, RemoteLoadout[]>();

export async function listSources(): Promise<string[]> {
  return (await read()).sources;
}

/** Add (or re-add) a source. A non-empty `token` is stored once the index pull succeeds with it. */
export async function addSource(base: string, token?: string): Promise<RemoteLoadout[]> {
  const b = normalizeBase(base);
  const t = token?.trim() || undefined;
  const index = await pullIndex(b, t); // validates: throws on a bad/hostile index
  if (t) await setSecret(sourceVaultScope(b), SOURCE_VAULT_KEY, t);
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
  await deleteSecret(sourceVaultScope(b), SOURCE_VAULT_KEY);
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

/**
 * Pull into a hidden staging dir beside `dest`, then swap it in, so files a
 * newer version dropped don't linger and a failed pull leaves the old copy
 * intact. Staging/backup dirs start with "." so the library listing skips any
 * a crash leaves behind.
 */
async function pullReplacing(dest: string, pull: (stage: string) => Promise<void>): Promise<void> {
  const tag = randomBytes(4).toString('hex');
  const stage = join(dirname(dest), `.pull-${basename(dest)}-${tag}`);
  const backup = join(dirname(dest), `.old-${basename(dest)}-${tag}`);
  try {
    await pull(stage);
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    throw err;
  }
  let hadOld = true;
  try {
    await rename(dest, backup);
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      await rm(stage, { recursive: true, force: true });
      throw err;
    }
    hadOld = false;
  }
  try {
    await rename(stage, dest);
  } catch (err) {
    if (hadOld) await rename(backup, dest).catch(() => undefined);
    await rm(stage, { recursive: true, force: true });
    throw err;
  }
  if (hadOld) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
}

/** Pull a loadout's artifact into <userData>/loadouts/<id>/ and record provenance. */
export async function download(source: string, id: string, version?: string): Promise<void> {
  const b = normalizeBase(source);
  const ref = loadoutRefFromSource(b, id, version);
  const credential = await credentialFor(b);
  await pullReplacing(loadoutDir(id), (stage) => pullArtifact(ref, stage, { credential, artifactType: LOADOUT_ARTIFACT_TYPE }));
  // Record the version actually pulled (a `latest` pull reports its loadout.md version).
  const pulled = await parseLoadout(loadoutDir(id)).then((m) => m.version).catch(() => undefined);
  const cur = await read();
  await write({
    ...cur,
    provenance: { ...cur.provenance, [id]: { source: b, version: pulled ?? version ?? 'latest', downloadedAt: Date.now() } }
  });
}
