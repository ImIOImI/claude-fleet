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
const { ensureWorkspaceClaudeJson } = await import('./docker.js');
const { workspaceClaudeJsonPath } = await import('./paths.js');

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
