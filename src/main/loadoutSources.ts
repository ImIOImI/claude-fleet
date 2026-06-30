// Remote loadout sources (loadout-library-v2 Phase 2): persist the user's GHCR
// source list + per-loadout download provenance in <userData>/loadouts/sources.json,
// browse a source's index artifact, and download a loadout's artifact into the
// host-private library. Networking is in ociClient; pure helpers in ociCore.

import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadoutsRoot, loadoutDir } from './paths.js';
import { pullArtifact } from './ociClient.js';
import { parseIndex, loadoutRefFromSource, type RemoteLoadout } from './ociCore.js';
import { logError } from './errorLog.js';

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

async function read(): Promise<SourcesFile> {
  try {
    const raw = await readFile(sourcesPath(), 'utf8');
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
