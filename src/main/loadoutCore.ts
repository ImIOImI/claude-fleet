// Pure core for the loadout engine (#16-followup): parse a loadout folder and
// apply/revert its files to a workspace directory. No electron/config imports
// (only node fs/path + the `yaml` parser), so it loads under vitest — the
// electron-aware resolution (loadoutsRoot, fleetPrivateDir, manifest) lives in
// loadouts.ts.
//
// A loadout folder mirrors the `.claude/` tree by convention: anything under
// skills/ commands/ agents/ rules/ output-styles/ drops into the workspace's
// `.claude/<same>`, and a root CLAUDE.md is appended as a marked block. (The
// merge layer — settings.json/.mcp.json/hooks — and the run layer —
// scripts/prompts — arrive in PR2; their frontmatter is parsed here already.)

import { readFile, writeFile, copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join, dirname, relative, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Directories under a loadout that drop verbatim into the workspace .claude/. */
export const DROP_DIRS = ['skills', 'commands', 'agents', 'rules', 'output-styles'] as const;

export interface LoadoutScript {
  label: string;
  run?: string;
  file?: string;
}
export interface LoadoutPrompt {
  label: string;
  send?: string;
  file?: string;
}
export interface LoadoutMeta {
  id: string;
  title: string;
  description: string;
  tags: string[];
  dependencies?: { loadouts?: string[]; tools?: string[] };
  /** Parsed but applied in PR2 (the run layer). */
  scripts?: LoadoutScript[];
  prompts?: LoadoutPrompt[];
  /** The markdown body of loadout.md — human/agent-readable install instructions. */
  instructions: string;
}

/** Tracking record returned by applyLoadoutFiles → recorded in the manifest. */
export interface AppliedRecord {
  /** Workspace-relative paths dropped (deleted on uninstall). */
  files: string[];
  /** Whether a marked CLAUDE.md block was appended. */
  claudeMd: boolean;
  /** Files skipped because they already existed (never clobbered). */
  skipped: string[];
}

function blockStart(id: string): string {
  return `<!-- loadout:${id} start -->`;
}
function blockEnd(id: string): string {
  return `<!-- loadout:${id} end -->`;
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove this loadout's marked block (and the surrounding blank lines) from text. */
export function stripBlock(text: string, id: string): string {
  const re = new RegExp(`\\n*${escapeRe(blockStart(id))}[\\s\\S]*?${escapeRe(blockEnd(id))}\\n*`, 'g');
  return text.replace(re, '\n');
}

function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return m ? { fm: m[1], body: m[2] } : { fm: '', body: raw };
}

async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    // readFile throws on dirs too; use a cheaper stat-like check via readdir fallback
    try {
      await readdir(p);
      return true;
    } catch {
      return false;
    }
  }
}

async function listFilesRec(dir: string, base = dir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFilesRec(full, base)));
    else if (e.isFile()) out.push(relative(base, full));
  }
  return out;
}

/**
 * Parse a loadout folder's `loadout.md`. `id` defaults to the folder name (the
 * stable identity). Tolerant: missing/!string fields fall back to safe defaults.
 */
export async function parseLoadout(dir: string, id = basename(dir)): Promise<LoadoutMeta> {
  const raw = await readFile(join(dir, 'loadout.md'), 'utf8');
  const { fm, body } = splitFrontmatter(raw);
  const data = (fm ? (parseYaml(fm) as Record<string, unknown> | null) : null) ?? {};
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    id,
    title: typeof data.title === 'string' ? data.title : id,
    description: typeof data.description === 'string' ? data.description : '',
    tags: strArr(data.tags),
    dependencies:
      data.dependencies && typeof data.dependencies === 'object'
        ? (data.dependencies as LoadoutMeta['dependencies'])
        : undefined,
    scripts: Array.isArray(data.scripts) ? (data.scripts as LoadoutScript[]) : undefined,
    prompts: Array.isArray(data.prompts) ? (data.prompts as LoadoutPrompt[]) : undefined,
    instructions: body.trim()
  };
}

/**
 * The workspace-relative destination paths a loadout would write (for the
 * review's "Files written" list) — derived from the folder by convention,
 * without touching any workspace.
 */
export async function loadoutFileList(srcDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of DROP_DIRS) {
    for (const rel of await listFilesRec(join(srcDir, d))) out.push(join('.claude', d, rel));
  }
  if ((await readFile(join(srcDir, 'CLAUDE.md'), 'utf8').catch(() => null)) !== null) {
    out.push('CLAUDE.md');
  }
  return out;
}

