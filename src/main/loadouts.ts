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
  },
  'loadout-author': {
    'loadout.md': `---
title: Loadout Author
version: 1.0.0
description: Teaches Claude how to write claude-fleet loadouts — the loadout.md format, the convention folders (skills/commands/rules), and scripts/dependencies. Install where you author loadouts.
tags: [skill, authoring, meta]
---
Adds a "writing-loadouts" skill so Claude in this workspace knows the loadout
format and can scaffold new loadouts correctly.`,
    'skills/writing-loadouts/SKILL.md': `---
description: Author a claude-fleet "loadout" — a reusable bundle of skills, rules, slash commands and setup that installs into a workspace. Use when asked to create, write, or scaffold a loadout.
---

# Writing a claude-fleet loadout

A loadout is a folder that claude-fleet installs into a workspace's project
.claude/ directory. It bundles reusable Claude config (skills, slash commands,
subagents, rules, a CLAUDE.md block) plus optional setup (scripts, prompts).
Installing copies its files in; uninstalling removes exactly what it added.

## Folder layout

A loadout is one folder; its name is the loadout id.

    <loadout-id>/
      loadout.md               (required: metadata + instructions)
      CLAUDE.md                (optional: appended to the workspace CLAUDE.md)
      skills/<name>/SKILL.md    (optional)
      commands/<name>.md        (optional)
      agents/<name>.md          (optional)
      rules/<name>.md           (optional)
      output-styles/<name>.md   (optional)
      scripts/                  (optional: referenced from loadout.md)

Everything under skills/, commands/, agents/, rules/, output-styles/ plus a
root CLAUDE.md is copied into the workspace's .claude/ by convention — you do
not list those files anywhere, just put them in the folder. On install they
land at .claude/skills/<name>/SKILL.md, .claude/commands/<name>.md, etc.; the
root CLAUDE.md is appended to the workspace CLAUDE.md inside a marked block.

## loadout.md

YAML frontmatter followed by a markdown body (the body is human- and
agent-readable install instructions).

    ---
    title: Rust Pro
    version: 1.0.0
    description: Idiomatic Rust — clippy discipline, error handling. Use on a Cargo workspace.
    tags: [skill, rules, rust]
    dependencies:
      loadouts:
        - { id: base-dev, version: "^1.0.0" }
      tools:
        - { cmd: cargo, version: ">=1.75" }
    scripts:
      - label: install cargo tools
        run: cargo install cargo-nextest
        unless: command -v cargo-nextest
    prompts:
      - label: index the crate
        send: Read Cargo.toml and src/, then summarize the modules.
    ---

    What this loadout does, in prose.

Frontmatter fields:

- title — display name.
- description — the most important field: how a Claude instance decides whether
  the loadout is relevant. Say what it does AND when to use it.
- tags — for search and filtering in the library.
- version — semver; bump it when the loadout changes.
- dependencies.loadouts — other loadouts to install first (optional semver ranges).
- dependencies.tools — host commands the loadout expects; checked before install.
- scripts — shell commands run at install, inside the container sandbox. Add
  "unless: <check command>" to skip a script when it is already satisfied.
- prompts — messages sent to Claude after install.

## Skills, commands, agents, rules

A skill is skills/<skill-name>/SKILL.md with its own frontmatter:

    ---
    description: When Claude should use this skill.
    ---

    Instructions for the model.

Slash commands go in commands/<name>.md, subagents in agents/<name>.md, rules
in rules/<name>.md — each a markdown file in the format Claude Code expects.

## Rules of thumb

- One capability per loadout; keep it focused.
- Write a precise description — it is the relevance signal.
- The runner container is non-root (no apt / sudo). To provide a runtime, use a
  user-space installer (rustup, uv, nvm) in a scripts entry guarded by "unless".
- Loadouts install into a workspace's project .claude/ and load on the next
  Claude session in that workspace.
- Keep secrets out of loadouts — they are reusable across workspaces.

## A minimal rules-only loadout

    my-conventions/
      loadout.md      (title, description, tags)
      CLAUDE.md       (the rules to append)

No skills or scripts — just a CLAUDE.md block the loadout appends.`
  }
};

/** Seed the built-in starters if the loadouts library doesn't exist yet. */
export async function ensureBuiltinLoadouts(): Promise<void> {
  // Seed per-starter: write a starter only if its folder is absent. This adds
  // newly-shipped starters to existing libraries on next launch, and never
  // clobbers a starter the user has edited (or any other loadout they authored).
  for (const [id, files] of Object.entries(STARTERS)) {
    const dir = loadoutDir(id);
    if (await stat(dir).then(() => true).catch(() => false)) continue;
    for (const [rel, content] of Object.entries(files)) {
      const dest = join(dir, rel);
      await mkdir(join(dest, '..'), { recursive: true });
      await writeFile(dest, content, 'utf8');
    }
  }
}
