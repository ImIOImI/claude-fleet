// Workspace skill discovery: the pure scan behind the list_workspace_skills /
// get_workspace_skill MCP tools. fs + yaml only — root resolution, scope and
// caching live in workspaceSkills.ts.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type SkillKind = 'skill' | 'command';
export type SkillSource = 'project' | 'user';

export interface SkillRoot {
  dir: string;
  kind: SkillKind;
  source: SkillSource;
}

export interface SkillEntry {
  name: string;
  kind: SkillKind;
  source: SkillSource;
  description: string;
  argumentHint?: string;
  /** Host path of the SKILL.md / command file. Never sent over MCP. */
  file: string;
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

const isMissing = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** [fallbackName, file] pairs for one root. Missing root → []. */
async function filesIn(root: SkillRoot): Promise<Array<[string, string]>> {
  if (root.kind === 'skill') {
    const out: Array<[string, string]> = [];
    for (const d of await readdir(root.dir, { withFileTypes: true })) {
      if (d.isDirectory() || d.isSymbolicLink()) out.push([d.name, join(root.dir, d.name, 'SKILL.md')]);
    }
    return out;
  }
  const out: Array<[string, string]> = [];
  const walk = async (dir: string, prefix: string[], depth: number): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.isDirectory() && depth < MAX_COMMAND_DEPTH) await walk(join(dir, d.name), [...prefix, d.name], depth + 1);
      else if (d.isFile() && d.name.endsWith('.md')) out.push([[...prefix, d.name.slice(0, -3)].join(':'), join(dir, d.name)]);
    }
  };
  await walk(root.dir, [], 0);
  return out;
}

/** Scan roots in order; the first entry with a given name wins (project before user). */
export async function scanSkillRoots(roots: SkillRoot[]): Promise<ScanResult> {
  const byName = new Map<string, SkillEntry>();
  const warnings: string[] = [];
  for (const root of roots) {
    let files: Array<[string, string]>;
    try {
      files = await filesIn(root);
    } catch (e) {
      if (!isMissing(e)) warnings.push(`${root.source} ${root.kind}s unreadable: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const [fallback, file] of files) {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (e) {
        if (!isMissing(e)) warnings.push(`${fallback}: unreadable: ${e instanceof Error ? e.message : String(e)}`);
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
        file
      });
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings };
}

export async function readSkillBody(file: string, cap = BODY_CAP): Promise<string> {
  const raw = await readFile(file, 'utf8');
  return raw.length > cap ? `${raw.slice(0, cap)}\n[truncated]` : raw;
}

export function invokeHint(workspaceName: string, e: Pick<SkillEntry, 'name' | 'argumentHint'>): string {
  const args = e.argumentHint ? ` ${e.argumentHint}` : '';
  return `prompt step → workspace: ${workspaceName}, message: "/${e.name}${args}"`;
}