/**
 * Apply a loadout's drop files + CLAUDE.md block into `targetDir` (a workspace's
 * project root — i.e. the container's /workspace). Collision-safe: an existing
 * file that we didn't write is skipped and reported, never overwritten. A prior
 * block for the same id in CLAUDE.md is replaced (reinstall-safe).
 */
export async function applyLoadoutFiles(
  srcDir: string,
  targetDir: string,
  id: string
): Promise<AppliedRecord> {
  const files: string[] = [];
  const skipped: string[] = [];

  for (const d of DROP_DIRS) {
    const rels = await listFilesRec(join(srcDir, d));
    for (const rel of rels) {
      const destRel = join('.claude', d, rel);
      const dest = join(targetDir, destRel);
      if (await exists(dest)) {
        skipped.push(destRel);
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(srcDir, d, rel), dest);
      files.push(destRel);
    }
  }

  let claudeMd = false;
  const cmSrc = join(srcDir, 'CLAUDE.md');
  const cmContent = await readFile(cmSrc, 'utf8').catch(() => null);
  if (cmContent !== null) {
    const targetCm = join(targetDir, 'CLAUDE.md');
    const prior = (await readFile(targetCm, 'utf8').catch(() => '')) as string;
    const base = stripBlock(prior, id).trimEnd();
    const block = `${blockStart(id)}\n${cmContent.trim()}\n${blockEnd(id)}`;
    const next = base ? `${base}\n\n${block}\n` : `${block}\n`;
    await mkdir(dirname(targetCm), { recursive: true });
    await writeFile(targetCm, next, 'utf8');
    claudeMd = true;
  }

  return { files, claudeMd, skipped };
}

// ── Merge layer: settings.json / .mcp.json / hooks (#16-followup) ──────────
// JSON config a loadout blends into the workspace, tracked so uninstall reverts
// exactly what was added. settings.json merges at TOP-LEVEL-KEY granularity
// (add a key only if absent; collisions are skipped + reported — no deep merge
// into an existing key in v1). `.mcp.json` merges named servers. Hooks append
// per-event entries (tracked by value). The loadout's hooks come from a
// dedicated `hooks.json` ({ <event>: [entries] }) and/or settings.json's `hooks`.

