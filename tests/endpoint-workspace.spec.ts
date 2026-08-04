// Endpoint workspaces (#250): a local workspace with authMode 'endpoint'
// spawns claude with the registry-compiled backend env. Uses an env-printing
// stub so the assertion reads the REAL spawned process's environment.
import { _electron as electron, test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

test('endpoint workspace: compiled backend env reaches the spawned claude (#250)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'fleet-endpoint-'));
  const id = '01ENDPOINTTESTWS000000000W';
  const epId = 'ep-e2e-1';

  writeFileSync(
    path.join(userDataDir, 'endpoints.json'),
    JSON.stringify([
      {
        id: epId,
        name: 'e2e-fake',
        baseUrl: 'http://127.0.0.1:59999',
        modelId: 'qwen3:4b',
        hasApiKey: false
      }
    ])
  );

  const stateDir = path.join(userDataDir, 'state', id);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id,
      name: 'endpoint-e2e',
      labels: [],
      workspaceRoot: tmpdir(),
      workspaceSubdir: '',
      kind: 'local',
      authMode: 'endpoint',
      endpointId: epId,
      env: { plain: { CF_SUMMARY_MODEL: 'user-override' }, secretKeys: [] },
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );

  const stubPath = path.resolve(import.meta.dirname, 'fixtures', 'claude-env-stub.js');
  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_FLEET_LOCAL_CLAUDE_BIN: process.execPath,
      CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS: stubPath
    } as Record<string, string>
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // The seeded workspace is 'stopped' at startup (started set is empty). It
    // shows in the modal's Saved tab. Open the modal and Resume it.
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await expect(window.getByRole('tab', { name: 'Saved' })).toHaveAttribute('aria-selected', 'true');
    const row = window.locator('.saved-row', { hasText: 'endpoint-e2e' });
    await expect(row).toBeVisible({ timeout: 8_000 });
    await row.locator('.saved-row-header').click();
    await row.getByRole('button', { name: 'Resume' }).click();

    // Modal closes; workspace chip appears in the top strip (now running).
    await expect(window.locator('.ws-chip .name', { hasText: 'endpoint-e2e' })).toBeVisible({
      timeout: 10_000
    });

    // Click the chip so the terminal pane mounts and TerminalSession attaches.
    await window.locator('.ws-chip', { hasText: 'endpoint-e2e' }).click();
    await expect(
      window.locator('.terminal-pane:not([aria-hidden="true"]) .terminal-host')
    ).toBeVisible({ timeout: 8_000 });

    // The env-printing stub prints the backend vars to stdout; node-pty delivers
    // them into xterm. Assert each expected value appears in the terminal rows.
    const termRows = window.locator('.terminal-pane:not([aria-hidden="true"]) .xterm-rows');
    await expect(termRows).toContainText('ANTHROPIC_BASE_URL=http://127.0.0.1:59999', { timeout: 20_000 });
    await expect(termRows).toContainText('ANTHROPIC_MODEL=qwen3:4b');
    await expect(termRows).toContainText('ANTHROPIC_AUTH_TOKEN=claude-fleet');   // placeholder, no key stored
    await expect(termRows).toContainText('CF_SUMMARY_MODEL=user-override');      // workspace env beats endpoint env
  } finally {
    await app.close();
  }
});
