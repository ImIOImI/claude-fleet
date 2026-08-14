// Unit tests for buildEnv in local.ts (#250 security fix).
// Verifies that endpoint workspaces don't inherit the host ANTHROPIC_API_KEY,
// while oauth/apikey workspaces do, and that an explicit workspace env entry
// for ANTHROPIC_API_KEY is still honoured on endpoint workspaces.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron so the module loads outside Electron.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/cf-test-userData',
    getVersion: () => '0.0.0-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));

// Mock vault so resolveEnv doesn't hit safeStorage/disk.
vi.mock('./vault.js', () => ({
  resolveEnv: async (
    _id: string,
    plain: Record<string, string>,
    _secretKeys: string[]
  ): Promise<Record<string, string>> => ({ ...plain })
}));

// Mock endpoints so endpointEnv doesn't hit disk.
vi.mock('./endpoints.js', () => ({
  endpointEnv: async (_endpointId: string | undefined): Promise<Record<string, string>> => ({
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'claude-fleet',
    ANTHROPIC_MODEL: 'qwen3:4b',
    ANTHROPIC_SMALL_FAST_MODEL: 'qwen3:4b',
    CF_SUMMARY_MODEL: 'qwen3:4b'
  })
}));

// Mock node-pty (lazy-required by local.ts but not needed for buildEnv tests).
vi.mock('node-pty', () => ({}));

// Dynamic import AFTER mocks are registered.
const { buildEnv } = await import('./local.js');

const fakeEnv = (plain: Record<string, string> = {}) => ({
  env: { plain, secretKeys: [] as string[] }
});

describe('buildEnv — ANTHROPIC_API_KEY inheritance', () => {
  const REAL_KEY = 'sk-ant-real-host-key';

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', REAL_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('endpoint workspace does NOT inherit the host ANTHROPIC_API_KEY', async () => {
    const env = await buildEnv('ws1', { ...fakeEnv(), authMode: 'endpoint', endpointId: 'ep1' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('oauth workspace still inherits the host ANTHROPIC_API_KEY', async () => {
    const env = await buildEnv('ws1', { ...fakeEnv(), authMode: 'oauth' });
    expect(env.ANTHROPIC_API_KEY).toBe(REAL_KEY);
  });

  it('apikey workspace still inherits the host ANTHROPIC_API_KEY', async () => {
    const env = await buildEnv('ws1', { ...fakeEnv(), authMode: 'apikey' });
    expect(env.ANTHROPIC_API_KEY).toBe(REAL_KEY);
  });

  it('endpoint workspace with explicit workspace ANTHROPIC_API_KEY keeps that value', async () => {
    const explicit = 'sk-ant-workspace-explicit';
    const env = await buildEnv('ws1', {
      ...fakeEnv({ ANTHROPIC_API_KEY: explicit }),
      authMode: 'endpoint',
      endpointId: 'ep1'
    });
    // resolveEnv returns plain env as-is (mocked above), so the explicit key
    // from the workspace env spreads last and wins.
    expect(env.ANTHROPIC_API_KEY).toBe(explicit);
  });
});

describe('buildEnv — claude child-session markers (#285)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // When the fleet app is itself launched from inside a claude session (e.g. a
  // `claude` Bash tool ran `npm run dev`), its environment carries claude's
  // child-session markers. A local workspace inherits `{ ...process.env }`, so
  // without scrubbing, the spawned claude sees CLAUDE_CODE_CHILD_SESSION and
  // turns transcript saving OFF — no .jsonl is written, the watcher ingests
  // nothing, and the session shows $0.00 with no busy attribution.
  it('strips CLAUDE_CODE_CHILD_SESSION so the spawned claude saves its transcript', async () => {
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1');
    const env = await buildEnv('ws1', { ...fakeEnv(), authMode: 'oauth' });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });

  it('strips the CLAUDECODE nested marker', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const env = await buildEnv('ws1', { ...fakeEnv(), authMode: 'oauth' });
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it('an explicit workspace override of a marker is still honoured', async () => {
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1');
    const env = await buildEnv('ws1', {
      ...fakeEnv({ CLAUDE_CODE_CHILD_SESSION: 'keep-me' }),
      authMode: 'oauth'
    });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe('keep-me');
  });
});
