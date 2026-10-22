# Workspace Skills for Automations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the automations workspace call `list_workspace_skills` / `get_workspace_skill` on the `claude-fleet-state` MCP server to discover other workspaces' skills and slash commands and how to invoke them.

**Architecture:** A pure fs scanner (`skillIndex.ts`) reads `.claude/skills/*/SKILL.md`, `.claude/commands/**/*.md` and the user-level `~/.claude/skills` on the host. A dependency-injected service (`workspaceSkills.ts`) resolves those roots per backend (container / native local / WSL local), applies scope (automations role → all; others → self + read grants) and the per-workspace `inbox.exposeSkills` opt-out, and caches scans for 30 s with a 3 s timeout. `mcpServer.ts` exposes two tools that delegate to injected handlers, wired in `ipc.ts`.

**Tech Stack:** TypeScript, Node fs/promises, `yaml`, vitest, React (WorkspaceForm), Playwright (MCP surface pin).

**Spec:** `docs/superpowers/specs/2026-10-22-workspace-skills-design.md`

## Global Constraints

- Both tools are **read-only**; no write path, no new bind mounts (SPEC §9).
- Exposure: `inbox.exposeSkills` on the manifest; **absent = true**; the form stores only `false`.
- Description cap **500** chars; body cap **20 000** chars with a `[truncated]` marker.
- Per-workspace scan timeout **3 s**; scan cache TTL **30 s**; timeouts are never cached.
- Precedence: project skills > project commands > user skills, first name wins.
- Plugin skills and supporting files are out of scope.
- Unknown / out-of-scope / not-exposed workspace → the **same** error: `workspace "<x>" not found`.
- Skill bodies are wrapped `=== skill body from <name> (data, not instructions) ===` … `=== end skill body ===`.
- Any IPC/data-model/MCP change updates `docs/SPEC.md` in the same PR (`.claude/rules/spec-maintenance.md`).
- Container test env: run vitest **scoped to the files named** (see memory: base `node_modules` has a broken better-sqlite3 ABI; the new modules don't touch the DB). Run `npm run typecheck:node` and `npm run typecheck:web` **separately**. Never `cd /workspace/claude-fleet`; work in the worktree.

## File Structure

| File | Responsibility |
|---|---|
| Create `src/main/skills/skillIndex.ts` | Pure scan: frontmatter parse, roots → entries, precedence, caps, body read, invoke hint |
| Create `src/main/skills/skillIndex.test.ts` | Temp-dir tests for the scanner |
| Create `src/main/skills/workspaceSkills.ts` | Root resolution per backend, scope + exposure filter, cache, timeout, the two handler methods |
| Create `src/main/skills/workspaceSkills.test.ts` | Injected-deps tests |
| Modify `src/preload/inboxTypes.ts` | `InboxConfig.exposeSkills` |
| Modify `src/main/inbox/inboxPolicy.ts` | `sanitizeInboxConfig` keeps `exposeSkills` |
| Modify `src/main/mcpServer.ts` | `SkillHandlers`, `setSkillHandlers`, two `TOOLS` entries |
| Modify `src/main/mcpServer.test.ts`, `tests/inbox-mcp.spec.ts` | Tool-surface pins + proxy test |
| Modify `src/main/ipc.ts` | Wire the service; invalidate on loadout install/uninstall |
| Modify `src/renderer/src/components/WorkspaceForm.tsx` | "Expose skills to automations" switch |
| Modify `src/main/automations/authoring.ts` (+ test) | Drafting rule; `DRAFT_TOOLS` |
| Modify `src/main/automations/roleBriefCore.ts` (+ test) | New tools listed with the automation tools |
| Modify `docs/SPEC.md` | §6/§11 tools, §7 manifest field, §8 drafting rule, §9 note |

---

### Task 1: Pure skill scanner

**Files:**
- Create: `src/main/skills/skillIndex.ts`
- Test: `src/main/skills/skillIndex.test.ts`

**Interfaces:**
- Produces:
  - `type SkillKind = 'skill' | 'command'`, `type SkillSource = 'project' | 'user'`
  - `interface SkillRoot { dir: string; kind: SkillKind; source: SkillSource }`
  - `interface SkillEntry { name: string; kind: SkillKind; source: SkillSource; description: string; argumentHint?: string; file: string }` (`file` = host path, never sent over MCP)
  - `interface ScanResult { skills: SkillEntry[]; warnings: string[] }`
  - `const DESCRIPTION_CAP = 500`, `const BODY_CAP = 20_000`
  - `parseSkillFile(raw: string, fallbackName: string): { name: string; description: string; argumentHint?: string; error?: string }`
  - `scanSkillRoots(roots: SkillRoot[]): Promise<ScanResult>`
  - `readSkillBody(file: string, cap?: number): Promise<string>`
  - `invokeHint(workspaceName: string, e: Pick<SkillEntry, 'name' | 'argumentHint'>): string`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/skills/skillIndex.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BODY_CAP, DESCRIPTION_CAP, invokeHint, parseSkillFile, readSkillBody, scanSkillRoots, type SkillRoot } from './skillIndex.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'skills-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, text: string): string {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
}
const roots = (): SkillRoot[] => [
  { dir: join(root, 'proj/.claude/skills'), kind: 'skill', source: 'project' },
  { dir: join(root, 'proj/.claude/commands'), kind: 'command', source: 'project' },
  { dir: join(root, 'home/.claude/skills'), kind: 'skill', source: 'user' }
];

