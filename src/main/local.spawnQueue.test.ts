// attachPty routes spawns through the spawn queue; queued attaches must
// re-check state when they run (tab closed, workspace stopped, newer attach).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PtyProc, SpawnPty } from './localSessions.js';

const USER_DATA = join(tmpdir(), `cf-local-spawnq-${process.pid}`);

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getVersion: () => '0.0.0-test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));
vi.mock('./vault.js', () => ({
  resolveEnv: async (_id: string, plain: Record<string, string>) => ({ ...plain })
}));
vi.mock('./endpoints.js', () => ({ endpointEnv: async () => ({}) }));
vi.mock('node-pty', () => ({}));
const lookup = vi.fn<(ws: string, sid: string) => Promise<string | null>>(async () => null);
vi.mock('./db.js', () => ({
  recordBrokerSessionMapping: async () => ({ mode: 'committed', previous: null }),
  recordUsageEvent: async () => {},
  lookupResumableBrokerSession: (ws: string, sid: string) => lookup(ws, sid)
}));
vi.mock('./errorLog.js', () => ({ logError: () => {} }));
vi.mock('./mirrorPolicy.js', () => ({ learnMapping: () => {} }));
vi.mock('./claims/retention.js', () => ({ ensureLocalRetentionSettings: async () => undefined }));
vi.mock('./claudeResolve.js', async (orig) => ({
  ...(await orig<typeof import('./claudeResolve.js')>()),
  findClaude: async () => '/usr/bin/claude'
}));

const local = await import('./local.js');
const { SpawnCancelledError } = await import('./spawnQueue.js');
const { _resetForTest: resetSessions } = await import('./localSessions.js');
const { writeWorkspaceManifest } = await import('./workspaces.js');

const WS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const spawned: Array<{ sid: string | undefined; args: string[] }> = [];
const fakeSpawn: SpawnPty = ({ args, env }) => {
  spawned.push({ sid: env.CLAUDE_FLEET_BROKER_SESSION_ID, args });
  const proc: PtyProc = {
    pid: 1000 + spawned.length,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {}
  };
  return proc;
};

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error('timed out waiting for condition');
}

/** Occupy the queue: the blocker's task parks in the resume lookup. */
async function startBlocker(): Promise<{ attach: Promise<unknown>; release: () => void }> {
  let release!: () => void;
  const gate = new Promise<null>((r) => (release = () => r(null)));
  lookup.mockImplementation(async (_ws, sid) => (sid === 'blocker' ? gate : null));
  const attach = local.attachPty(WS_ID, 'blocker', 120, 40);
  attach.catch(() => {});
  await until(() => lookup.mock.calls.some(([, sid]) => sid === 'blocker'));
  return { attach, release };
}

beforeEach(async () => {
  local._resetForTest();
  resetSessions();
  local._setSpawnForTest(fakeSpawn);
  spawned.length = 0;
  lookup.mockReset();
  lookup.mockImplementation(async () => null);
  await rm(USER_DATA, { recursive: true, force: true });
  await mkdir(join(USER_DATA, 'state'), { recursive: true });
  await writeWorkspaceManifest({
    id: WS_ID,
    name: 'ws',
    labels: [],
    workspaceRoot: '/home/user/project',
    workspaceSubdir: '',
    kind: 'local',
    authMode: 'oauth',
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on', cleanup: 'delete' },
    createdAt: 1,
    lastUsedAt: 1
  });
});

afterEach(async () => {
  local._setSpawnForTest();
  await rm(USER_DATA, { recursive: true, force: true });
});

describe('local attachPty spawn queue', () => {
  it('spawns a restored tab through the queue', async () => {
    await local.attachPty(WS_ID, 'tab', 120, 40);
    expect(spawned.map((s) => s.sid)).toEqual(['tab']);
  });

  it('cancels a queued spawn when the tab is closed', async () => {
    const b = await startBlocker();
    const tab = local.attachPty(WS_ID, 'tab', 120, 40);
    await until(() => local._pendingSpawnsForTest() === 1);
    expect(local.cancelPendingAttach(WS_ID, 'tab')).toBe(true);
    await expect(tab).rejects.toBeInstanceOf(SpawnCancelledError);
    b.release();
    await b.attach;
    expect(spawned.map((s) => s.sid)).toEqual(['blocker']);
  });

  it('does not spawn queued or in-flight attaches once the workspace is stopped', async () => {
    const b = await startBlocker();
    const tab = local.attachPty(WS_ID, 'tab', 120, 40);
    const tabErr = tab.catch((e: unknown) => e);
    await until(() => local._pendingSpawnsForTest() === 1);
    await local.stopWorkspace(WS_ID);
    expect(await tabErr).toBeInstanceOf(SpawnCancelledError);
    b.release();
    await expect(b.attach).rejects.toThrow(/is not running/);
    expect(spawned).toEqual([]);
  });

  it('a newer attach for the same tab wins and its resume target is used', async () => {
    const b = await startBlocker();
    const older = local.attachPty(WS_ID, 'tab', 120, 40, 'claude-old');
    const newer = local.attachPty(WS_ID, 'tab', 120, 40, 'claude-new');
    await expect(older).rejects.toBeInstanceOf(SpawnCancelledError);
    await until(() => local._pendingSpawnsForTest() === 1);
    b.release();
    await b.attach;
    await newer;
    const tabSpawns = spawned.filter((s) => s.sid === 'tab');
    expect(tabSpawns).toHaveLength(1);
    expect(tabSpawns[0].args).toEqual(expect.arrayContaining(['--resume', 'claude-new']));
    expect(tabSpawns[0].args).not.toContain('claude-old');
  });

  it('re-attaching a live tab skips the queue and spawns nothing', async () => {
    await local.attachPty(WS_ID, 'tab', 120, 40);
    const b = await startBlocker();
    await local.attachPty(WS_ID, 'tab', 120, 40);
    expect(spawned.map((s) => s.sid)).toEqual(['tab']);
    b.release();
    await b.attach;
  });
});
