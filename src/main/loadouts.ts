// Loadout library (#16-followup): the electron-aware wrapper around the pure
// loadoutCore. Resolves on-disk locations (loadoutsRoot, fleetPrivateDir),
// reads/writes the workspace manifest's installedLoadouts, and seeds the
// built-in starters. v1 installs are CONTAINER-ONLY — a local workspace runs in
// the user's real repo, so we won't write loadout files there.

import { readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadoutsRoot, loadoutDir } from './paths.js';
import { fleetPrivateDir } from './config.js';
import {
  readWorkspaceManifest,
  writeWorkspaceManifest,
  type InstalledLoadout
} from './workspaces.js';
import {
  parseLoadout,
  applyLoadoutFiles,
  revertLoadoutFiles,
  loadoutFileList,
  type LoadoutMeta
} from './loadoutCore.js';

export type LoadoutSummary = Pick<LoadoutMeta, 'id' | 'title' | 'description' | 'tags'>;
/** Full loadout for the review modal: metadata + the files it would write. */
export type LoadoutDetail = LoadoutMeta & { files: string[] };

/** All authored loadouts (metadata only). Folders without a loadout.md are skipped. */
export async function listLoadouts(): Promise<LoadoutSummary[]> {
  let entries;
  try {
    entries = await readdir(loadoutsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LoadoutSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const m = await parseLoadout(loadoutDir(e.name));
      out.push({ id: m.id, title: m.title, description: m.description, tags: m.tags });
    } catch {
      /* not a loadout (no loadout.md) — skip */
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Full manifest + file list for one loadout (review modal + MCP get_loadout). */
export async function getLoadout(id: string): Promise<LoadoutDetail> {
  const dir = loadoutDir(id);
  const meta = await parseLoadout(dir);
  return { ...meta, files: await loadoutFileList(dir) };
}

export interface InstallResult {
  installed: InstalledLoadout;
  /** Files skipped because they already existed in the workspace (reported, not clobbered). */
  skipped: string[];
}

/** Install a loadout into a container workspace's private folder. */
export async function installLoadout(workspaceId: string, loadoutId: string): Promise<InstallResult> {
  const ws = await readWorkspaceManifest(workspaceId);
  if (!ws) throw new Error(`no workspace ${workspaceId}`);
  if (ws.kind === 'local') {
    throw new Error('Loadouts can only be installed into container workspaces (local runs in your own repo).');
  }
  const meta = await getLoadout(loadoutId);
  const target = await fleetPrivateDir(workspaceId);
  const applied = await applyLoadoutFiles(loadoutDir(loadoutId), target, loadoutId);
  const record: InstalledLoadout = {
    id: loadoutId,
    title: meta.title,
    files: applied.files,
    merges: { claudeMd: applied.claudeMd },
    installedAt: Date.now()
  };
  const others = (ws.installedLoadouts ?? []).filter((l) => l.id !== loadoutId);
  await writeWorkspaceManifest({ ...ws, installedLoadouts: [...others, record] });
  return { installed: record, skipped: applied.skipped };
}

/** Uninstall: remove exactly what was applied, keep anything else. */
export async function uninstallLoadout(workspaceId: string, loadoutId: string): Promise<void> {
  const ws = await readWorkspaceManifest(workspaceId);
  if (!ws) return;
  const rec = (ws.installedLoadouts ?? []).find((l) => l.id === loadoutId);
  if (rec) {
    const target = await fleetPrivateDir(workspaceId);
    await revertLoadoutFiles(target, { files: rec.files, claudeMd: rec.merges?.claudeMd }, loadoutId);
  }
  await writeWorkspaceManifest({
    ...ws,
    installedLoadouts: (ws.installedLoadouts ?? []).filter((l) => l.id !== loadoutId)
  });
}

// ── Built-in starters ────────────────────────────────────────────────────────
// Seeded once if the library is empty, so the feature isn't a blank shelf on
// first run. Kept to drop + CLAUDE.md (PR1-applicable; no scripts).

const STARTERS: Record<string, Record<string, string>> = {
  'spec-driven': {
    'loadout.md': `---
title: Spec-Driven Dev
description: Keep a docs/SPEC.md in sync with every decision-bearing change. Use on projects with a living spec.
tags: [rules, workflow]
---
Appends a CLAUDE.md rule that the spec is the source of truth and must be updated in the same change as any decision worth recording.`,
    'CLAUDE.md': `## Spec-driven development

\`docs/SPEC.md\` is the single source of truth. Update it in the SAME change as any
decision worth recording (a new runtime piece, an API/data-model change, a
user-flow or security-model change, a non-goal). Edit in place — describe the
current state, not the history.`
  },
  'conventional-commits': {
    'loadout.md': `---
title: Conventional Commits
description: Enforce the Conventional Commits message format and add a /commit helper. Use on any git repo.
tags: [rules, git]
---
Adds a CLAUDE.md rule for the Conventional Commits format plus a \`/commit\` slash command that drafts a compliant message.`,
    'CLAUDE.md': `## Commit messages

Use Conventional Commits: \`<type>(<scope>): <subject>\` where type is one of
feat, fix, docs, refactor, test, chore. Subject in imperative mood, no trailing
period, <= 72 chars.`,
    'commands/commit.md': `---
description: Draft a Conventional Commits message for the staged changes.
---
Review the staged diff and write a Conventional Commits message
(\`<type>(<scope>): <subject>\`) with a concise body explaining the why.`
  }
};

/** Seed the built-in starters if the loadouts library doesn't exist yet. */
export async function ensureBuiltinLoadouts(): Promise<void> {
  const root = loadoutsRoot();
  // Only seed when the library is absent — once it exists the user owns it.
  if (await stat(root).then(() => true).catch(() => false)) return;
  for (const [id, files] of Object.entries(STARTERS)) {
    for (const [rel, content] of Object.entries(files)) {
      const dest = join(loadoutDir(id), rel);
      await mkdir(join(dest, '..'), { recursive: true });
      await writeFile(dest, content, 'utf8');
    }
  }
}