describe('parseSkillFile', () => {
  it('reads name, description and argument-hint from frontmatter', () => {
    const r = parseSkillFile('---\nname: triage\ndescription: Triage alerts.\nargument-hint: <since>\n---\nBody', 'dir');
    expect(r).toEqual({ name: 'triage', description: 'Triage alerts.', argumentHint: '<since>' });
  });
  it('falls back to the path name and the first non-empty body line', () => {
    const r = parseSkillFile('\n# Deploy check\n\nmore', 'deploy-check');
    expect(r).toEqual({ name: 'deploy-check', description: 'Deploy check' });
  });
  it('keeps the entry with an error on bad YAML', () => {
    const r = parseSkillFile('---\nname: [oops\n---\nUse me', 'x');
    expect(r.name).toBe('x');
    expect(r.description).toBe('Use me');
    expect(r.error).toMatch(/frontmatter/);
  });
  it('caps the description', () => {
    const r = parseSkillFile(`---\ndescription: ${'a'.repeat(900)}\n---\n`, 'x');
    expect(r.description.length).toBe(DESCRIPTION_CAP);
  });
});

describe('scanSkillRoots', () => {
  it('finds skills, commands (nested as ns:name) and user skills, sorted by name', async () => {
    put('proj/.claude/skills/triage/SKILL.md', '---\ndescription: Triage.\n---\n');
    put('proj/.claude/commands/ship.md', 'Ship it.');
    put('proj/.claude/commands/ops/restart.md', '---\ndescription: Restart.\nargument-hint: <svc>\n---\n');
    put('home/.claude/skills/notes/SKILL.md', '---\nname: notes\ndescription: Notes.\n---\n');
    const r = await scanSkillRoots(roots());
    expect(r.warnings).toEqual([]);
    expect(r.skills.map((s) => [s.name, s.kind, s.source])).toEqual([
      ['notes', 'skill', 'user'],
      ['ops:restart', 'command', 'project'],
      ['ship', 'command', 'project'],
      ['triage', 'skill', 'project']
    ]);
    expect(r.skills.find((s) => s.name === 'ops:restart')!.argumentHint).toBe('<svc>');
  });
  it('lets project shadow user on a name clash', async () => {
    put('proj/.claude/skills/notes/SKILL.md', '---\ndescription: Project notes.\n---\n');
    put('home/.claude/skills/notes/SKILL.md', '---\ndescription: User notes.\n---\n');
    const r = await scanSkillRoots(roots());
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]).toMatchObject({ name: 'notes', source: 'project', description: 'Project notes.' });
  });
  it('treats missing roots and skill dirs without SKILL.md as empty', async () => {
    mkdirSync(join(root, 'proj/.claude/skills/empty'), { recursive: true });
    expect(await scanSkillRoots(roots())).toEqual({ skills: [], warnings: [] });
  });
  it('warns on bad frontmatter but keeps the entry', async () => {
    put('proj/.claude/skills/bad/SKILL.md', '---\nname: [oops\n---\nStill useful');
    const r = await scanSkillRoots(roots());
    expect(r.skills.map((s) => s.name)).toEqual(['bad']);
    expect(r.warnings[0]).toMatch(/bad.*frontmatter/);
  });
});

