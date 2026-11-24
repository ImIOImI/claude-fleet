// attachPty's WSL passEnvKeys must come from the vault-resolved workspace
// env, not the manifest env.plain/secretKeys.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PtyProc, SpawnPty } from './localSessions.js';

const USER_DATA = join(tmpdir(), `cf-local-passenvkeys-${process.pid}`);

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getVersion: () => '0.0.0-test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));

const resolvedEnv = { ANTHROPIC_API_KEY: 'sk-test', MYAPP_TOKEN: 'custom-secret' };
vi.mock('./vault.js', () => ({ resolveWorkspaceEnv: async (_id: string) => resolvedEnv }));
vi.mock('./endpoints.js', () => ({ endpointEnv: async () => ({}) }));
vi.mock('node-pty', () => ({}));
vi.mock('./db.js', () => ({
  recordBrokerSessionMapping: async () => ({ mode: 'committed', previous: null }),
  recordUsageEvent: async () => {},
  lookupResumableBrokerSession: async () => null
}));
vi.mock('./errorLog.js', () => ({ logError: () => {} }));
vi.mock('./mirrorPolicy.js', () => ({ learnMapping: () => {} }));
vi.mock('./claims/retention.js', () => ({ ensureLocalRetentionSettings: async () => undefined }));
vi.mock('./claudeResolve.js', async (orig) => ({
  ...(await orig<typeof import('./claudeResolve.js')>()),
  findClaude: async () => '/usr/bin/claude'
}));

// Capture the opts wrapSpawnForLauncher is called with, delegating to the
// real implementation so native-mode spawning (used in this test) behaves
// exactly as before.
const passEnvKeysCalls: (string[] | undefined)[] = [];
vi.mock('./localLauncher.js', async (orig) => {
  const actual = await orig<typeof import('./localLauncher.js')>();
  return {
    ...actual,
    wrapSpawnForLauncher: (
      launcher: Parameters<typeof actual.wrapSpawnForLauncher>[0],
      inner: Parameters<typeof actual.wrapSpawnForLauncher>[1],
      opts: Parameters<typeof actual.wrapSpawnForLauncher>[2]
    ) => {
      passEnvKeysCalls.push(opts.passEnvKeys);
      return actual.wrapSpawnForLauncher(launcher, inner, opts);
    }
  };
});

const local = await import('./local.js');
const { _resetForTest: resetSessions } = await import('./localSessions.js');
const { writeWorkspaceManifest } = await import('./workspaces.js');

const WS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const fakeSpawn: SpawnPty = () => {
  const proc: PtyProc = {
    pid: 1234,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {}
  };
  return proc;
};

beforeEach(async () => {
  local._resetForTest();
  resetSessions();
  local._setSpawnForTest(fakeSpawn);
  local._setResumeLookupTimeoutForTest(3000);
  passEnvKeysCalls.length = 0;
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

describe('attachPty passEnvKeys (vault-resolved env)', () => {
  it('derives passEnvKeys from the vault-resolved env, not the (empty) manifest env', async () => {
    await local.attachPty(WS_ID, 'tab', 120, 40);
    expect(passEnvKeysCalls).toHaveLength(1);
    expect(passEnvKeysCalls[0]).toEqual(expect.arrayContaining(['MYAPP_TOKEN', 'ANTHROPIC_API_KEY']));
  });
});
