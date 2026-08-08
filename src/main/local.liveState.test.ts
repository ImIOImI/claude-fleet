// Warm-state persistence for local workspaces (WSL restart bugs).
//
// The local backend's liveness used to be in-memory only (`started`/`paused`
// sets), so every app restart demoted all local workspaces to 'stopped' and
// their chips vanished from the warm strip. The backend now persists the
// warm state to `<stateDir>/<id>/local-live.json` on every transition and
// rehydrates it once at the first listLiveWorkspaces() of a run.
// `_resetForTest()` simulates an app restart (in-memory sets die, the disk
// file survives).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const USER_DATA = join(tmpdir(), `cf-local-live-${process.pid}`);

vi.mock('electron', () => ({
  app: {
    getPath: () => USER_DATA,
    getVersion: () => '0.0.0-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));
vi.mock('./vault.js', () => ({
  resolveEnv: async (_id: string, plain: Record<string, string>) => ({ ...plain })
}));
vi.mock('./endpoints.js', () => ({
  endpointEnv: async () => ({})
}));
vi.mock('node-pty', () => ({}));
vi.mock('./db.js', () => ({
  recordBrokerSessionMapping: () => ({ mode: 'committed', previous: null }),
  recordUsageEvent: () => {},
  lookupResumableBrokerSession: () => null
}));
vi.mock('./errorLog.js', () => ({ logError: () => {} }));
vi.mock('./mirrorPolicy.js', () => ({ learnMapping: () => {} }));

const local = await import('./local.js');
const { writeWorkspaceManifest } = await import('./workspaces.js');

const WS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function manifest(id: string) {
  return {
    id,
    name: `ws-${id.slice(-4)}`,
    labels: [],
    workspaceRoot: '/home/user/project',
    workspaceSubdir: '',
    kind: 'local' as const,
    authMode: 'oauth' as const,
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on' as const, cleanup: 'delete' as const },
    createdAt: 1,
    lastUsedAt: 1
  };
}

async function stateOf(id: string): Promise<string | undefined> {
  const all = await local.listLiveWorkspaces();
  return all.find((w) => w.id === id)?.state;
}

beforeEach(async () => {
  local._resetForTest();
  await rm(USER_DATA, { recursive: true, force: true });
  await mkdir(join(USER_DATA, 'state'), { recursive: true });
  await writeWorkspaceManifest(manifest(WS_ID));
});

afterEach(async () => {
  await rm(USER_DATA, { recursive: true, force: true });
});

describe('local warm-state persistence across app restarts', () => {
  it('a created (running) workspace is still running after a restart', async () => {
    await local.createWorkspace({
      id: WS_ID,
      name: 'ws',
      workspaceSubdir: '',
      env: { plain: {}, secretKeys: [] },
      authMode: 'oauth',
      kind: 'local',
      workspaceRoot: '/home/user/project'
    });
    expect(await stateOf(WS_ID)).toBe('running');

    local._resetForTest(); // app restart: in-memory sets die
    expect(await stateOf(WS_ID)).toBe('running'); // rehydrated from disk
  });

  it('a stopped workspace stays stopped after a restart', async () => {
    await local.startWorkspace(WS_ID);
    await local.stopWorkspace(WS_ID);
    local._resetForTest();
    expect(await stateOf(WS_ID)).toBe('stopped');
  });

  it('start after a restart persists again (no stale rehydration writes)', async () => {
    await local.startWorkspace(WS_ID);
    local._resetForTest();
    expect(await stateOf(WS_ID)).toBe('running');
    await local.stopWorkspace(WS_ID);
    local._resetForTest();
    expect(await stateOf(WS_ID)).toBe('stopped');
  });

  it('a persisted paused state (wsl pause from a previous run) rehydrates as paused', async () => {
    // pauseWorkspace is wsl-only and the wsl launcher can't round-trip through
    // a manifest on linux (sanitizeLauncher is win32-gated), so write the
    // on-disk contract directly — this is the file a win32 run leaves behind.
    await mkdir(join(USER_DATA, 'state', WS_ID), { recursive: true });
    await writeFile(
      join(USER_DATA, 'state', WS_ID, 'local-live.json'),
      JSON.stringify({ state: 'paused' }),
      'utf8'
    );
    expect(await stateOf(WS_ID)).toBe('paused');
  });

  it('a malformed live-state file degrades to stopped', async () => {
    await mkdir(join(USER_DATA, 'state', WS_ID), { recursive: true });
    await writeFile(join(USER_DATA, 'state', WS_ID, 'local-live.json'), 'not json', 'utf8');
    expect(await stateOf(WS_ID)).toBe('stopped');
  });

  it('stop removes the persisted state file', async () => {
    await local.startWorkspace(WS_ID);
    const file = join(USER_DATA, 'state', WS_ID, 'local-live.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ state: 'running' });
    await local.stopWorkspace(WS_ID);
    await expect(stat(file)).rejects.toThrow();
  });
});

describe('effectiveResumeOf — cross-restart auto-resume decision', () => {
  it('prefers an explicit resume target', () => {
    expect(local.effectiveResumeOf('explicit-uuid', false, () => 'mapped-uuid')).toBe(
      'explicit-uuid'
    );
  });

  it('never auto-resumes over a live pty (re-attach ignores resume args anyway)', () => {
    expect(local.effectiveResumeOf(undefined, true, () => 'mapped-uuid')).toBeUndefined();
  });

  it('auto-resumes the mapped conversation when the tab has no live pty', () => {
    expect(local.effectiveResumeOf(undefined, false, () => 'mapped-uuid')).toBe('mapped-uuid');
  });

  it('spawns fresh when no resumable mapping exists', () => {
    expect(local.effectiveResumeOf(undefined, false, () => null)).toBeUndefined();
  });

  it('spawns fresh when the DB is dormant (lookup throws — mock mode)', () => {
    expect(
      local.effectiveResumeOf(undefined, false, () => {
        throw new Error('db not open');
      })
    ).toBeUndefined();
  });
});
