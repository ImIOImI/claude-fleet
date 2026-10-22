import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSkills, skillRootsFor, toSkillWorkspace, type SkillWorkspace } from './workspaceSkills.js';

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
