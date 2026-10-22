import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BODY_CAP, DESCRIPTION_CAP, invokeHint, isInside, parseSkillFile, readSkillBody, scanSkillRoots, type SkillRoot } from './skillIndex.js';

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
  { dir: join(root, 'proj/.claude/skills'), kind: 'skill', source: 'project', base: join(root, 'proj') },
  { dir: join(root, 'proj/.claude/commands'), kind: 'command', source: 'project', base: join(root, 'proj') },
  { dir: join(root, 'home/.claude/skills'), kind: 'skill', source: 'user', base: join(root, 'home/.claude') }
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
  it('a project skill beats a project command of the same name', async () => {
    put('proj/.claude/skills/ship/SKILL.md', '---\ndescription: Skill ship.\n---\n');
    put('proj/.claude/commands/ship.md', 'Command ship.');
    const r = await scanSkillRoots(roots());
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]).toMatchObject({ name: 'ship', kind: 'skill', description: 'Skill ship.' });
  });
  it('warns on bad frontmatter but keeps the entry', async () => {
    put('proj/.claude/skills/bad/SKILL.md', '---\nname: [oops\n---\nStill useful');
    const r = await scanSkillRoots(roots());
    expect(r.skills.map((s) => s.name)).toEqual(['bad']);
    expect(r.warnings[0]).toMatch(/bad.*frontmatter/);
  });
});

describe('isInside', () => {
  it('rejects a sibling directory that merely shares a name prefix', () => {
    expect(isInside('/fleet/W1', '/fleet/W10')).toBe(false);
    expect(isInside('/fleet/W1', '/fleet/W10/sub')).toBe(false);
  });
  it('accepts the base itself and real descendants', () => {
    expect(isInside('/fleet/W1', '/fleet/W1')).toBe(true);
    expect(isInside('/fleet/W1', '/fleet/W1/sub')).toBe(true);
  });
});

