// Unit tests for ensureWorkspaceClaudeJson — the per-workspace ~/.claude.json
// seed that pre-completes claude-code onboarding so freshly-created
// containers don't re-run the theme/trust/setup wizard (fixes the gap left
// by Phase 3 #57, which shared only the credential token).
//
// We mock `electron` so `app.getPath('userData')` resolves to a temp dir,
// matching migration.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    }
  }
}));

// Imported AFTER the mock so paths.ts picks up the stubbed electron.app.
const { ensureWorkspaceClaudeJson, ensureSharedRemoteSettingsFile, ensureWorkspaceNotificationHook } =
  await import('./docker.js');
const { workspaceClaudeJsonPath, sharedRemoteSettingsPath, workspaceSettingsPath, workspaceInputRequestsPath } =
  await import('./paths.js');

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'claude-fleet-claudejson-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe('ensureWorkspaceClaudeJson', () => {
  it('seeds an absent file with onboarding completed and trust for the working dir', async () => {
    const path = await ensureWorkspaceClaudeJson('01ABC', '/workspace/app');
    expect(path).toBe(workspaceClaudeJsonPath('01ABC'));

    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.hasCompletedOnboarding).toBe(true);
    expect(parsed.projects['/workspace/app'].hasTrustDialogAccepted).toBe(true);
  });

  it('creates the parent state dir if missing', async () => {
    const path = await ensureWorkspaceClaudeJson('01FRESH', '/workspace');
    await expect(stat(path)).resolves.toBeTruthy();
  });

  it('does not overwrite an existing file (claude owns it once it runs)', async () => {
    const path = workspaceClaudeJsonPath('01KEEP');
    // Simulate claude having rewritten the file with real accumulated state.
    const real = JSON.stringify({ hasCompletedOnboarding: true, numStartups: 7, projects: {} });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(userDataDir, 'state', '01KEEP'), { recursive: true });
    await writeFile(path, real, 'utf8');
    const past = Date.now() / 1000 - 100;
    await utimes(path, past, past);

    const returned = await ensureWorkspaceClaudeJson('01KEEP', '/workspace');
    expect(returned).toBe(path);
    expect(await readFile(path, 'utf8')).toBe(real);
  });
});

describe('ensureWorkspaceNotificationHook', () => {
  it('seeds a Notification hook + touches the sidecar when settings is absent', async () => {
    const id = '01HOOK000000000000000000A';
    await ensureWorkspaceNotificationHook(id);

    const settings = JSON.parse(await readFile(workspaceSettingsPath(id), 'utf8'));
    const cmd = settings.hooks.Notification[0].hooks[0].command;
    expect(cmd).toContain('input-requests.jsonl');
    expect(settings.hooks.Notification[0].hooks[0].type).toBe('command');
    // Sidecar exists (empty) so the watcher can tail it.
    expect(await readFile(workspaceInputRequestsPath(id), 'utf8')).toBe('');
  });

  it('merges into existing settings without clobbering and is idempotent', async () => {
    const id = '01HOOK000000000000000000B';
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(userDataDir, 'state', id, '.claude'), { recursive: true });
    await writeFile(workspaceSettingsPath(id), JSON.stringify({ theme: 'dark' }), 'utf8');

    await ensureWorkspaceNotificationHook(id);
    await ensureWorkspaceNotificationHook(id); // second call must not duplicate

    const settings = JSON.parse(await readFile(workspaceSettingsPath(id), 'utf8'));
    expect(settings.theme).toBe('dark'); // preserved
    expect(settings.hooks.Notification).toHaveLength(1); // not duplicated
  });
});

describe('ensureSharedRemoteSettingsFile', () => {
  it('touches an empty file when absent so Docker can bind it', async () => {
    const path = await ensureSharedRemoteSettingsFile();
    expect(path).toBe(sharedRemoteSettingsPath());
    expect(await readFile(path, 'utf8')).toBe('');
  });

  it('leaves an already-populated shared file untouched', async () => {
    const path = sharedRemoteSettingsPath();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(userDataDir, 'claude-shared'), { recursive: true });
    // Simulate claude having written the approved org settings in place.
    const approved = JSON.stringify({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'x' } });
    await writeFile(path, approved, 'utf8');

    const returned = await ensureSharedRemoteSettingsFile();
    expect(returned).toBe(path);
    expect(await readFile(path, 'utf8')).toBe(approved);
  });
});
