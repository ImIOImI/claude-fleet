import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecord, writeRecord } from './loadoutRecord.js';
import { syncLoadouts, type ScriptRun, type SyncOptions } from './loadoutSync.js';
import { loadoutFiles, sha, startFakeGithubRepo, type FakeFile, type FakeGithubRepo } from './testGithubRepo.js';

type Line = { level: string; msg: string } & Record<string, unknown>;

let gh: FakeGithubRepo;
let target: string;
let staging: string;
let lines: Line[];
let scripts: { command: string; cwd: string }[];

beforeEach(async () => {
  gh = await startFakeGithubRepo({ owner: 'SumerSports', repo: 'claude-fleet-loadouts' });
  target = await mkdtemp(join(tmpdir(), 'lsync-target-'));
  staging = await mkdtemp(join(tmpdir(), 'lsync-staging-'));
  lines = [];
  scripts = [];
});
afterEach(async () => {
  expect(JSON.stringify(lines)).not.toContain(gh.token);
  expect(Object.values(process.env)).not.toContain(gh.token);
  await gh.close();
  await rm(target, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
});

function opts(pins: string | undefined, over: Partial<SyncOptions> = {}): SyncOptions {
  return {
    env: { FLEET_LOADOUTS: pins, FLEET_LOADOUTS_API: gh.url },
    target,
    log: { log: (level, msg, fields = {}) => void lines.push({ level, msg, ...fields }) },
    token: async () => gh.token,
    runScript: async (command, cwd): Promise<ScriptRun> => {
      expect(Object.values(process.env)).not.toContain(gh.token);
      scripts.push({ command, cwd });
      return { exitCode: 0, output: '' };
    },
    budgetMs: 10_000,
    stagingRoot: staging,
    ...over
  };
}
const read = (p: string): Promise<string> => readFile(join(target, p), 'utf8');
const exists = (p: string): Promise<boolean> => stat(join(target, p)).then(() => true, () => false);
const failures = (): Line[] => lines.filter((l) => l.msg === 'loadout sync failed');
const tag = (id: string, version: string, n: number, extra: Record<string, FakeFile> = {}): void => {
  gh.tags.set(`${id}/v${version}`, { commit: sha(n), files: loadoutFiles(id, version, extra) });
};
const setLoadoutMd = (tagName: string, text: string): void => {
  const id = tagName.split('/')[0];
  gh.tags.get(tagName)!.files[`loadouts/${id}/loadout.md`] = text;
};

describe('syncLoadouts', () => {
  it('installs a pin: files, CLAUDE.md block, merges and the record', async () => {
    tag('demo', '1.0.0', 1, {
      'loadouts/demo/CLAUDE.md': 'Use demo.\n',
      'loadouts/demo/settings.json': JSON.stringify({ env: { DEMO: '1' } }),
      'loadouts/demo/.mcp.json': JSON.stringify({ mcpServers: { demo: { command: 'demo-mcp' } } })
    });
    const s = await syncLoadouts(opts('demo@1.0.0'));
    expect(s).toEqual({ installed: ['demo@1.0.0'], reverted: [], unchanged: [], failed: [] });
    expect(await read('.claude/skills/demo/SKILL.md')).toContain('demo 1.0.0');
    expect(await read('CLAUDE.md')).toContain('<!-- loadout:demo start -->\nUse demo.\n<!-- loadout:demo end -->');
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({ env: { DEMO: '1' } });
    expect(JSON.parse(await read('.mcp.json'))).toEqual({ mcpServers: { demo: { command: 'demo-mcp' } } });
    expect((await readRecord(target)).loadouts).toEqual([
      expect.objectContaining({
        id: 'demo',
        version: '1.0.0',
        repo: 'SumerSports/claude-fleet-loadouts',
        commit: sha(1),
        files: ['.claude/skills/demo/SKILL.md'],
        claudeMd: true,
        settingsKeys: ['env'],
        mcpServers: ['demo'],
        hooks: []
      })
    ]);
    expect(await readdir(staging)).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ msg: 'loadout sync done', installed: ['demo@1.0.0'] });
    expect(lines).toContainEqual({ level: 'warn', msg: 'loadout sync uses a non-default API', api: gh.url });
  });

  it('does not warn about the default API', async () => {
    await syncLoadouts(opts(undefined, { env: {} }));
    expect(lines.map((l) => l.msg)).toEqual(['loadout sync done']);
  });

  it('skips an unchanged pin without asking for a token', async () => {
    tag('demo', '1.0.0', 1);
    await syncLoadouts(opts('demo@1.0.0'));
    const calls = gh.requests.length;
    let asked = 0;
    const s = await syncLoadouts(opts('demo@1.0.0', { token: () => (asked++, Promise.reject(new Error('no token expected'))) }));
    expect(s).toEqual({ installed: [], reverted: [], unchanged: ['demo@1.0.0'], failed: [] });
    expect(asked).toBe(0);
    expect(gh.requests.length).toBe(calls);
  });

  it('reverts the previous version before applying a new one', async () => {
    tag('demo', '1.0.0', 1, { 'loadouts/demo/CLAUDE.md': 'one\n' });
    tag('demo', '2.0.0', 2, { 'loadouts/demo/CLAUDE.md': 'two\n', 'loadouts/demo/commands/demo.md': 'run demo\n' });
    await syncLoadouts(opts('demo@1.0.0'));
    const s = await syncLoadouts(opts('demo@2.0.0'));
    expect(s.installed).toEqual(['demo@2.0.0']);
    expect(await read('.claude/skills/demo/SKILL.md')).toContain('demo 2.0.0');
    expect(await read('.claude/commands/demo.md')).toBe('run demo\n');
    const md = await read('CLAUDE.md');
    expect(md).toContain('two');
    expect(md).not.toContain('one');
    expect((await readRecord(target)).loadouts.map((r) => [r.version, r.commit])).toEqual([['2.0.0', sha(2)]]);
  });

  it('reverts a loadout that is no longer pinned', async () => {
    tag('demo', '1.0.0', 1, { 'loadouts/demo/CLAUDE.md': 'one\n', 'loadouts/demo/settings.json': '{"env":{"A":"1"}}' });
    await syncLoadouts(opts('demo@1.0.0'));
    const s = await syncLoadouts(opts(undefined));
    expect(s.reverted).toEqual(['demo@1.0.0']);
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(false);
    expect(await exists('CLAUDE.md')).toBe(false);
    expect(await exists('.claude/settings.json')).toBe(false);
    expect((await readRecord(target)).loadouts).toEqual([]);
  });

  it('keeps the previous version when the new one fails to download', async () => {
    tag('demo', '1.0.0', 1);
    tag('demo', '2.0.0', 2);
    await syncLoadouts(opts('demo@1.0.0'));
    gh.failTarball.add(sha(2));
    const s = await syncLoadouts(opts('demo@2.0.0'));
    expect(s.failed).toEqual(['demo@2.0.0']);
    expect(failures()).toEqual([
      expect.objectContaining({ level: 'error', stage: 'download', id: 'demo', version: '2.0.0', error: 'download: tarball → HTTP 500' })
    ]);
    expect(await read('.claude/skills/demo/SKILL.md')).toContain('demo 1.0.0');
    expect((await readRecord(target)).loadouts.map((r) => r.version)).toEqual(['1.0.0']);
  });

  it('refuses a tag whose loadout.md has another version', async () => {
    gh.tags.set('demo/v3.0.0', { commit: sha(3), files: loadoutFiles('demo', '2.9.9') });
    await syncLoadouts(opts('demo@3.0.0'));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'verify', error: 'loadout.md version is 2.9.9, not 3.0.0' })]);
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(false);
  });

  it('reports a missing tag', async () => {
    await syncLoadouts(opts('demo@1.0.0'));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'resolve', error: 'resolve: tag demo/v1.0.0 → HTTP 404' })]);
  });

  it('rolls back to the previous version when the apply fails', async () => {
    tag('demo', '1.0.0', 1);
    tag('demo', '2.0.0', 2, { 'loadouts/demo/skills/blocked/SKILL.md': 'x\n' });
    await syncLoadouts(opts('demo@1.0.0'));
    await writeFile(join(target, '.claude/skills/blocked'), 'a file where a directory must go\n');
    gh.tags.set('keep/v0.0.0', gh.tags.get('demo/v1.0.0')!);
    tag('demo', '1.0.0', 9, { 'loadouts/demo/skills/demo/SKILL.md': 'the tag moved\n' });
    const s = await syncLoadouts(opts('demo@2.0.0'));
    expect(s.failed).toEqual(['demo@2.0.0']);
    expect(failures()).toEqual([expect.objectContaining({ stage: 'apply', id: 'demo', version: '2.0.0' })]);
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'loadout rolled back', id: 'demo', version: '1.0.0' }));
    expect(await read('.claude/skills/demo/SKILL.md')).toContain('demo 1.0.0');
    expect((await readRecord(target)).loadouts.map((r) => [r.version, r.commit])).toEqual([['1.0.0', sha(1)]]);
  });

  it('changes nothing when FLEET_LOADOUTS is malformed', async () => {
    tag('demo', '1.0.0', 1);
    await syncLoadouts(opts('demo@1.0.0'));
    const s = await syncLoadouts(opts('demo@1.0'));
    expect(s).toEqual({ installed: [], reverted: [], unchanged: [], failed: [] });
    expect(failures()).toEqual([expect.objectContaining({ stage: 'config' })]);
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(true);
  });

  it('changes nothing when the record is unreadable', async () => {
    tag('demo', '1.0.0', 1);
    await mkdir(join(target, '.claude'), { recursive: true });
    await writeFile(join(target, '.claude/fleet-loadouts.json'), '{not json');
    await syncLoadouts(opts('demo@1.0.0'));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'record', error: '.claude/fleet-loadouts.json is not JSON' })]);
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(false);
  });

  it('fails every pin when the token is refused, without calling GitHub', async () => {
    tag('a', '1.0.0', 1);
    tag('b', '1.0.0', 2);
    const s = await syncLoadouts(opts('a@1.0.0 b@1.0.0', { token: () => Promise.reject(new Error('403: not in github.repositories: claude-fleet-loadouts')) }));
    expect(s.failed).toEqual(['a@1.0.0', 'b@1.0.0']);
    expect(failures().map((f) => f.stage)).toEqual(['token', 'token']);
    expect(gh.requests).toEqual([]);
  });

  it('refuses a malformed token without sending it', async () => {
    tag('demo', '1.0.0', 1);
    await syncLoadouts(opts('demo@1.0.0', { token: async () => 'has space' }));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'token', error: 'the credential server returned a malformed token' })]);
    expect(gh.requests).toEqual([]);
  });

  it('stops at the budget and says so', async () => {
    tag('demo', '1.0.0', 1);
    tag('next', '1.0.0', 2);
    gh.hangTarball = true;
    const t0 = Date.now();
    const s = await syncLoadouts(opts('demo@1.0.0 next@1.0.0', { budgetMs: 300 }));
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(s.failed).toEqual(['demo@1.0.0', 'next@1.0.0']);
    expect(failures()).toEqual([
      expect.objectContaining({ stage: 'timeout', id: 'demo' }),
      expect.objectContaining({ stage: 'timeout', id: 'next', error: 'the sync ran out of time' })
    ]);
    expect(gh.requests.filter((r) => r.path.includes('/git/ref/tags/next'))).toEqual([]);
  });

  it('stops at the budget while waiting for the token', async () => {
    tag('demo', '1.0.0', 1);
    const t0 = Date.now();
    await syncLoadouts(opts('demo@1.0.0', { budgetMs: 300, token: () => new Promise<string>(() => undefined) }));
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(failures()).toEqual([expect.objectContaining({ stage: 'timeout', id: 'demo' })]);
  });

  it('drops the record entry when the rollback fails too', async () => {
    tag('demo', '1.0.0', 1);
    tag('demo', '2.0.0', 2, { 'loadouts/demo/skills/blocked/SKILL.md': 'x\n' });
    await syncLoadouts(opts('demo@1.0.0'));
    await writeFile(join(target, '.claude/skills/blocked'), 'a file where a directory must go\n');
    gh.failTarball.add(sha(1));
    const s = await syncLoadouts(opts('demo@2.0.0'));
    expect(s.failed).toEqual(['demo@2.0.0']);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'loadout rollback failed', id: 'demo', version: '1.0.0', error: 'download: tarball → HTTP 500' })
    );
    expect((await readRecord(target)).loadouts).toEqual([]);
  });

  it('removes what a failed apply wrote when there is no previous version', async () => {
    tag('demo', '1.0.0', 1, { 'loadouts/demo/CLAUDE.md': 'one\n', 'loadouts/demo/skills/zz/SKILL.md': 'x\n', 'loadouts/demo/commands/mine.md': 'theirs\n' });
    await mkdir(join(target, '.claude/skills'), { recursive: true });
    await mkdir(join(target, '.claude/commands'), { recursive: true });
    await writeFile(join(target, '.claude/commands/mine.md'), 'mine\n');
    await writeFile(join(target, '.claude/skills/zz'), 'a file where a directory must go\n');
    await writeFile(join(target, 'CLAUDE.md'), 'mine\n');
    const s = await syncLoadouts(opts('demo@1.0.0'));
    expect(s.failed).toEqual(['demo@1.0.0']);
    expect(failures()).toEqual([expect.objectContaining({ stage: 'apply', id: 'demo' })]);
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(false);
    expect(await read('CLAUDE.md')).toBe('mine\n');
    expect(await read('.claude/skills/zz')).toBe('a file where a directory must go\n');
    expect(await read('.claude/commands/mine.md')).toBe('mine\n');
    expect((await readRecord(target)).loadouts).toEqual([]);
  });

  it('removes its CLAUDE.md block when the merges fail', async () => {
    tag('demo', '1.0.0', 1, { 'loadouts/demo/CLAUDE.md': 'one\n', 'loadouts/demo/settings.json': '{"env":{"A":"1"}}' });
    await mkdir(join(target, '.claude/settings.json'), { recursive: true });
    await writeFile(join(target, 'CLAUDE.md'), 'mine\n');
    await syncLoadouts(opts('demo@1.0.0'));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'apply', id: 'demo' })]);
    expect(await read('CLAUDE.md')).toBe('mine\n');
    expect(await exists('.claude/skills/demo/SKILL.md')).toBe(false);
  });

  it('restores settings.json when a later .mcp.json merge fails', async () => {
    tag('demo', '1.0.0', 1, {
      'loadouts/demo/settings.json': '{"env":{"A":"1"}}',
      'loadouts/demo/.mcp.json': JSON.stringify({ mcpServers: { demo: { command: 'x' } } })
    });
    await mkdir(join(target, '.mcp.json'), { recursive: true });
    await syncLoadouts(opts('demo@1.0.0'));
    expect(failures()).toEqual([expect.objectContaining({ stage: 'apply', id: 'demo' })]);
    expect(await exists('.claude/settings.json')).toBe(false);
    await mkdir(join(target, '.claude'), { recursive: true });
    await writeFile(join(target, '.claude/settings.json'), '{"mine":true}\n');
    await syncLoadouts(opts('demo@1.0.0'));
    expect(await read('.claude/settings.json')).toBe('{"mine":true}\n');
    expect((await stat(join(target, '.mcp.json'))).isDirectory()).toBe(true);
  });

  it('fails each pin, without throwing, when staging cannot be created', async () => {
    tag('a', '1.0.0', 1);
    tag('b', '1.0.0', 2);
    const s = await syncLoadouts(opts('a@1.0.0 b@1.0.0', { stagingRoot: join(staging, 'missing') }));
    expect(s.failed).toEqual(['a@1.0.0', 'b@1.0.0']);
    expect(failures().map((f) => [f.id, f.stage])).toEqual([
      ['a', 'verify'],
      ['b', 'verify']
    ]);
    expect(lines.at(-1)).toMatchObject({ msg: 'loadout sync done' });
  });

  it('does not roll back to a version from another repo', async () => {
    tag('demo', '2.0.0', 2, { 'loadouts/demo/skills/blocked/SKILL.md': 'x\n' });
    tag('demo', '1.0.0', 1);
    const prev = {
      id: 'demo',
      version: '1.0.0',
      repo: 'Elsewhere/loadouts',
      commit: sha(1),
      files: [],
      claudeMd: false,
      settingsKeys: [],
      mcpServers: [],
      hooks: [],
      installedAt: 1
    };
    await writeRecord(target, { version: 1, loadouts: [prev] });
    await mkdir(join(target, '.claude/skills'), { recursive: true });
    await writeFile(join(target, '.claude/skills/blocked'), 'a file where a directory must go\n');
    await syncLoadouts(opts('demo@2.0.0'));
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'loadout rollback failed', id: 'demo', version: '1.0.0', error: 'previous version came from another repo' })
    );
    expect(gh.requests.filter((r) => r.path.includes(sha(1)))).toEqual([]);
    expect((await readRecord(target)).loadouts).toEqual([]);
  });

  it('does not roll back to a commit that is not on the default branch', async () => {
    tag('demo', '1.0.0', 1);
    tag('demo', '2.0.0', 2, { 'loadouts/demo/skills/blocked/SKILL.md': 'x\n' });
    gh.tags.set('evil/v6.6.6', { commit: sha(7), files: loadoutFiles('demo', '1.0.0'), onMain: false });
    await syncLoadouts(opts('demo@1.0.0'));
    const rec = await readRecord(target);
    await writeRecord(target, { version: 1, loadouts: rec.loadouts.map((r) => ({ ...r, commit: sha(7) })) });
    await writeFile(join(target, '.claude/skills/blocked'), 'a file where a directory must go\n');
    await syncLoadouts(opts('demo@2.0.0'));
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'loadout rollback failed', id: 'demo', version: '1.0.0', error: 'resolve: commit is not on main' })
    );
    expect(gh.requests.filter((r) => r.path.includes(`/tarball/${sha(7)}`))).toEqual([]);
    expect((await readRecord(target)).loadouts).toEqual([]);
  });

  it('rolls back to a version whose repo differs only in case', async () => {
    tag('demo', '1.0.0', 1);
    tag('demo', '2.0.0', 2, { 'loadouts/demo/skills/blocked/SKILL.md': 'x\n' });
    await syncLoadouts(opts('demo@1.0.0'));
    const rec = await readRecord(target);
    await writeRecord(target, { version: 1, loadouts: rec.loadouts.map((r) => ({ ...r, repo: 'sumersports/CLAUDE-fleet-loadouts' })) });
    await writeFile(join(target, '.claude/skills/blocked'), 'a file where a directory must go\n');
    await syncLoadouts(opts('demo@2.0.0'));
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'loadout rolled back', id: 'demo', version: '1.0.0' }));
  });

  it('keeps the previous version recorded when reverting it fails', async () => {
    tag('demo', '1.0.0', 1);
    tag('demo', '2.0.0', 2);
    await syncLoadouts(opts('demo@1.0.0'));
    await rm(join(target, '.claude/skills/demo'), { recursive: true });
    await writeFile(join(target, '.claude/skills/demo'), 'a file where a directory was\n');
    const s = await syncLoadouts(opts('demo@2.0.0'));
    expect(s.failed).toEqual(['demo@2.0.0']);
    expect(failures()).toEqual([expect.objectContaining({ stage: 'revert', id: 'demo', version: '2.0.0' })]);
    expect((await readRecord(target)).loadouts.map((r) => r.version)).toEqual(['1.0.0']);
    const again = await syncLoadouts(opts(undefined));
    expect(again.failed).toEqual(['demo@1.0.0']);
    expect((await readRecord(target)).loadouts.map((r) => r.version)).toEqual(['1.0.0']);
  });

  it('runs scripts in the target and keeps the install when one fails', async () => {
    tag('demo', '1.0.0', 1);
    setLoadoutMd(
      'demo/v1.0.0',
      '---\ntitle: demo\ndescription: d\nversion: 1.0.0\nscripts:\n  - label: hello\n    run: echo hi\n  - label: broken\n    run: exit 3\n---\n'
    );
    const s = await syncLoadouts(
      opts('demo@1.0.0', {
        runScript: async (command, cwd) => {
          scripts.push({ command, cwd });
          return command === 'exit 3' ? { exitCode: 3, output: 'boom' } : { exitCode: 0, output: 'hi\n' };
        }
      })
    );
    expect(scripts).toEqual([
      { command: 'echo hi', cwd: target },
      { command: 'exit 3', cwd: target }
    ]);
    expect(s.installed).toEqual(['demo@1.0.0']);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'loadout script failed', id: 'demo', label: 'broken', exitCode: 3, output: 'boom' })
    );
  });

  it('warns about an unpinned dependency and skips automations', async () => {
    tag('demo', '1.0.0', 1, { 'loadouts/demo/automations/nightly/automation.yaml': 'name: nightly\n' });
    setLoadoutMd(
      'demo/v1.0.0',
      '---\ntitle: demo\ndescription: d\nversion: 1.0.0\ndependencies:\n  loadouts:\n    - { id: git-sync, version: "^1.0.0" }\n---\n'
    );
    await syncLoadouts(opts('demo@1.0.0'));
    expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'loadout dependency not pinned', id: 'demo', dependency: 'git-sync' }));
    expect(lines).toContainEqual(expect.objectContaining({ level: 'info', msg: 'loadout automations not installed', id: 'demo' }));
    expect(await exists('automations')).toBe(false);
  });
});