describe('readSkillBody / invokeHint', () => {
  it('returns the whole file, truncating past the cap', async () => {
    const small = put('a.md', '---\nname: a\n---\nhello');
    expect(await readSkillBody(small)).toBe('---\nname: a\n---\nhello');
    const big = put('b.md', 'x'.repeat(BODY_CAP + 10));
    const body = await readSkillBody(big);
    expect(body.endsWith('\n[truncated]')).toBe(true);
    expect(body.length).toBe(BODY_CAP + '\n[truncated]'.length);
  });
  it('builds a prompt-step invocation line', () => {
    expect(invokeHint('ops-oncall', { name: 'triage', argumentHint: '<since>' }))
      .toBe('prompt step → workspace: ops-oncall, message: "/triage <since>"');
    expect(invokeHint('ops', { name: 'ship' })).toBe('prompt step → workspace: ops, message: "/ship"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/skills/skillIndex.test.ts`
Expected: FAIL — `Cannot find module './skillIndex.js'`.

- [ ] **Step 3: Implement**

```ts
// src/main/skills/skillIndex.ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/skills/skillIndex.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/skills/skillIndex.ts src/main/skills/skillIndex.test.ts
git commit -m "feat(skills): pure scanner for workspace skills and commands"
```

---

### Task 2: Workspace skills service + `inbox.exposeSkills`

**Files:**
- Create: `src/main/skills/workspaceSkills.ts`
- Test: `src/main/skills/workspaceSkills.test.ts`
- Modify: `src/preload/inboxTypes.ts` (`InboxConfig`, ~line 98–108)
- Modify: `src/main/inbox/inboxPolicy.ts:42-53` (`sanitizeInboxConfig`)
- Test: the existing `inboxPolicy` test file (`src/main/inbox/inboxPolicy.test.ts`; if absent, add the case to `workspaceSkills.test.ts` as written below)

**Interfaces:**
- Consumes (Task 1): `scanSkillRoots`, `readSkillBody`, `invokeHint`, `SkillRoot`, `ScanResult`, `SkillEntry`.
- Produces:
  - `interface SkillWorkspace { id: string; name: string; kind: 'container' | 'local'; projectRoot: string; userClaudeDir: string; exposed: boolean; role?: 'automations' }`
  - `toSkillWorkspace(spec: SkillSpec, p: { privateDir: string; containerClaudeDir: string; homedir: string }): SkillWorkspace` where `SkillSpec = Pick<WorkspaceSpec, 'id' | 'name' | 'kind' | 'workspaceRoot' | 'launcher' | 'inbox' | 'role'>`
  - `skillRootsFor(ws: SkillWorkspace): SkillRoot[]`
  - `createWorkspaceSkills(deps: WorkspaceSkillsDeps): WorkspaceSkillsService`
  - `interface WorkspaceSkillsDeps { listWorkspaces(): Promise<SkillWorkspace[]>; scan?: (roots: SkillRoot[]) => Promise<ScanResult>; now?: () => number; timeoutMs?: number; ttlMs?: number }`
  - `interface WorkspaceSkillsService { list(callerId: string, allowed: Set<string>, args: Record<string, unknown>): Promise<WorkspaceSkillsResult[]>; get(callerId: string, allowed: Set<string>, args: Record<string, unknown>): Promise<SkillDetail>; invalidate(id: string): void }`
  - `InboxConfig.exposeSkills?: boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/skills/workspaceSkills.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSkills, skillRootsFor, toSkillWorkspace, type SkillWorkspace } from './workspaceSkills.js';
import { sanitizeInboxConfig } from '../inbox/inboxPolicy.js';

const P = { privateDir: '/fleet/W1', containerClaudeDir: '/ud/state/W1/.claude', homedir: '/home/me' };

describe('toSkillWorkspace', () => {
  it('container: private dir + per-workspace .claude; exposed by default', () => {
    const ws = toSkillWorkspace({ id: 'W1', name: 'ops', kind: 'container', workspaceRoot: '/x' }, P);
    expect(ws).toEqual({ id: 'W1', name: 'ops', kind: 'container', projectRoot: '/fleet/W1', userClaudeDir: '/ud/state/W1/.claude', exposed: true });
  });
  it('native local: workspaceRoot + host ~/.claude', () => {
    const ws = toSkillWorkspace({ id: 'L1', name: 'repo', kind: 'local', workspaceRoot: '/src/repo', inbox: { exposeSkills: false } }, P);
    expect(ws).toMatchObject({ kind: 'local', projectRoot: '/src/repo', userClaudeDir: join('/home/me', '.claude'), exposed: false });
  });
  it('WSL local: the distro home over \\\\wsl.localhost', () => {
    const ws = toSkillWorkspace({
      id: 'L2', name: 'wsl', kind: 'local', workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\t\\repo',
      launcher: { mode: 'wsl', distro: 'Ubuntu', shell: '/bin/bash', home: '/home/t', claudePath: '/usr/bin/claude' }
    }, P);
    expect(ws.userClaudeDir).toBe('\\\\wsl.localhost\\Ubuntu\\home\\t\\.claude');
    expect(ws.projectRoot).toBe('\\\\wsl.localhost\\Ubuntu\\home\\t\\repo');
  });
  it('carries the automations role', () => {
    expect(toSkillWorkspace({ id: 'A', name: 'auto', kind: 'container', workspaceRoot: '/x', role: 'automations' }, P).role).toBe('automations');
  });
});

describe('sanitizeInboxConfig keeps exposeSkills', () => {
  it('round-trips a boolean and drops garbage', () => {
    expect(sanitizeInboxConfig({ exposeSkills: false })).toEqual({ exposeSkills: false });
    expect(sanitizeInboxConfig({ exposeSkills: 'no' })).toBeUndefined();
  });
});

describe('createWorkspaceSkills', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wsk-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ws = (id: string, extra: Partial<SkillWorkspace> = {}): SkillWorkspace => ({
    id, name: id.toLowerCase(), kind: 'container',
    projectRoot: join(root, id), userClaudeDir: join(root, id, 'home'), exposed: true, ...extra
  });
  function skill(id: string, name: string, desc: string): void {
    const d = join(root, id, '.claude', 'skills', name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), `---\ndescription: ${desc}\n---\nSteps for ${name}.`);
  }

  it('skillRootsFor orders project skills, project commands, user skills', () => {
    expect(skillRootsFor(ws('A')).map((r) => [r.kind, r.source])).toEqual([['skill', 'project'], ['command', 'project'], ['skill', 'user']]);
  });

  it('automations role sees every exposed workspace; others only their allowed set', async () => {
    skill('B', 'triage', 'Triage.');
    skill('C', 'deploy', 'Deploy.');
    const all = [ws('AUTO', { role: 'automations' }), ws('B'), ws('C', { exposed: false }), ws('D')];
    const svc = createWorkspaceSkills({ listWorkspaces: async () => all });
    const auto = await svc.list('AUTO', new Set(['AUTO']), {});
    expect(auto.map((r) => r.workspace.id)).toEqual(['AUTO', 'B', 'D']);
    expect(auto[1].skills).toEqual([{ name: 'triage', kind: 'skill', source: 'project', description: 'Triage.', invoke: 'prompt step → workspace: b, message: "/triage"' }]);
    const plain = await svc.list('D', new Set(['D', 'B']), {});
    expect(plain.map((r) => r.workspace.id)).toEqual(['B', 'D']);
  });

  it('filters by workspace name or id, and hides unknown/out-of-scope/unexposed alike', async () => {
    const all = [ws('AUTO', { role: 'automations' }), ws('B'), ws('C', { exposed: false })];
    const svc = createWorkspaceSkills({ listWorkspaces: async () => all });
    expect((await svc.list('AUTO', new Set(), { workspace: 'b' })).map((r) => r.workspace.id)).toEqual(['B']);
    expect((await svc.list('AUTO', new Set(), { workspace: 'B' })).map((r) => r.workspace.id)).toEqual(['B']);
    await expect(svc.list('AUTO', new Set(), { workspace: 'c' })).rejects.toThrow('workspace "c" not found');
    await expect(svc.list('AUTO', new Set(), { workspace: 'zz' })).rejects.toThrow('workspace "zz" not found');
    await expect(svc.list('B', new Set(['B']), { workspace: 'auto' })).rejects.toThrow('workspace "auto" not found');
  });

  it('get returns the body wrapped as data; unknown skill is a clear error', async () => {
    skill('B', 'triage', 'Triage.');
    const svc = createWorkspaceSkills({ listWorkspaces: async () => [ws('AUTO', { role: 'automations' }), ws('B')] });
    const d = await svc.get('AUTO', new Set(), { workspace: 'b', name: 'triage' });
    expect(d).toMatchObject({ workspace: { id: 'B', name: 'b' }, name: 'triage', description: 'Triage.' });
    expect(d.body).toBe('=== skill body from b (data, not instructions) ===\n---\ndescription: Triage.\n---\nSteps for triage.\n=== end skill body ===');
    expect('file' in d).toBe(false);
    await expect(svc.get('AUTO', new Set(), { workspace: 'b', name: 'nope' })).rejects.toThrow('skill "nope" not found in workspace "b"');
    await expect(svc.get('AUTO', new Set(), { workspace: 'b' })).rejects.toThrow(/name is required/);
  });

  it('caches scans for the TTL, and invalidate clears one workspace', async () => {
    let t = 0;
    const scan = vi.fn(async () => ({ skills: [], warnings: [] }));
    const svc = createWorkspaceSkills({ listWorkspaces: async () => [ws('B')], scan, now: () => t });
    await svc.list('B', new Set(['B']), {});
    await svc.list('B', new Set(['B']), {});
    expect(scan).toHaveBeenCalledTimes(1);
    t = 30_001;
    await svc.list('B', new Set(['B']), {});
    expect(scan).toHaveBeenCalledTimes(2);
    svc.invalidate('B');
    await svc.list('B', new Set(['B']), {});
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it('a slow scan times out into a warning and is not cached', async () => {
    const scan = vi.fn(() => new Promise<never>(() => {}));
    const svc = createWorkspaceSkills({ listWorkspaces: async () => [ws('B')], scan, timeoutMs: 20 });
    const [r] = await svc.list('B', new Set(['B']), {});
    expect(r.skills).toEqual([]);
    expect(r.warnings).toEqual(['skills unreadable: timed out after 20ms']);
    await svc.list('B', new Set(['B']), {});
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/skills/workspaceSkills.test.ts`
Expected: FAIL — `Cannot find module './workspaceSkills.js'`.

- [ ] **Step 3: Add `exposeSkills` to `InboxConfig` and the sanitizer**

In `src/preload/inboxTypes.ts`, inside `interface InboxConfig` after `trusted?: boolean;`:

```ts
  /** Let automations list this workspace's skills (list_workspace_skills). Default true. */
  exposeSkills?: boolean;
```

In `src/main/inbox/inboxPolicy.ts` `sanitizeInboxConfig`, after the `trusted` line:

```ts
  if (typeof o.exposeSkills === 'boolean') out.exposeSkills = o.exposeSkills;
```

- [ ] **Step 4: Implement the service**

```ts
// src/main/skills/workspaceSkills.ts
// Host side of list_workspace_skills / get_workspace_skill: resolves each
// workspace's skill roots (container / native local / WSL local), applies the
// read scope and the inbox.exposeSkills opt-out, and caches scans. Manifests
// are re-read on every call (deps.listWorkspaces), so scope and exposure are
// always current; only the folder scan is cached.
import { join } from 'node:path';
import type { WorkspaceSpec } from '../workspaces.js';
import { linuxPathToUnc } from '../localLauncher.js';
import { invokeHint, readSkillBody, scanSkillRoots, type ScanResult, type SkillEntry, type SkillRoot } from './skillIndex.js';

export interface SkillWorkspace {
  id: string;
  name: string;
  kind: 'container' | 'local';
  projectRoot: string;
  userClaudeDir: string;
  exposed: boolean;
  role?: 'automations';
}

type SkillSpec = Pick<WorkspaceSpec, 'id' | 'name' | 'kind' | 'workspaceRoot'> &
  Partial<Pick<WorkspaceSpec, 'launcher' | 'inbox' | 'role'>>;

export function toSkillWorkspace(
  spec: SkillSpec,
  p: { privateDir: string; containerClaudeDir: string; homedir: string }
): SkillWorkspace {
  const base = {
    id: spec.id,
    name: spec.name,
    exposed: spec.inbox?.exposeSkills !== false,
    ...(spec.role ? { role: spec.role } : {})
  };
  if (spec.kind !== 'local') {
    return { ...base, kind: 'container', projectRoot: p.privateDir, userClaudeDir: p.containerClaudeDir };
  }
  const l = spec.launcher;
  const userClaudeDir =
    l?.mode === 'wsl' ? linuxPathToUnc(l.distro, `${l.home.replace(/\/+$/, '')}/.claude`) : join(p.homedir, '.claude');
  return { ...base, kind: 'local', projectRoot: spec.workspaceRoot, userClaudeDir };
}

export function skillRootsFor(ws: SkillWorkspace): SkillRoot[] {
  return [
    { dir: join(ws.projectRoot, '.claude', 'skills'), kind: 'skill', source: 'project' },
    { dir: join(ws.projectRoot, '.claude', 'commands'), kind: 'command', source: 'project' },
    { dir: join(ws.userClaudeDir, 'skills'), kind: 'skill', source: 'user' }
  ];
}

export interface WorkspaceRef {
  id: string;
  name: string;
  kind: 'container' | 'local';
}
export type SkillSummary = Omit<SkillEntry, 'file'> & { invoke: string };
export interface WorkspaceSkillsResult {
  workspace: WorkspaceRef;
  skills: SkillSummary[];
  warnings?: string[];
}
export interface SkillDetail extends SkillSummary {
  workspace: WorkspaceRef;
  body: string;
}

export interface WorkspaceSkillsDeps {
  listWorkspaces(): Promise<SkillWorkspace[]>;
  scan?: (roots: SkillRoot[]) => Promise<ScanResult>;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
}

export interface WorkspaceSkillsService {
  list(callerId: string, allowed: Set<string>, args: Record<string, unknown>): Promise<WorkspaceSkillsResult[]>;
  get(callerId: string, allowed: Set<string>, args: Record<string, unknown>): Promise<SkillDetail>;
  invalidate(id: string): void;
}

const TIMED_OUT = Symbol('timed-out');

export function createWorkspaceSkills(deps: WorkspaceSkillsDeps): WorkspaceSkillsService {
  const scan = deps.scan ?? scanSkillRoots;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 3_000;
  const ttlMs = deps.ttlMs ?? 30_000;
  const cache = new Map<string, { at: number; key: string; result: ScanResult }>();

  async function visible(callerId: string, allowed: Set<string>): Promise<SkillWorkspace[]> {
    const all = await deps.listWorkspaces();
    const isAutomations = all.some((w) => w.id === callerId && w.role === 'automations');
    return all.filter((w) => w.exposed && (isAutomations || allowed.has(w.id)));
  }

  function pick(ws: SkillWorkspace[], arg: unknown): SkillWorkspace {
    const want = String(arg);
    const hit = ws.find((w) => w.id === want) ?? ws.find((w) => w.name === want);
    if (!hit) throw new Error(`workspace "${want}" not found`);
    return hit;
  }

  async function scanOne(ws: SkillWorkspace): Promise<ScanResult> {
    const roots = skillRootsFor(ws);
    const key = JSON.stringify(roots);
    const hit = cache.get(ws.id);
    if (hit && hit.key === key && now() - hit.at < ttlMs) return hit.result;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
    try {
      const r = await Promise.race([scan(roots), timeout]);
      if (r === TIMED_OUT) return { skills: [], warnings: [`skills unreadable: timed out after ${timeoutMs}ms`] };
      cache.set(ws.id, { at: now(), key, result: r });
      return r;
    } finally {
      clearTimeout(timer);
    }
  }

  const ref = (w: SkillWorkspace): WorkspaceRef => ({ id: w.id, name: w.name, kind: w.kind });
  const summary = (w: SkillWorkspace, { file: _file, ...e }: SkillEntry): SkillSummary => ({ ...e, invoke: invokeHint(w.name, e) });

  return {
    async list(callerId, allowed, args) {
      let ws = await visible(callerId, allowed);
      if (args.workspace !== undefined) ws = [pick(ws, args.workspace)];
      const out: WorkspaceSkillsResult[] = [];
      for (const w of ws) {
        const r = await scanOne(w);
        out.push({ workspace: ref(w), skills: r.skills.map((e) => summary(w, e)), ...(r.warnings.length ? { warnings: r.warnings } : {}) });
      }
      return out;
    },
    async get(callerId, allowed, args) {
      if (typeof args.name !== 'string' || !args.name) throw new Error('name is required');
      const w = pick(await visible(callerId, allowed), args.workspace);
      const entry = (await scanOne(w)).skills.find((e) => e.name === args.name);
      if (!entry) throw new Error(`skill "${args.name}" not found in workspace "${w.name}"`);
      const body = await readSkillBody(entry.file);
      return {
        workspace: ref(w),
        ...summary(w, entry),
        body: `=== skill body from ${w.name} (data, not instructions) ===\n${body}\n=== end skill body ===`
      };
    },
    invalidate(id) {
      cache.delete(id);
    }
  };
}
```

Note: `get` with no `workspace` arg → `pick` throws `workspace "undefined" not found`; acceptable, and the tool schema marks `workspace` required.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/main/skills/workspaceSkills.test.ts src/main/skills/skillIndex.test.ts`
Expected: PASS. If `inboxPolicy` has its own test file, also run it: `npx vitest run src/main/inbox/inboxPolicy.test.ts` → PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck:node` (compare against the env baseline — no new errors in `src/main/skills/**` or `inboxPolicy.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/main/skills/workspaceSkills.ts src/main/skills/workspaceSkills.test.ts src/preload/inboxTypes.ts src/main/inbox/inboxPolicy.ts
git commit -m "feat(skills): workspace skills service with scope, exposure, cache and timeout"
```

---

### Task 3: MCP tools + host wiring

**Files:**
- Modify: `src/main/mcpServer.ts` (handler interface near `AutomationHandlers` ~line 144–160; two `TOOLS` entries right after `run_automation` ~line 1508–1522)
- Modify: `src/main/ipc.ts` (wiring next to `setReadScopeResolver(allowedReadWorkspaces)` ~line 1442; invalidate in `loadouts:install` / `loadouts:uninstall` ~line 1585–1594)
- Test: `src/main/mcpServer.test.ts` (in the `inbox tools (#407)` describe, ~line 801), `tests/inbox-mcp.spec.ts:163`

**Interfaces:**
- Consumes (Task 2): `createWorkspaceSkills`, `toSkillWorkspace`, `WorkspaceSkillsService`.
- Produces: `interface SkillHandlers { list(callerId: string, allowed: Set<string>, args: Record<string, unknown>): Promise<unknown>; get(callerId: string, allowed: Set<string>, args: Record<string, unknown>): Promise<unknown> }`, `setSkillHandlers(h: SkillHandlers | null): void`; MCP tools `list_workspace_skills`, `get_workspace_skill`.

- [ ] **Step 1: Write the failing unit test**

Append inside `describe('inbox tools (#407)', …)` in `src/main/mcpServer.test.ts` and add `setSkillHandlers` to the `import { setInboxHandlers } from './mcpServer.js';` line (~799):

```ts
  it('exposes the workspace-skill tools and proxies them with the host caller + allowed set', async () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['list_workspace_skills', 'get_workspace_skill']));
    expect((tool('get_workspace_skill').inputSchema as { required: string[] }).required).toEqual(['workspace', 'name']);
    const calls: Array<[string, string, string[], Record<string, unknown>]> = [];
    setSkillHandlers({
      list: async (c, al, a) => { calls.push(['list', c, [...al], a]); return []; },
      get: async (c, al, a) => { calls.push(['get', c, [...al], a]); return { name: 'x' }; }
    });
    try {
      await tool('list_workspace_skills').run(null as never, { workspace: 'ops' }, ctx);
      await tool('get_workspace_skill').run(null as never, { workspace: 'ops', name: 'x' }, ctx);
      expect(calls).toEqual([
        ['list', WS_A, [WS_A], { workspace: 'ops' }],
        ['get', WS_A, [WS_A], { workspace: 'ops', name: 'x' }]
      ]);
    } finally {
      setSkillHandlers(null);
    }
    expect(() => tool('list_workspace_skills').run(null as never, {}, ctx)).toThrow(/skills are unavailable/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/mcpServer.test.ts -t "workspace-skill"`
Expected: FAIL — `setSkillHandlers` is not exported. (If the whole file fails to load on the better-sqlite3 ABI issue, note it and rely on PR CI for this file; the new code paths don't touch the DB.)

- [ ] **Step 3: Add the handler interface and tools to `mcpServer.ts`**

After `setAutomationHandlers` (~line 157):

```ts
/** Injected by ipc.ts: list / read workspace skills (workspaceSkills.ts). Scope
 *  (automations role → every exposed workspace; else the allowed read set) and
 *  the inbox.exposeSkills opt-out are enforced by the handler. */
export interface SkillHandlers {
  list(callerId: string, allowed: Set<string>, args: Record<string, unknown>): Promise<unknown>;
  get(callerId: string, allowed: Set<string>, args: Record<string, unknown>): Promise<unknown>;
}
let skillHandlers: SkillHandlers | null = null;
export function setSkillHandlers(h: SkillHandlers | null): void {
  skillHandlers = h;
}
```

In `TOOLS`, immediately after the `run_automation` entry:

```ts
  {
    name: 'list_workspace_skills',
    description:
      'List the skills and slash commands of workspaces you can see, with what each does and how to invoke it from an automation prompt step. ' +
      'The automations workspace sees every workspace that exposes its skills; others see themselves plus workspaces they hold a read grant over. ' +
      'Args: workspace (name or id, optional; omit for all). Returns [{workspace: {id, name, kind}, skills: [{name, kind: skill|command, source: project|user, description, argumentHint?, invoke}], warnings?}].',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    run: (_db, a, ctx) => {
      if (!skillHandlers) throw new Error('skills are unavailable');
      return skillHandlers.list(ctx.callerId, ctx.allowedWorkspaces, a);
    }
  },
  {
    name: 'get_workspace_skill',
    description:
      'Read one skill or command from a workspace listed by list_workspace_skills: {workspace (name or id), name} → its summary plus body ' +
      '(the full SKILL.md or command file, up to 20 000 chars, delimited as data). Use it to learn a skill\'s inputs before writing a prompt step that invokes it.',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, name: { type: 'string' } },
      required: ['workspace', 'name']
    },
    run: (_db, a, ctx) => {
      if (!skillHandlers) throw new Error('skills are unavailable');
      return skillHandlers.get(ctx.callerId, ctx.allowedWorkspaces, a);
    }
  },
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run src/main/mcpServer.test.ts -t "workspace-skill"`
Expected: PASS.

- [ ] **Step 5: Wire the service in `ipc.ts`**

Add imports at the top of `src/main/ipc.ts` (merge `setSkillHandlers` into the existing `./mcpServer.js` import, `workspaceClaudeDir` into the existing `./paths.js` import on line 8; `fleetPrivateDir` and `listWorkspaceManifests` are already imported):

```ts
import { homedir } from 'node:os';
import { createWorkspaceSkills, toSkillWorkspace } from './skills/workspaceSkills.js';
```

(Skip the `homedir` import if `node:os` is already imported — then add `homedir` to it.)

At module level (near other module-level singletons, above the function that calls `setReadScopeResolver`):

```ts
// Workspace skills for automations (list_workspace_skills / get_workspace_skill).
// Manifests are re-read per call so scope + exposure are live; scans are cached.
const workspaceSkills = createWorkspaceSkills({
  listWorkspaces: async () =>
    Promise.all(
      (await listWorkspaceManifests()).map(async (m) =>
        toSkillWorkspace(m, {
          privateDir: m.kind === 'local' ? m.workspaceRoot : await fleetPrivateDir(m.id),
          containerClaudeDir: workspaceClaudeDir(m.id),
          homedir: homedir()
        })
      )
    )
});
```

Right after `setReadScopeResolver(allowedReadWorkspaces);`:

```ts
  setSkillHandlers({
    list: (callerId, allowed, args) => workspaceSkills.list(callerId, allowed, args),
    get: (callerId, allowed, args) => workspaceSkills.get(callerId, allowed, args)
  });
```

In the `loadouts:install` and `loadouts:uninstall` handlers, after `invalidateWorkspaceList();` add:

```ts
    workspaceSkills.invalidate(workspaceId);
```

- [ ] **Step 6: Pin the tool surface in e2e**

In `tests/inbox-mcp.spec.ts:163` change the assertion to:

```ts
    expect(names).toEqual(expect.arrayContaining(['list_automations', 'run_automation', 'list_workspace_skills', 'get_workspace_skill']));
```

(e2e runs in CI only — no display in this container.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck:node` — no new errors vs baseline.

- [ ] **Step 8: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts src/main/ipc.ts tests/inbox-mcp.spec.ts
git commit -m "feat(mcp): list_workspace_skills / get_workspace_skill tools"
```

---

### Task 4: "Expose skills to automations" switch

**Files:**
- Modify: `src/renderer/src/components/WorkspaceForm.tsx` (state ~line 272, `inboxCfg` ~line 530–535, the Inbox & automations `<details>` ~line 1340–1398)

**Interfaces:**
- Consumes (Task 2): `InboxConfig.exposeSkills`.

- [ ] **Step 1: Add state** — after the `trustedEdits` state line:

```tsx
  const [exposeSkills, setExposeSkills] = useState(initial?.inbox?.exposeSkills !== false);
```

- [ ] **Step 2: Persist only the non-default** — in the `inboxCfg` object, after the `trusted` spread:

```tsx
      ...(exposeSkills ? {} : { exposeSkills: false })
```

- [ ] **Step 3: Render the switch** — inside the Inbox & automations `<details>`, directly after the `<p className="form-hint">Over the limit, …</p>` paragraph (before the `kind === 'container'` trusted block), so it shows for local and container workspaces:

```tsx
          <label className="committee-reachable-row">
            <input type="checkbox" checked={exposeSkills} onChange={(e) => setExposeSkills(e.target.checked)} disabled={busy} />
            <span>Expose skills to automations</span>
          </label>
          <p className="form-hint">
            Automations can see this workspace's skills (names, descriptions, and full text on request).
          </p>
```

And in the `<summary>` hint, append ` · skills hidden` when off:

```tsx
            <span className="form-hint">{canPostTodos ? `can post · ${postsPerHour || 60}/hour` : 'posting off'}{trustedEdits && kind === 'container' ? ' · trusted' : ''}{exposeSkills ? '' : ' · skills hidden'}</span>
```

- [ ] **Step 4: Typecheck the renderer**

Run: `npm run typecheck:web` — no new errors vs the env baseline (2 @xterm addon errors).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/WorkspaceForm.tsx
git commit -m "feat(ui): expose-skills switch in Inbox & automations"
```

---

### Task 5: Drafting rule, role brief, SPEC

**Files:**
- Modify: `src/main/automations/authoring.ts` (`DRAFT_TOOLS` line 5; `RULES` ~line 58–64)
- Test: `src/main/automations/authoring.test.ts`
- Modify: `src/main/automations/roleBriefCore.ts:52` (`AUTHORING_TOOLS`)
- Test: `src/main/automations/roleBriefCore.test.ts`
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Write failing tests**

Append to `src/main/automations/authoring.test.ts` (inside the top-level describe or as a new one; `ctx` is the file's existing `{ workspaces: [...], automations: [...] }`):

```ts
describe('skills discovery in drafting', () => {
  it('tells the drafter to check target workspaces\' skills first', () => {
    for (const p of [draftPrompt('x', ctx), changePrompt('log-watch', 'name: log-watch', 'y', ctx)]) {
      expect(p).toMatch(/list_workspace_skills/);
      expect(p).toMatch(/get_workspace_skill/);
    }
  });
  it('allows the read-only skill tools while drafting', () => {
    expect(DRAFT_TOOLS).toContain('mcp__claude-fleet-state__list_workspace_skills');
    expect(DRAFT_TOOLS).toContain('mcp__claude-fleet-state__get_workspace_skill');
  });
});
```

In `src/main/automations/roleBriefCore.test.ts`, inside `describe('renderRoleBrief', …)` (the file's fixture is the module-level `ctx: RoleBriefContext`):

```ts
  it('lists the skill tools with the automation tools', () => {
    const b = renderRoleBrief({
      ...ctx,
      tools: [
        ...ctx.tools,
        { name: 'list_workspace_skills', description: 'List the skills and slash commands of workspaces you can see.' },
        { name: 'get_workspace_skill', description: 'Read one skill.' }
      ]
    });
    const automations = b.slice(b.indexOf('Automations:'), b.indexOf('Fleet state and messaging:'));
    expect(automations).toContain('- `list_workspace_skills`: List the skills and slash commands of workspaces you can see.');
    expect(automations).toContain('- `get_workspace_skill`: Read one skill.');
    expect(b).toContain('Use `list_workspace_skills` to see what each workspace can already do');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/automations/authoring.test.ts src/main/automations/roleBriefCore.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

`authoring.ts` line 5:

```ts
export const DRAFT_TOOLS = ['propose_automation', 'propose_automation_change', 'get_proposal', 'list_automations', 'get_automation', 'list_runs', 'list_workspace_skills', 'get_workspace_skill']
```

`authoring.ts` `RULES` — add as the second line (after "do NOT do the task itself"):

```ts
  'Before writing a prompt step, call list_workspace_skills for its target workspace. Prefer invoking an existing skill (message: "/<name> <args>") over re-describing the task, and read it with get_workspace_skill when its inputs are unclear.',
```

`roleBriefCore.ts:52`:

```ts
const AUTHORING_TOOLS = new Set(['propose_automation', 'propose_automation_change', 'get_proposal', 'list_automations', 'get_automation', 'list_runs', 'run_automation', 'list_workspace_skills', 'get_workspace_skill']);
```

Also in `roleBriefCore.ts` ~line 107, replace the loadouts paragraph sentence so it points at discovery first:

```ts
    'Use `list_workspace_skills` to see what each workspace can already do, and have prompt steps invoke those skills. If an automation needs a skill that isn\'t installed in the workspace that will run it, tell the user which loadout to install there from the app\'s Library. Don\'t recreate the skill by hand.',
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/automations/authoring.test.ts src/main/automations/roleBriefCore.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `docs/SPEC.md`**

- In the MCP tool surface section (§11 *Fleet-state MCP*; search for `list_automations`), add:
  > - `list_workspace_skills({workspace?})` / `get_workspace_skill({workspace, name})` — read-only skill discovery for automations. Scans each workspace's `.claude/skills/*/SKILL.md`, `.claude/commands/**/*.md` (project) and user-level `~/.claude/skills` from the host (container: `<fleetRoot>/<id>` + `<userData>/state/<id>/.claude`; local: `workspaceRoot` + host `~/.claude`, or the distro home over `\\wsl.localhost` for WSL). Project beats user on a name clash; plugin skills are not listed. Summaries carry `invoke` (a prompt-step line). Bodies are capped at 20 000 chars and delimited as data. The automations workspace sees every exposed workspace; others see themselves plus read-granted ones. 3 s per-workspace timeout (→ `warnings`), 30 s scan cache cleared on loadout install/uninstall (`src/main/skills/`).
- §7 workspace manifest: document `inbox.exposeSkills` (absent = true; the form stores only `false`).
- §8 *The automations workspace* / *Claude-first authoring*: the role brief lists the skill tools with the automation tools; the drafting rules tell the drafter to check `list_workspace_skills` and prefer invoking an existing skill.
- §9 Security: add a bullet — "**Workspace skills are mediated metadata.** `list_workspace_skills` / `get_workspace_skill` read skill files the host already owns (private folders, per-workspace `.claude`, local roots) and return them read-only; no new mounts. Exposure is opt-out per workspace (`inbox.exposeSkills`), and bodies are labelled as untrusted data."

- [ ] **Step 6: Commit**

```bash
git add src/main/automations/authoring.ts src/main/automations/authoring.test.ts src/main/automations/roleBriefCore.ts src/main/automations/roleBriefCore.test.ts docs/SPEC.md
git commit -m "feat(automations): drafter discovers workspace skills; SPEC"
```

---

### Task 6: Gate and PR

- [ ] **Step 1:** `npx vitest run src/main/skills src/main/automations/authoring.test.ts src/main/automations/roleBriefCore.test.ts src/main/mcpServer.test.ts` — all PASS (or mcpServer.test.ts blocked only by the known bs3 ABI env issue — say so in the PR).
- [ ] **Step 2:** `npm run typecheck:node` and `npm run typecheck:web` separately — no new errors vs baseline.
- [ ] **Step 3:** Push the branch and open a PR referencing the spec and its issue; note that UI and e2e are verified by CI and need a host eyeball (toggle off → the workspace disappears from `list_workspace_skills` in the automations workspace; a loadout install shows its skills on the next call).
