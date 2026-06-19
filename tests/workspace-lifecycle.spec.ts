// Workspace lifecycle: pause/resume/close/stop/remove/restart, the
// hamburger-menu state-conditional items, and the past-workspaces
// list. All against either mock-mode (real renderer + mockDocker
// backend) or fully-mocked IPC.

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc, getCalls, openCloseModalFor, activePane } from './_helpers.js';

test('Hamburger Close…: stops and removes a running workspace', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await openCloseModalFor(window, 'mock-alpha');
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();

    // Running workspace should expose both "Stop only" and "Stop & remove"
    await expect(window.getByRole('button', { name: 'Stop only' })).toBeVisible();
    await window.getByRole('button', { name: 'Stop & remove' }).click();

    // Modal closes, workspace disappears from strip
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeHidden();
    await expect(window.locator('.ws-chip .name', { hasText: 'mock-alpha' })).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Hamburger Close… on an exited workspace shows only Remove', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await openCloseModalFor(window, 'mock-beta');
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Stop only' })).toBeHidden();
    await expect(window.getByRole('button', { name: 'Remove' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Pause: chip shows paused glyph and terminal pane shows paused overlay', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Select the running mock-alpha workspace so its terminal pane mounts.
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    await expect(activePane(window).locator('.terminal-host')).toBeVisible();

    // Pause via the chip's hamburger menu.
    const group = window.locator('.ws-chip-group', { hasText: 'mock-alpha' });
    await group.locator('.ws-chip-menu-trigger').click();
    await window.locator('.ws-chip-menu').getByRole('menuitem', { name: 'Pause' }).click();

    // The renderer polls workspace:list every 5s but onRefresh fires
    // immediately after the menu action — paused state should land fast.
    await expect(
      window.locator('.ws-chip-group', { hasText: 'mock-alpha' }).locator('.chip-paused-glyph')
    ).toBeVisible();
    await expect(window.locator('.paused-overlay')).toBeVisible();
    await expect(window.getByText('workspace paused')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Pause + Resume: clicking Resume in the overlay un-pauses and clears it', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const group = window.locator('.ws-chip-group', { hasText: 'mock-alpha' });
    await group.locator('.ws-chip-menu-trigger').click();
    await window.locator('.ws-chip-menu').getByRole('menuitem', { name: 'Pause' }).click();

    await expect(window.locator('.paused-overlay')).toBeVisible();

    // Resume button inside the overlay.
    await window.locator('.paused-overlay').getByRole('button', { name: 'Resume' }).click();

    // After unpause the overlay disappears and the chip's pause glyph
    // does too. Underlying terminal regains pointer events.
    await expect(window.locator('.paused-overlay')).toBeHidden();
    await expect(
      window.locator('.ws-chip-group', { hasText: 'mock-alpha' }).locator('.chip-paused-glyph')
    ).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Saved tab: deleted workspace appears and Resume fires workspace:start', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'ghost-fox',
          state: 'deleted',
          workspaceRoot: '/tmp/ghost-fox',
          image: 'ghcr.io/imioimi/claude-fleet/runner:latest'
        }
      ]
    });

    await window
      .locator('.top-strip')
      .getByRole('button', { name: '+ New workspace' })
      .click();

    // The "deleted" workspace isn't in the top strip but appears in the
    // modal's Saved tab (which is the default when saved workspaces exist).
    await expect(window.getByRole('tab', { name: 'Saved' })).toHaveAttribute('aria-selected', 'true');
    const row = window.locator('.saved-row', { hasText: 'ghost-fox' });
    await expect(row).toBeVisible();
    await expect(row.locator('.ws-state.deleted')).toBeVisible();

    // Expand the row → the inline edit form unfolds with Resume as the
    // primary action.
    await row.locator('.saved-row-header').click();
    const resume = row.getByRole('button', { name: 'Resume' });
    await expect(resume).toBeVisible();
    await resume.click();

    // Modal closes; writeManifest + start both fire (helper defaults workspace id = name).
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();
    const calls = await getCalls(app);
    expect(calls.writeManifest).toHaveLength(1);
    expect(calls.start).toContain('ghost-fox');
  } finally {
    await app.close();
  }
});

