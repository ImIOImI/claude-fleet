// e2e test for the "waiting on AskUserQuestion" chip state.
//
// The renderer receives `inputwait:update` pushes from main (broadcast via
// BrowserWindow.webContents.send). We simulate main's broadcast directly
// from `app.evaluate` — no Docker/MCP/PTY needed.
//
// What we test here (chip path):
//   - Chip dot becomes `.dot.waiting` after push with waitingSessionIds=[...]
//   - `.ws-chip-sub` text switches to "needs input"
//   - Both revert after a second push with waitingSessionIds=[]
//
// What is NOT tested here (unit-covered by chipState.test.ts + waitingSessions.test.ts):
//   - Sessions-list row waiting state (row depends on session IDs that the mock
//     harness doesn't populate without real broker sessions — reliable chip path
//     beats flaky row path in e2e)
//   - Session-tab dot (same reason)

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc } from './_helpers.js';

test('inputwait: chip shows waiting dot + "needs input" then clears', async () => {
  // Use mock mode so the app starts without Docker/PTY overhead.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // The workspace id defaults to `name` in mockMainIpc when no id is
    // specified (see _helpers.ts: `id: w.id ?? w.name`). We use an explicit
    // id here so the push target is unambiguous.
    const wsId = 'ws-wait-test-id';
    await mockMainIpc(app, {
      workspaceList: [
        {
          id: wsId,
          name: 'ws-wait',
          state: 'running',
          workspaceRoot: '/tmp/ws-wait',
        }
      ]
    });

    // Wait for the chip to appear after IPC is wired.
    const chip = window.locator('.ws-chip', { hasText: 'ws-wait' });
    await expect(chip).toBeVisible({ timeout: 8_000 });

    // Before any push: no waiting dot.
    await expect(chip.locator('.dot.waiting')).toHaveCount(0);

    // Simulate main broadcasting inputwait:update to the renderer window.
    // `app.evaluate` runs in the main process, where BrowserWindow is available.
    await app.evaluate(
      ({ BrowserWindow }, [workspaceId, sessionIds]) => {
        const wins = BrowserWindow.getAllWindows();
        if (wins.length === 0) throw new Error('No renderer windows found');
        wins[0].webContents.send('inputwait:update', {
          workspaceId,
          waitingSessionIds: sessionIds
        });
      },
      [wsId, ['claude-uuid-1']] as const
    );

    // After push: waiting dot appears and sub-line shows "needs input".
    await expect(chip.locator('.dot.waiting')).toBeVisible({ timeout: 5_000 });
    await expect(chip.locator('.ws-chip-sub')).toHaveText('needs input', { timeout: 5_000 });

    // Send a clear push: waitingSessionIds=[].
    await app.evaluate(
      ({ BrowserWindow }, [workspaceId]) => {
        const wins = BrowserWindow.getAllWindows();
        if (wins.length === 0) throw new Error('No renderer windows found');
        wins[0].webContents.send('inputwait:update', {
          workspaceId,
          waitingSessionIds: []
        });
      },
      [wsId] as const
    );

    // Dot must be gone after clearing.
    await expect(chip.locator('.dot.waiting')).toHaveCount(0, { timeout: 5_000 });
    // Sub-line no longer shows "needs input" (reverts to activity text or blank).
    await expect(chip.locator('.ws-chip-sub')).not.toHaveText('needs input', { timeout: 5_000 });
  } finally {
    await app.close();
  }
});