export interface MergeRecord {
  settingsKeys: string[];
  mcpServers: string[];
  hooks: { event: string; entry: unknown }[];
  skipped: string[];
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Collect `{ <event>: [entries] }` hook objects into one event→entries map. */
function collectHookEntries(src: unknown, into: Record<string, unknown[]>): void {
  if (!isObj(src)) return;
  for (const [event, entries] of Object.entries(src)) {
    if (Array.isArray(entries)) (into[event] ??= []).push(...entries);
  }
}

/** Merge a loadout's settings.json / .mcp.json / hooks.json into `targetDir`. */
export async function applyLoadoutMerges(srcDir: string, targetDir: string): Promise<MergeRecord> {
  const settingsKeys: string[] = [];
  const mcpServers: string[] = [];
  const hooks: { event: string; entry: unknown }[] = [];
  const skipped: string[] = [];

  const srcSettings = await readJson(join(srcDir, 'settings.json'));
  const hookEntries: Record<string, unknown[]> = {};
  collectHookEntries(await readJson(join(srcDir, 'hooks.json')), hookEntries);
  if (srcSettings) collectHookEntries(srcSettings.hooks, hookEntries);

  const nonHookKeys = srcSettings ? Object.keys(srcSettings).filter((k) => k !== 'hooks') : [];
  if (nonHookKeys.length > 0 || Object.keys(hookEntries).length > 0) {
    const target = join(targetDir, '.claude', 'settings.json');
    const cur = (await readJson(target)) ?? {};
    for (const k of nonHookKeys) {
      if (k in cur) {
        skipped.push(`settings.json:${k}`);
        continue;
      }
      cur[k] = srcSettings![k];
      settingsKeys.push(k);
    }
    if (Object.keys(hookEntries).length > 0) {
      const curHooks = isObj(cur.hooks) ? (cur.hooks as Record<string, unknown[]>) : {};
      for (const [event, entries] of Object.entries(hookEntries)) {
        if (!Array.isArray(curHooks[event])) curHooks[event] = [];
        for (const entry of entries) {
          curHooks[event].push(entry);
          hooks.push({ event, entry });
        }
      }
      cur.hooks = curHooks;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(cur, null, 2) + '\n', 'utf8');
  }

  const srcMcp = await readJson(join(srcDir, '.mcp.json'));
  const srcServers = srcMcp && isObj(srcMcp.mcpServers) ? srcMcp.mcpServers : null;
  if (srcServers && Object.keys(srcServers).length > 0) {
    const target = join(targetDir, '.mcp.json');
    const cur = (await readJson(target)) ?? {};
    const curServers = isObj(cur.mcpServers) ? (cur.mcpServers as Record<string, unknown>) : {};
    for (const [name, def] of Object.entries(srcServers)) {
      if (name in curServers) {
        skipped.push(`.mcp.json:${name}`);
        continue;
      }
      curServers[name] = def;
      mcpServers.push(name);
    }
    cur.mcpServers = curServers;
    await writeFile(target, JSON.stringify(cur, null, 2) + '\n', 'utf8');
  }

  return { settingsKeys, mcpServers, hooks, skipped };
}

/** Reverse applyLoadoutMerges: remove exactly the keys/servers/hook entries added. */
export async function revertLoadoutMerges(
  targetDir: string,
  merges: { settingsKeys?: string[]; mcpServers?: string[]; hooks?: { event: string; entry: unknown }[] }
): Promise<void> {
  if ((merges.settingsKeys?.length ?? 0) > 0 || (merges.hooks?.length ?? 0) > 0) {
    const target = join(targetDir, '.claude', 'settings.json');
    const cur = await readJson(target);
    if (cur) {
      for (const k of merges.settingsKeys ?? []) delete cur[k];
      if ((merges.hooks?.length ?? 0) > 0 && isObj(cur.hooks)) {
        const curHooks = cur.hooks as Record<string, unknown[]>;
        for (const { event, entry } of merges.hooks!) {
          const arr = curHooks[event];
          if (Array.isArray(arr)) {
            const idx = arr.findIndex((e) => JSON.stringify(e) === JSON.stringify(entry));
            if (idx >= 0) arr.splice(idx, 1);
            if (arr.length === 0) delete curHooks[event];
          }
        }
        if (Object.keys(curHooks).length === 0) delete cur.hooks;
      }
      if (Object.keys(cur).length === 0) await rm(target, { force: true });
      else await writeFile(target, JSON.stringify(cur, null, 2) + '\n', 'utf8');
    }
  }

  if ((merges.mcpServers?.length ?? 0) > 0) {
    const target = join(targetDir, '.mcp.json');
    const cur = await readJson(target);
    if (cur && isObj(cur.mcpServers)) {
      const curServers = cur.mcpServers as Record<string, unknown>;
      for (const name of merges.mcpServers!) delete curServers[name];
      if (Object.keys(curServers).length === 0) delete cur.mcpServers;
      if (Object.keys(cur).length === 0) await rm(target, { force: true });
      else await writeFile(target, JSON.stringify(cur, null, 2) + '\n', 'utf8');
    }
  }
}

/** Preview what a loadout would merge (for the review modal). */
export async function loadoutMergePreview(
  srcDir: string
): Promise<{ settingsKeys: string[]; mcpServers: string[]; hookEvents: string[] }> {
  const srcSettings = await readJson(join(srcDir, 'settings.json'));
  const hookEntries: Record<string, unknown[]> = {};
  collectHookEntries(await readJson(join(srcDir, 'hooks.json')), hookEntries);
  if (srcSettings) collectHookEntries(srcSettings.hooks, hookEntries);
  const srcMcp = await readJson(join(srcDir, '.mcp.json'));
  const srcServers = srcMcp && isObj(srcMcp.mcpServers) ? srcMcp.mcpServers : {};
  return {
    settingsKeys: srcSettings ? Object.keys(srcSettings).filter((k) => k !== 'hooks') : [],
    mcpServers: Object.keys(srcServers),
    hookEvents: Object.keys(hookEntries)
  };
}

/** Reverse applyLoadoutFiles: delete the dropped files + strip the CLAUDE.md block. */
export async function revertLoadoutFiles(
  targetDir: string,
  record: { files: string[]; claudeMd?: boolean },
  id: string
): Promise<void> {
  for (const rel of record.files) {
    await rm(join(targetDir, rel), { force: true });
  }
  if (record.claudeMd) {
    const targetCm = join(targetDir, 'CLAUDE.md');
    const prior = await readFile(targetCm, 'utf8').catch(() => null);
    if (prior !== null) {
      const stripped = stripBlock(prior, id).trim();
      if (stripped === '') await rm(targetCm, { force: true });
      else await writeFile(targetCm, stripped + '\n', 'utf8');
    }
  }
}
