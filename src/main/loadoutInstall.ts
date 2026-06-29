// Pull-if-needed install (loadout-library-v2 Phase 2). There is no standalone
// "download" state: installing a loadout downloads its artifact first if it is
// absent (or a different version than what's recorded), then runs the existing
// installLoadout. A collision with a LOCALLY-AUTHORED loadout (present on disk
// but with no download provenance) is confirm-before-overwrite, never silent.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadoutDir } from './paths.js';
import { installLoadout } from './loadouts.js';
import { download, provenanceFor } from './loadoutSources.js';

async function presentLocally(id: string): Promise<boolean> {
  try {
    await stat(join(loadoutDir(id), 'loadout.md'));
    return true;
  } catch {
    return false;
  }
}

export async function ensureAndInstall(
  workspaceId: string,
  id: string,
  opts: { source?: string; version?: string; force?: boolean } = {}
): Promise<{ status: 'installed' } | { status: 'needs-confirm'; reason: string }> {
  const present = await presentLocally(id);
  const prov = await provenanceFor(id);

  if (present && !prov && opts.source && !opts.force) {
    // On disk but never downloaded by us ⇒ locally authored. Don't clobber.
    return { status: 'needs-confirm', reason: `"${id}" already exists as a local loadout` };
  }

  // Download when: absent, OR a remote install of a different version than recorded.
  const needsPull =
    !!opts.source && (!present || opts.force || (prov?.version !== undefined && opts.version !== undefined && prov.version !== opts.version));
  if (needsPull && opts.source) {
    await download(opts.source, id, opts.version);
  }

  await installLoadout(workspaceId, id);
  return { status: 'installed' };
}