describe('scanSkillRoots containment (symlinks)', () => {
  const OUTSIDE = /resolves outside the workspace/;
  beforeEach(() => {
    put('other/.claude/commands/secret.md', '---\ndescription: OTHER WORKSPACE SECRET\n---\nsecret body');
    put('other/.claude/skills/stolen/SKILL.md', '---\ndescription: STOLEN\n---\nsecret');
    put('proj/.claude/skills/ok/SKILL.md', '---\ndescription: Ok.\n---\n');
  });
  const noLeak = (r: Awaited<ReturnType<typeof scanSkillRoots>>) => {
    expect(JSON.stringify(r.skills)).not.toMatch(/SECRET|STOLEN/);
    for (const w of r.warnings) expect(w).not.toContain(root);
  };
  it('skips a commands dir symlinked outside the workspace, with a warning', async () => {
    symlinkSync(join(root, 'other/.claude/commands'), join(root, 'proj/.claude/commands'));
    const r = await scanSkillRoots(roots());
    expect(r.skills.map((s) => s.name)).toEqual(['ok']);
    expect(r.warnings.some((w) => OUTSIDE.test(w))).toBe(true);
    noLeak(r);
  });
  it('skips a .claude dir symlinked outside the workspace', async () => {
    rmSync(join(root, 'proj/.claude'), { recursive: true });
    symlinkSync(join(root, 'other/.claude'), join(root, 'proj/.claude'));
    const r = await scanSkillRoots(roots());
    expect(r.skills).toEqual([]);
    expect(r.warnings.some((w) => OUTSIDE.test(w))).toBe(true);
    noLeak(r);
  });
  it('skips a skill dir symlinked outside the workspace, with a nameless aggregated warning', async () => {
    symlinkSync(join(root, 'other/.claude/skills/stolen'), join(root, 'proj/.claude/skills/stolen'));
    const r = await scanSkillRoots(roots());
    expect(r.skills.map((s) => s.name)).toEqual(['ok']);
    expect(r.warnings).toEqual(['1 entry skipped (resolves outside the workspace)']);
    noLeak(r);
  });
  it('skips a SKILL.md file symlinked outside the workspace, with a nameless aggregated warning', async () => {
    mkdirSync(join(root, 'proj/.claude/skills/evil'));
    symlinkSync(join(root, 'other/.claude/skills/stolen/SKILL.md'), join(root, 'proj/.claude/skills/evil/SKILL.md'));
    const r = await scanSkillRoots(roots());
    expect(r.skills.map((s) => s.name)).toEqual(['ok']);
    expect(r.warnings).toEqual(['1 entry skipped (resolves outside the workspace)']);
    noLeak(r);
  });
  it('aggregates multiple per-file escapes across roots into a single plural warning, no names', async () => {
    mkdirSync(join(root, 'proj/.claude/skills/evil1'));
    symlinkSync(join(root, 'other/.claude/skills/stolen/SKILL.md'), join(root, 'proj/.claude/skills/evil1/SKILL.md'));
    symlinkSync(join(root, 'other/.claude/skills/stolen'), join(root, 'proj/.claude/skills/evil2'));
    mkdirSync(join(root, 'home/.claude/skills'), { recursive: true });
    symlinkSync(join(root, 'other/.claude/skills/stolen'), join(root, 'home/.claude/skills/evil3'));
    const r = await scanSkillRoots(roots());
    expect(r.skills.map((s) => s.name)).toEqual(['ok']);
    expect(r.warnings).toEqual(['3 entries skipped (resolve outside the workspace)']);
    noLeak(r);
  });
  it('does not follow a command subdir that is itself a symlink', async () => {
    put('proj/external-cmds/deploy.md', '---\ndescription: Deploy.\n---\n');
    mkdirSync(join(root, 'proj/.claude/commands'), { recursive: true });
    symlinkSync(join(root, 'proj/external-cmds'), join(root, 'proj/.claude/commands/ns'));
    const r = await scanSkillRoots(roots());
    expect(r.skills.map((s) => s.name)).toEqual(['ok']);
    expect(r.skills.some((s) => s.name.startsWith('ns:'))).toBe(false);
    noLeak(r);
  });
  it('lists symlinks that stay inside the workspace', async () => {
    put('proj/lib/shared-skill/SKILL.md', '---\ndescription: Shared.\n---\n');
    symlinkSync(join(root, 'proj/lib/shared-skill'), join(root, 'proj/.claude/skills/shared'));
    const r = await scanSkillRoots(roots());
    expect(r.skills.map((s) => s.name)).toEqual(['ok', 'shared']);
    expect(r.warnings).toEqual([]);
  });
  it('accepts a workspace whose base is itself a symlink (realpath on both sides)', async () => {
    symlinkSync(join(root, 'proj'), join(root, 'proj-link'));
    const linked: SkillRoot[] = [{ dir: join(root, 'proj-link/.claude/skills'), kind: 'skill', source: 'project', base: join(root, 'proj-link') }];
    const r = await scanSkillRoots(linked);
    expect(r.skills.map((s) => s.name)).toEqual(['ok']);
    expect(r.warnings).toEqual([]);
  });
  it('a missing base is an empty root, no warning', async () => {
    const r = await scanSkillRoots([{ dir: join(root, 'nope/.claude/skills'), kind: 'skill', source: 'project', base: join(root, 'nope') }]);
    expect(r).toEqual({ skills: [], warnings: [] });
  });
  it('unreadable-file warnings carry no host path', async () => {
    mkdirSync(join(root, 'proj/.claude/skills/dirskill/SKILL.md'), { recursive: true }); // a dir, not a file
    const r = await scanSkillRoots(roots());
    expect(r.skills.map((s) => s.name)).toEqual(['ok']);
    noLeak(r);
  });
});

describe('readSkillBody / invokeHint', () => {
  it('refuses a file swapped for an escaping symlink after the scan', async () => {
    const f = put('proj/.claude/skills/ok/SKILL.md', 'fine');
    const secret = put('other/secret.md', 'SECRET');
    const base = join(root, 'proj');
    expect(await readSkillBody(f, base)).toBe('fine');
    unlinkSync(f);
    symlinkSync(secret, f);
    await expect(readSkillBody(f, base)).rejects.toThrow('skill file resolves outside the workspace');
  });
  it('read errors carry no host path', async () => {
    const err = await readSkillBody(join(root, 'proj/missing.md'), root).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(root);
  });
  it('returns the whole file, truncating past the cap', async () => {
    const small = put('a.md', '---\nname: a\n---\nhello');
    expect(await readSkillBody(small, root)).toBe('---\nname: a\n---\nhello');
    const big = put('b.md', 'x'.repeat(BODY_CAP + 10));
    const body = await readSkillBody(big, root);
    expect(body.endsWith('\n[truncated]')).toBe(true);
    expect(body.length).toBe(BODY_CAP + '\n[truncated]'.length);
  });
  it('builds a prompt-step invocation line', () => {
    expect(invokeHint('ops-oncall', { name: 'triage', argumentHint: '<since>' }))
      .toBe('prompt step → workspace: ops-oncall, message: "/triage <since>"');
    expect(invokeHint('ops', { name: 'ship' })).toBe('prompt step → workspace: ops, message: "/ship"');
  });
});
