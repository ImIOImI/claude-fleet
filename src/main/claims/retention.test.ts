import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
vi.mock('electron', () => ({ app: { getPath: () => userDataDir, isPackaged: false } }));
const { ensureContainerRetention, ensureLocalRetentionSettings, mergeCleanupPeriod, LOCAL_RETENTION_SETTINGS_FILE } = await import('./retention.js');
const { workspaceClaudeDir, workspaceStateDir } = await import('../paths.js');

const ID = '01CAPTURERETENTION000000WS';
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
});

describe('retention files', () => {
  it('container: writes ~/.claude/settings.json on the host side of the bind, keeping other keys', async () => {
    await mkdir(workspaceClaudeDir(ID), { recursive: true });
    await writeFile(join(workspaceClaudeDir(ID), 'settings.json'), '{"model":"opus"}');
    expect(await ensureContainerRetention(ID, 400)).toBe(true);
    expect(JSON.parse(await readFile(join(workspaceClaudeDir(ID), 'settings.json'), 'utf8'))).toEqual({ model: 'opus', cleanupPeriodDays: 400 });
    expect(await ensureContainerRetention(ID, 400)).toBe(false);
  });
  it('local: writes a per-workspace settings file and returns its path', async () => {
    const p = await ensureLocalRetentionSettings(ID, 730);
    expect(p).toBe(join(workspaceStateDir(ID), LOCAL_RETENTION_SETTINGS_FILE));
    expect(JSON.parse(await readFile(p, 'utf8'))).toEqual({ cleanupPeriodDays: 730 });
  });
});
