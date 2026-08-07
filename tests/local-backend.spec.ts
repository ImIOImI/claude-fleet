// Local backend (#16) / ConPTY verification (#106) / launcher UI Linux-side assertions (#253).
//
// Exercises the REAL local backend (no CLAUDE_FLEET_MOCK) with a stub claude
// binary (tests/fixtures/claude-stub.js) so a full PTY spawn round-trip runs
// without a real claude binary or API key. On win32, node-pty automatically
// uses ConPTY; this test proves it works end-to-end.
//
// The stub is wired via:
//   CLAUDE_FLEET_LOCAL_CLAUDE_BIN=<absolute node path>  (resolveClaude override)
//   CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS=<path-to-stub> (NUL-separated)
// local.ts reads these and passes extraArgs to attachLocalSession so the spawn
// becomes: node <stub-path> [--mcp-config ...] [--session-id ...]

import { _electron as electron, test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, launch, mockMainIpc, waitForLogEntry } from './_helpers.js';

test('Local backend: PTY spawns and reports session mapping (ConPTY on win32) (#106)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'fleet-local-'));
  const id = '01LOCALTESTWS00000000000WS';
  const stateDir = path.join(userDataDir, 'state', id);
  mkdirSync(stateDir, { recursive: true });

  // Seed a stopped local workspace manifest so the app finds it in the Saved tab.
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id,
      name: 'local-pty-test',
      labels: [],
      workspaceRoot: tmpdir(),
      workspaceSubdir: '',
      kind: 'local',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );

  // claude-stub.js path; passed NUL-separated so it survives spaces in the path.
  const stubPath = path.resolve(import.meta.dirname, 'fixtures', 'claude-stub.js');

  // Use the full absolute path to the node binary running these tests.
  // On Windows, ConPTY's path_util::get_shell_path only does exact-filename
  // matching (no PATHEXT extension resolution), so bare 'node' isn't found —
  // process.execPath gives C:\…\node.exe which is an absolute path that bypasses
  // the PATH search entirely. On POSIX the full path also works fine.
  const nodeBin = process.execPath;

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_FLEET_LOCAL_CLAUDE_BIN: nodeBin,
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
    const row = window.locator('.saved-row', { hasText: 'local-pty-test' });
    await expect(row).toBeVisible({ timeout: 8_000 });
    await row.locator('.saved-row-header').click();
    await row.getByRole('button', { name: 'Resume' }).click();

    // Modal closes; workspace chip appears in the top strip (now running).
    await expect(window.locator('.ws-chip .name', { hasText: 'local-pty-test' })).toBeVisible({
      timeout: 10_000
    });

    // Click the chip so the terminal pane mounts and TerminalSession attaches.
    await window.locator('.ws-chip', { hasText: 'local-pty-test' }).click();
    await expect(
      window.locator('.terminal-pane:not([aria-hidden="true"]) .terminal-host')
    ).toBeVisible({ timeout: 8_000 });

    // attachPty → attachLocalSession → node-pty spawns the stub. On win32 this
    // goes through ConPTY. The onFreshSpawn callback writes a 'mapping-learned'
    // log entry to confirm the PTY actually ran. 15 s deadline covers slow
    // Windows startup + ConPTY initialisation.
    await waitForLogEntry(
      userDataDir,
      (e) => e.type === 'mapping-learned' && e.workspaceId === id,
      15_000
    );
  } finally {
    await app.close();
  }
});

// Linux-side launcher UI assertions (#253).
//
// On Linux (non-win32), the "Run claude in" section must be present when
// kind=Local, but the WSL radio must NOT appear (win32-only). The Custom
// command radio and its input field must be reachable. Runs with the mock
// IPC layer so no Docker daemon or real claude binary is needed.
test('Launcher UI (Linux): WSL radio absent, custom-command radio present (#253)', async () => {
  const { app, window } = await launch();
  await mockMainIpc(app);

  try {
    // Open the New workspace modal.
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

    // Make sure we're on the New tab.
    const newTab = window.getByRole('tab', { name: 'New' });
    if (await newTab.isVisible()) {
      await newTab.click();
    }

    // Switch to Local kind to reveal the launcher section.
    await window.getByRole('radio', { name: /Local/ }).check();

    // The "Run claude in" section row must be visible.
    await expect(window.getByLabel('Run claude in')).toBeVisible();

    // WSL radio is Windows-only — must be absent on Linux.
    // Use /WSL/ regex because the accessible name includes the kind-help span text.
    await expect(window.getByRole('radio', { name: /WSL/ })).toHaveCount(0);

    // Custom command radio must be present and checkable.
    const customRadio = window.getByRole('radio', { name: /Custom command/ });
    await expect(customRadio).toBeVisible();
    await customRadio.check();

    // The custom launch command input must appear after selecting custom.
    await expect(window.getByLabel('Custom launch command')).toBeVisible();
  } finally {
    await app.close();
  }
});
