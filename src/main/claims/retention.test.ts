import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
vi.mock('electron', () => ({ app: { getPath: () => userDataDir, isPackaged: false } }));
const {
  ensureContainerRetention, ensureLocalRetentionSettings, mergeCleanupPeriod, userCleanupDays, userClaudeSettingsPath,
  LOCAL_RETENTION_SETTINGS_FILE
} = await import('./retention.js');
const { workspaceClaudeDir, workspaceStateDir } = await import('../paths.js');

const ID = '01CAPTURERETENTION000000WS';
const WSL = { mode: 'wsl', distro: 'Ubuntu', shell: '/bin/bash', home: '/home/t', claudePath: '/x' } as const;
const WSL_USER_SETTINGS = String.raw`\\wsl.localhost\Ubuntu\home\t\.claude\settings.json`;
beforeEach(async () => { userDataDir = await mkdtemp(join(tmpdir(), 'cf-retention-')); });
afterEach(async () => { await rm(userDataDir, { recursive: true, force: true }); });

describe('mergeCleanupPeriod (#483 §5a)', () => {
  it('creates, updates, preserves other keys, and leaves malformed or unchanged files alone', () => {
    expect(JSON.parse(mergeCleanupPeriod(null, 365)!)).toEqual({ cleanupPeriodDays: 365 });
    expect(JSON.parse(mergeCleanupPeriod('{"theme":"dark","cleanupPeriodDays":30}', 90)!)).toEqual({ theme: 'dark', cleanupPeriodDays: 90 });
    expect(mergeCleanupPeriod('{"cleanupPeriodDays":90}', 90)).toBeNull();
    expect(mergeCleanupPeriod('{not json', 90)).toBeNull();
    expect(mergeCleanupPeriod('[1,2]', 90)).toBeNull();
  });
  it('never lowers an existing higher value', () => {
    expect(mergeCleanupPeriod('{"cleanupPeriodDays":1000}', 365)).toBeNull();
    expect(JSON.parse(mergeCleanupPeriod('{"cleanupPeriodDays":"x"}', 365)!)).toEqual({ cleanupPeriodDays: 365 });
  });
});

describe('userCleanupDays / userClaudeSettingsPath', () => {
  it("reads the user's cleanupPeriodDays; absent, unreadable or malformed means Claude's default 30", () => {
    expect(userCleanupDays('{"cleanupPeriodDays":500}')).toBe(500);
    expect(userCleanupDays('{"cleanupPeriodDays":7}')).toBe(7);
    expect(userCleanupDays('{"theme":"dark"}')).toBe(30);
    expect(userCleanupDays(null)).toBe(30);
    expect(userCleanupDays('{nope')).toBe(30);
    expect(userCleanupDays('{"cleanupPeriodDays":"9"}')).toBe(30);
  });
  it("locates the user's settings: native ~/.claude (or CLAUDE_CONFIG_DIR), WSL via the distro home over \\\\wsl.localhost", () => {
    expect(userClaudeSettingsPath(WSL)).toBe(WSL_USER_SETTINGS);
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/cfg';
    try { expect(userClaudeSettingsPath({ mode: 'native' })).toBe(join('/cfg', 'settings.json')); }
    finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
  });
});

describe('retention files', () => {
  it('container: writes ~/.claude/settings.json on the host side of the bind, keeping other keys', async () => {
    await mkdir(workspaceClaudeDir(ID), { recursive: true });
    await writeFile(join(workspaceClaudeDir(ID), 'settings.json'), '{"model":"opus"}');
    expect(await ensureContainerRetention(ID, 400)).toBe(true);
    expect(JSON.parse(await readFile(join(workspaceClaudeDir(ID), 'settings.json'), 'utf8'))).toEqual({ model: 'opus', cleanupPeriodDays: 400 });
    expect(await ensureContainerRetention(ID, 400)).toBe(false);
  });
  it("container: never lowers a higher value already in the container's settings file", async () => {
    await mkdir(workspaceClaudeDir(ID), { recursive: true });
    await writeFile(join(workspaceClaudeDir(ID), 'settings.json'), '{"cleanupPeriodDays":2000}');
    expect(await ensureContainerRetention(ID, 365)).toBe(false);
    expect(JSON.parse(await readFile(join(workspaceClaudeDir(ID), 'settings.json'), 'utf8'))).toEqual({ cleanupPeriodDays: 2000 });
  });
  it("local: only raises — writes the workspace value when it beats the user's own, else passes nothing", async () => {
    const native = { mode: 'native' } as const;
    const reads: string[] = [];
    const user = (text: string | null) => async (p: string) => { reads.push(p); return text; };
    const p = await ensureLocalRetentionSettings(ID, 730, native, user('{"cleanupPeriodDays":90}'));
    expect(p).toBe(join(workspaceStateDir(ID), LOCAL_RETENTION_SETTINGS_FILE));
    expect(JSON.parse(await readFile(p!, 'utf8'))).toEqual({ cleanupPeriodDays: 730 });
    expect(reads).toEqual([userClaudeSettingsPath(native)]);
    // The user's own longer (or equal) retention wins: no --settings, so it is never lowered.
    expect(await ensureLocalRetentionSettings(ID, 365, native, user('{"cleanupPeriodDays":1000}'))).toBeUndefined();
    expect(await ensureLocalRetentionSettings(ID, 365, native, user('{"cleanupPeriodDays":365}'))).toBeUndefined();
    // An absent user setting is Claude's default 30.
    expect(await ensureLocalRetentionSettings(ID, 30, native, user(null))).toBeUndefined();
    expect(await ensureLocalRetentionSettings(ID, 31, native, user(null))).toBeDefined();
  });
  it('local WSL: reads the in-distro user settings over \\\\wsl.localhost', async () => {
    const reads: string[] = [];
    expect(await ensureLocalRetentionSettings(ID, 365, WSL, async (p) => { reads.push(p); return '{"cleanupPeriodDays":999}'; })).toBeUndefined();
    expect(reads).toEqual([WSL_USER_SETTINGS]);
  });
});
