// Assemble the loadout catalog for the renderer (browser modal + rail). Phase 1
// is local-only: the local library + the target workspace's installed set +
// global favorites, with no remote sources (assembleCatalog `remote` is []).
// Phase 2 extends this with real remote sources via allRemote().
// Pure assembly lives in ociCore.ts:assembleCatalog; this is the I/O glue.

import { listLoadouts } from './loadouts.js';
import { getFavorites } from './config.js';
import { readWorkspaceManifest } from './workspaces.js';
import { assembleCatalog, type CatalogEntry, type LocalLoadout, type InstalledRef } from './ociCore.js';
import { allRemote } from './loadoutSources.js';

export async function buildLoadoutCatalog(workspaceId?: string): Promise<CatalogEntry[]> {
  const [summaries, favorites] = await Promise.all([listLoadouts(), getFavorites()]);
  const local: LocalLoadout[] = summaries.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    tags: s.tags
    // version omitted — local list carries none; update detection is Phase 2.
  }));
  let installed: InstalledRef[] = [];
  if (workspaceId) {
    const ws = await readWorkspaceManifest(workspaceId);
    installed = (ws?.installedLoadouts ?? []).map((l) => ({
      id: l.id,
      version: (l as { version?: string }).version
    }));
  }
  const remote = await allRemote();
  return assembleCatalog({ local, installed, favorites, remote });
}