test('Hamburger menu: running workspace shows Pause/Stop, paused shows Resume', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    const chipGroup = window.locator('.ws-chip-group', { hasText: 'mock-alpha' });
    const trigger = chipGroup.locator('.ws-chip-menu-trigger');
    await trigger.click();

    // The menu is portaled to document.body; query it at page level.
    const menu = window.locator('.ws-chip-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Pause' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Stop' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Close…' })).toBeVisible();
    // Stopped/Start should NOT appear for a running workspace.
    await expect(menu.getByRole('menuitem', { name: 'Resume' })).toBeHidden();
    await expect(menu.getByRole('menuitem', { name: 'Start' })).toBeHidden();

    await menu.getByRole('menuitem', { name: 'Pause' }).click();
    await expect(menu).toBeHidden();
    await expect(chipGroup.locator('.dot.paused')).toBeVisible();

    // Re-open the menu — now we should see Resume instead.
    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Resume' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Pause' })).toBeHidden();
    await expect(menu.getByRole('menuitem', { name: 'Stop' })).toBeHidden();

    await menu.getByRole('menuitem', { name: 'Resume' }).click();
    await expect(chipGroup.locator('.dot.running')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Hamburger menu: stopped workspace shows Start (not Pause/Stop)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // mock-beta is seeded as state='stopped'
    const chipGroup = window.locator('.ws-chip-group', { hasText: 'mock-beta' });
    await chipGroup.locator('.ws-chip-menu-trigger').click();

    const menu = window.locator('.ws-chip-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Start' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Close…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Pause' })).toBeHidden();
    await expect(menu.getByRole('menuitem', { name: 'Stop' })).toBeHidden();
    await expect(menu.getByRole('menuitem', { name: 'Resume' })).toBeHidden();

    await menu.getByRole('menuitem', { name: 'Start' }).click();
    await expect(chipGroup.locator('.dot.running')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Hamburger menu: Close… opens the CloseWorkspaceModal even when chip is not selected', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Don't click mock-beta first — go straight to its hamburger menu.
    const chipGroup = window.locator('.ws-chip-group', { hasText: 'mock-beta' });
    await chipGroup.locator('.ws-chip-menu-trigger').click();
    await window
      .locator('.ws-chip-menu')
      .getByRole('menuitem', { name: 'Close…' })
      .click();

    // The Close modal opens for mock-beta (the chip the user clicked the
    // menu on), not for whatever was previously selected (nothing here).
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();
    await expect(window.locator('.modal-eyebrow', { hasText: 'mock-beta' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Pause then Resume via the Close modal (opened from hamburger)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    const chip = window.locator('.ws-chip', { hasText: 'mock-alpha' });

    // Running workspace → Close modal exposes Pause.
    await openCloseModalFor(window, 'mock-alpha');
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();
    await window.getByRole('button', { name: 'Pause' }).click();

    // Modal closes; the workspace chip now shows the paused dot.
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeHidden();
    await expect(chip.locator('.dot.paused')).toBeVisible();
    await expect(chip.locator('.dot.running')).toBeHidden();

    // Reopen Close modal via the hamburger. Paused workspace → Resume button.
    await openCloseModalFor(window, 'mock-alpha');
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Pause' })).toBeHidden();
    const resume = window.getByRole('button', { name: 'Resume' });
    await expect(resume).toBeVisible();
    await resume.click();

    // Modal closes; the workspace chip is back to running.
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeHidden();
    await expect(chip.locator('.dot.running')).toBeVisible();
    await expect(chip.locator('.dot.paused')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Saved tab: paused workspace renders the paused state', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'frozen-fox',
          containerId: 'frozen-fox-id',
          state: 'paused',
          status: 'Paused',
          workspaceRoot: '/tmp/frozen-fox'
        }
      ]
    });

    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await expect(window.getByRole('tab', { name: 'Saved' })).toHaveAttribute('aria-selected', 'true');

    const row = window.locator('.saved-row', { hasText: 'frozen-fox' });
    await expect(row).toBeVisible();
    await expect(row.locator('.ws-state.paused')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('#17: clicking a stopped workspace shows a Start overlay that resumes it', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          id: '01STOPPEDWS00000000000000WS',
          name: 'frosty-fox',
          containerId: 'frosty-id',
          state: 'stopped',
          workspaceRoot: '/tmp/frosty'
        }
      ]
    });

    await window.locator('.ws-chip', { hasText: 'frosty-fox' }).click();

    // The pane shows the stopped overlay (not a silently-failing terminal),
    // with a Start button rather than the paused "Resume".
    await expect(window.getByText('workspace stopped')).toBeVisible({ timeout: 5_000 });
    const startBtn = window.getByRole('button', { name: 'Start' });
    await expect(startBtn).toBeVisible();

    await startBtn.click();
    await expect
      .poll(async () => (await getCalls(app)).start, { timeout: 5_000 })
      .toContainEqual('01STOPPEDWS00000000000000WS');
  } finally {
    await app.close();
  }
});
