// Workspace skill discovery: the pure scan behind the list_workspace_skills /
// get_workspace_skill MCP tools. fs + yaml only — root resolution, scope and
// caching live in workspaceSkills.ts.
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type SkillKind = 'skill' | 'command';
export type SkillSource = 'project' | 'user';

export interface SkillRoot {
  dir: string;
  kind: SkillKind;
  source: SkillSource;
  /** Containment base: every file must realpath-resolve inside realpath(base)
   *  (the project root, or the user .claude dir). SPEC §9. */
  base: string;
}

export interface SkillEntry {
  name: string;
  kind: SkillKind;
  source: SkillSource;
  description: string;
  argumentHint?: string;
  /** Host path of the SKILL.md / command file. Never sent over MCP. */
  file: string;
  /** Containment base of the root it came from. Never sent over MCP. */
  base: string;
}

export interface ScanResult {
  skills: SkillEntry[];
  warnings: string[];
}

export const DESCRIPTION_CAP = 500;
export const BODY_CAP = 20_000;
const MAX_COMMAND_DEPTH = 4;

function splitFrontmatter(raw: string): { fm: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return m ? { fm: m[1], body: m[2] } : { fm: null, body: raw };
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.replace(/^#+\s*/, '');
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function parseSkillFile(
  raw: string,
  fallbackName: string
): { name: string; description: string; argumentHint?: string; error?: string } {
  const { fm, body } = splitFrontmatter(raw);
  let meta: Record<string, unknown> = {};
  let error: string | undefined;
  if (fm !== null) {
    try {
      const parsed = parseYaml(fm) as unknown;
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch (e) {
      error = `bad frontmatter: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
    }
  }
  const argumentHint = str(meta['argument-hint']);
  return {
    name: str(meta.name) ?? fallbackName,
    description: (str(meta.description) ?? firstLine(body)).slice(0, DESCRIPTION_CAP),
    ...(argumentHint ? { argumentHint } : {}),
    ...(error ? { error } : {})
  };
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;
const isMissing = (e: unknown) => {
  const code = errCode(e);
  return code === 'ENOENT' || code === 'ENOTDIR';
};
/** A path-free description of an fs error: these strings reach MCP callers,
 *  and Node's messages embed absolute host paths. */
const errText = (e: unknown): string =>
  e instanceof OutsideError ? e.message : errCode(e) ?? (e instanceof Error && !/[\\/]/.test(e.message) ? e.message : 'error');

const OUTSIDE_MSG = 'skill file resolves outside the workspace';
class OutsideError extends Error {
  constructor() {
    super(OUTSIDE_MSG);
  }
}

/** True when `real` is `realBase` or below it. path.relative semantics, so
 *  win32 (case-insensitive, UNC, cross-drive → absolute) is handled by the
 *  platform's own path module. Both sides must already be realpath'd. */
export function isInside(realBase: string, real: string): boolean {
  const rel = relative(realBase, real);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** O_NONBLOCK so a FIFO planted as SKILL.md can't park a threadpool thread in
 *  open(); it's undefined (→ 0) on Windows. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * Read `file` only if it resolves inside `realBase` — TOCTOU-safe: open first
 * (following links), THEN realpath the name and require the realpath'd inode
 * to be the very inode we hold open. Swapping the path for an escaping
 * symlink before the open fails the containment check; swapping it after the
 * open fails the dev/ino match. Content always comes from the checked fd.
 */
async function readContained(file: string, realBase: string): Promise<string> {
  const fh = await open(file, OPEN_FLAGS);
  try {
    const held = await fh.stat({ bigint: true });
    const real = await realpath(file);
    if (!isInside(realBase, real)) throw new OutsideError();
    const named = await stat(real, { bigint: true });
    if (named.dev !== held.dev || named.ino !== held.ino) throw new OutsideError();
    if (!held.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' });
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

/** [fallbackName, file] pairs for one (already realpath'd) root dir. */
async function filesIn(root: SkillRoot, dir: string): Promise<Array<[string, string]>> {
  if (root.kind === 'skill') {
    const out: Array<[string, string]> = [];
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.isDirectory() || d.isSymbolicLink()) out.push([d.name, join(dir, d.name, 'SKILL.md')]);
    }
    return out;
  }
  const out: Array<[string, string]> = [];
  const walk = async (sub: string, prefix: string[], depth: number): Promise<void> => {
    for (const d of await readdir(sub, { withFileTypes: true })) {
      if (d.isDirectory() && depth < MAX_COMMAND_DEPTH) await walk(join(sub, d.name), [...prefix, d.name], depth + 1);
      else if (d.isFile() && d.name.endsWith('.md')) out.push([[...prefix, d.name.slice(0, -3)].join(':'), join(sub, d.name)]);
    }
  };
  await walk(dir, [], 0);
  return out;
}

/**
 * Scan roots in order; the first entry with a given name wins (project skills
 * > project commands > user skills). Containment (SPEC §9): the root dir and
 * every file must realpath-resolve inside realpath(root.base) — a workspace
 * can write its own `.claude/**`, so a symlink there must never make the HOST
 * read another workspace's files. Escapes are skipped with a path-free warning.
 */
export async function scanSkillRoots(roots: SkillRoot[]): Promise<ScanResult> {
  const byName = new Map<string, SkillEntry>();
  const warnings: string[] = [];
  const realBases = new Map<string, Promise<string>>();
  for (const root of roots) {
    const label = `${root.source} ${root.kind}s`;
    let files: Array<[string, string]>;
    let realBase: string;
    try {
      if (!realBases.has(root.base)) realBases.set(root.base, realpath(root.base));
      realBase = await realBases.get(root.base)!;
      const realDir = await realpath(root.dir);
      if (!isInside(realBase, realDir)) {
        warnings.push(`${label}: skipped (resolves outside the workspace)`);
        continue;
      }
      files = await filesIn(root, realDir);
    } catch (e) {
      if (!isMissing(e)) warnings.push(`${label} unreadable: ${errText(e)}`);
      continue;
    }
    for (const [fallback, file] of files) {
      let raw: string;
      try {
        raw = await readContained(file, realBase);
      } catch (e) {
        if (e instanceof OutsideError) warnings.push(`${fallback}: skipped (resolves outside the workspace)`);
        else if (!isMissing(e)) warnings.push(`${fallback}: unreadable: ${errText(e)}`);
        continue;
      }
      const p = parseSkillFile(raw, fallback);
      if (p.error) warnings.push(`${fallback}: ${p.error}`);
      if (byName.has(p.name)) continue;
      byName.set(p.name, {
        name: p.name,
        kind: root.kind,
        source: root.source,
        description: p.description,
        ...(p.argumentHint ? { argumentHint: p.argumentHint } : {}),
        file,
        base: root.base
      });
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings };
}

/**
 * Read a skill body for get_workspace_skill. Re-checks containment at read
 * time (scans are cached for 30 s, so the file may have been swapped for an
 * escaping symlink since). Errors are path-free: `skill file resolves outside
 * the workspace`, or `skill body unreadable: <code>`.
 */
export async function readSkillBody(file: string, base: string, cap = BODY_CAP): Promise<string> {
  let raw: string;
  try {
    raw = await readContained(file, await realpath(base));
  } catch (e) {
    if (e instanceof OutsideError) throw new Error(OUTSIDE_MSG);
    throw new Error(`skill body unreadable: ${errText(e)}`);
  }
  return raw.length > cap ? `${raw.slice(0, cap)}\n[truncated]` : raw;
}

export function invokeHint(workspaceName: string, e: Pick<SkillEntry, 'name' | 'argumentHint'>): string {
  const args = e.argumentHint ? ` ${e.argumentHint}` : '';
  return `prompt step → workspace: ${workspaceName}, message: "/${e.name}${args}"`;
}
