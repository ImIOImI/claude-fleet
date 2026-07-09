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
const { ensureWorkspaceClaudeJson, ensureSharedRemoteSettingsFile } = await import('./docker.js');
const { workspaceClaudeJsonPath, sharedRemoteSettingsPath } = await import('./paths.js');

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
    // The read-only state-DB MCP server (#12) is auto-wired via a user-scope
    // mcpServers entry: the reconnect+resend node bridge over the socket in
    // the bound /fleet/mcp dir. It survives the host server's inode-changing
    // restart while a paused container is alive (#18) and re-sends unanswered
    // requests after an app restart (the first-call hang).
    expect(parsed.mcpServers['claude-fleet-state']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/fleet/mcp/bridge.cjs'],
      env: { CLAUDE_FLEET_MCP_UNIX: '/fleet/mcp/mcp.sock' }
    });
  });

  it('creates the parent state dir if missing', async () => {
    const path = await ensureWorkspaceClaudeJson('01FRESH', '/workspace');
    await expect(stat(path)).resolves.toBeTruthy();
  });

  it("preserves claude's accumulated state but reconciles the managed mcpServers entry", async () => {
    const path = workspaceClaudeJsonPath('01KEEP');
    // Simulate claude having rewritten the file with real accumulated state
    // PLUS the (now-stale) one-shot socat MCP command from before #18.
    const real = {
      hasCompletedOnboarding: true,
      numStartups: 7,
      projects: { '/workspace': { hasTrustDialogAccepted: true } },
      mcpServers: {
        'claude-fleet-state': { type: 'stdio', command: 'socat', args: ['-', 'UNIX-CONNECT:/fleet/mcp.sock'] }
      }
    };
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(userDataDir, 'state', '01KEEP'), { recursive: true });
    await writeFile(path, JSON.stringify(real), 'utf8');

    const returned = await ensureWorkspaceClaudeJson('01KEEP', '/workspace');
    expect(returned).toBe(path);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    // Claude's own state is untouched...
    expect(parsed.numStartups).toBe(7);
    expect(parsed.hasCompletedOnboarding).toBe(true);
    expect(parsed.projects['/workspace'].hasTrustDialogAccepted).toBe(true);
    // ...but the stale socat command is upgraded to the reconnect+resend node
    // bridge so MCP survives pause + app restart on recreation.
    expect(parsed.mcpServers['claude-fleet-state']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/fleet/mcp/bridge.cjs'],
      env: { CLAUDE_FLEET_MCP_UNIX: '/fleet/mcp/mcp.sock' }
    });
  });

  it('leaves an existing file byte-identical when the managed entry already matches', async () => {
    const path = workspaceClaudeJsonPath('01SAME');
    // File already carries the current reconnect+resend bridge → no rewrite.
    const current = {
      hasCompletedOnboarding: true,
      numStartups: 3,
      projects: {},
      mcpServers: {
        'claude-fleet-state': {
          type: 'stdio',
          command: 'node',
          args: ['/fleet/mcp/bridge.cjs'],
          env: { CLAUDE_FLEET_MCP_UNIX: '/fleet/mcp/mcp.sock' }
        }
      }
    };
    const serialized = JSON.stringify(current);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(userDataDir, 'state', '01SAME'), { recursive: true });
    await writeFile(path, serialized, 'utf8');
    const past = Date.now() / 1000 - 100;
    await utimes(path, past, past);

    await ensureWorkspaceClaudeJson('01SAME', '/workspace');
    expect(await readFile(path, 'utf8')).toBe(serialized);
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
