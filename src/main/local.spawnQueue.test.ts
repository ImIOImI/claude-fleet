// attachPty routes spawns through the spawn queue; queued attaches must
// re-check state when they run (tab closed, workspace stopped, newer attach).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, stat } from 'node:fs/promises';
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
// Gates consumed one per manifest read, to hold stopWorkspace mid-flight.
const manifestGates: Array<Promise<void>> = [];
vi.mock('./workspaces.js', async (orig) => {
  const actual = await orig<typeof import('./workspaces.js')>();
  return {
    ...actual,
    readWorkspaceManifest: async (id: string) => {
      const gate = manifestGates.shift();
      if (gate) await gate;
      return actual.readWorkspaceManifest(id);
    }
  };
});
// One-shot gate on the next mkdir of a workspace state dir (the live-state write).
const mkdirGate: { next: Promise<void> | null; hit: boolean } = { next: null, hit: false };
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  const mkdirGated = async (...args: Parameters<typeof actual.mkdir>) => {
    const gate = mkdirGate.next;
    if (gate && String(args[0]).includes(join('state', '01ARZ3NDEKTSV4RRFFQ69G5FAV'))) {
      mkdirGate.next = null;
      mkdirGate.hit = true;
      await gate;
    }
    return actual.mkdir(...args);
  };
  return { ...actual, mkdir: mkdirGated, default: { ...actual, mkdir: mkdirGated } };
});

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

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

/** Occupy the queue and wait until it is actually running the hold. */
async function holdQueue(): Promise<() => void> {
  const release = local._holdSpawnQueueForTest();
  await until(() => local._pendingSpawnsForTest() === 0);
  return release;
}

beforeEach(async () => {
  local._resetForTest();
  resetSessions();
  local._setSpawnForTest(fakeSpawn);
  local._setResumeLookupTimeoutForTest(3000);
  manifestGates.length = 0;
  mkdirGate.next = null;
  mkdirGate.hit = false;
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
    const release = await holdQueue();
    const tab = local.attachPty(WS_ID, 'tab', 120, 40);
    const tabErr = tab.catch((e: unknown) => e);
    await until(() => local._pendingSpawnsForTest() === 1);
    expect(local.cancelPendingAttach(WS_ID, 'tab')).toBe(true);
    expect(await tabErr).toBeInstanceOf(SpawnCancelledError);
    release();
    await local.attachPty(WS_ID, 'other', 120, 40);
    expect(spawned.map((s) => s.sid)).toEqual(['other']);
  });

  it('does not spawn queued attaches once the workspace is stopped', async () => {
    const release = await holdQueue();
    const tab = local.attachPty(WS_ID, 'tab', 120, 40);
    const tabErr = tab.catch((e: unknown) => e);
    await until(() => local._pendingSpawnsForTest() === 1);
    await local.stopWorkspace(WS_ID);
    expect(await tabErr).toBeInstanceOf(SpawnCancelledError);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned).toEqual([]);
  });

  it('refuses an attach that arrives while a stop is still in flight', async () => {
    await local.attachPty(WS_ID, 'tab', 120, 40);
    const g = gate();
    manifestGates.push(g.promise);
    const stop = local.stopWorkspace(WS_ID);
    const late = local.attachPty(WS_ID, 'late', 120, 40);
    await expect(late).rejects.toThrow(/is not running/);
    g.release();
    await stop;
    expect(spawned.map((s) => s.sid)).toEqual(['tab']);
    expect((await local.listLiveWorkspaces()).find((w) => w.id === WS_ID)?.state).toBe('stopped');
  });

  it('overlapping stops keep the guard up until the last one finishes', async () => {
    await local.attachPty(WS_ID, 'tab', 120, 40);
    const g1 = gate();
    const g2 = gate();
    manifestGates.push(g1.promise, g2.promise);
    const stop1 = local.stopWorkspace(WS_ID);
    const stop2 = local.stopWorkspace(WS_ID);
    g2.release();
    await stop2;
    // stop1 is still in flight.
    await expect(local.attachPty(WS_ID, 'late', 120, 40)).rejects.toThrow(/is not running/);
    g1.release();
    await stop1;
    expect(spawned.map((s) => s.sid)).toEqual(['tab']);
    // Guard is down once both finished: attaching restarts the workspace.
    await local.attachPty(WS_ID, 'after', 120, 40);
    expect(spawned.map((s) => s.sid)).toEqual(['tab', 'after']);
  });

  it("an attach's live-state write cannot land after a concurrent stop's removal", async () => {
    const g = gate();
    mkdirGate.next = g.promise;
    const attach = local.attachPty(WS_ID, 'tab', 120, 40);
    const attachErr = attach.catch((e: unknown) => e);
    await until(() => mkdirGate.hit); // attach is mid-write, having seen started=true
    const stop = local.stopWorkspace(WS_ID);
    // Let the stop reach its own live-state removal before the attach's write resumes.
    await new Promise((r) => setTimeout(r, 50));
    g.release();
    await stop;
    expect(await attachErr).toBeInstanceOf(Error);
    const file = join(USER_DATA, 'state', WS_ID, 'local-live.json');
    expect(await stat(file).catch(() => null)).toBeNull();
    local._resetForTest(); // app restart
    expect((await local.listLiveWorkspaces()).find((w) => w.id === WS_ID)?.state).toBe('stopped');
    expect(spawned).toEqual([]);
  });

  it('a newer attach for the same tab wins and its resume target is used', async () => {
    const release = await holdQueue();
    const older = local.attachPty(WS_ID, 'tab', 120, 40, 'claude-old');
    const olderErr = older.catch((e: unknown) => e);
    const newer = local.attachPty(WS_ID, 'tab', 120, 40, 'claude-new');
    expect(await olderErr).toBeInstanceOf(SpawnCancelledError);
    await until(() => local._pendingSpawnsForTest() === 1);
    release();
    await newer;
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(expect.arrayContaining(['--resume', 'claude-new']));
    expect(spawned[0].args).not.toContain('claude-old');
  });

  it('a stalled resume lookup does not hold up other spawns, and times out to a fresh spawn', async () => {
    local._setResumeLookupTimeoutForTest(100);
    lookup.mockImplementation((_ws, sid) => (sid === 'stalled' ? new Promise<string | null>(() => {}) : Promise.resolve(null)));
    const stalled = local.attachPty(WS_ID, 'stalled', 120, 40);
    await until(() => lookup.mock.calls.some(([, sid]) => sid === 'stalled'));
    await local.attachPty(WS_ID, 'tab', 120, 40);
    expect(spawned.map((s) => s.sid)).toEqual(['tab']);
    await stalled;
    expect(spawned.map((s) => s.sid)).toEqual(['tab', 'stalled']);
    const s = spawned[1];
    expect(s.args).not.toContain('--resume');
    expect(s.args).toContain('--session-id');
  });

  it('re-attaching a live tab skips the queue and spawns nothing', async () => {
    await local.attachPty(WS_ID, 'tab', 120, 40);
    const release = await holdQueue();
    await local.attachPty(WS_ID, 'tab', 120, 40);
    expect(spawned.map((s) => s.sid)).toEqual(['tab']);
    release();
  });
});
