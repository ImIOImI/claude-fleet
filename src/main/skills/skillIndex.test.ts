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
