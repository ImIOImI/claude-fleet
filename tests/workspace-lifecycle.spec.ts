// Workspace lifecycle: pause/resume/close/stop/remove/restart, the
// hamburger-menu state-conditional items, and the past-workspaces
// list. All against either mock-mode (real renderer + mockDocker
// backend) or fully-mocked IPC.

import { test, expect } from '@playwright/test';
import {
  launch,
  mockMainIpc,
  getCalls,
  openCloseModalFor,
  activePane,
  readLogEntries,
  waitForLogEntry
} from './_helpers.js';

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
      .getByRole('button', { name: 'Add workspace' })
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

test('Pause gates the broker attach; Resume re-attaches (#18)', async () => {
  // Regression guard for "broker: ATTACHED timed out" on reopen-while-paused.
  // `docker pause` freezes the in-container broker (PID 1). A unix-socket
  // connect still succeeds (kernel parks it in the listen backlog), so the
  // host sends ATTACH but the frozen broker never replies ATTACHED — the RPC
  // hangs the full 30s and fails. The trigger was TerminalSession
  // auto-attaching one frame after mount regardless of paused state. The fix:
  // skip the network attach while paused, then re-attach when paused clears.
  //
  // Renderer-observable proof (mock backend, since the real frozen-broker
  // timeout needs Docker): across a pause→resume cycle, exactly ONE new
  // pty-attach fires for the workspace's container — the resume reattach.
  // If the gate regressed, a second attach would fire during the paused
  // window and the count would jump by two.
  const ALPHA = '01MOCKALPHA000000000000000';
  const { app, window, userDataDir } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Select mock-alpha so its pane is visible and the initial attach lands.
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    await waitForLogEntry(
      userDataDir,
      (e) => e.type === 'pty-attach' && (e.extra?.containerId as string) === ALPHA
    );
    const attachCount = (): number =>
      readLogEntries(userDataDir).filter(
        (e) => e.type === 'pty-attach' && (e.extra?.containerId as string) === ALPHA
      ).length;
    const baseline = attachCount();
    expect(baseline).toBeGreaterThanOrEqual(1);

    // Pause via the chip hamburger. The TerminalSession effect re-runs with
    // paused=true: it sets up xterm but must NOT attach.
    const group = window.locator('.ws-chip-group', { hasText: 'mock-alpha' });
    await group.locator('.ws-chip-menu-trigger').click();
    await window.locator('.ws-chip-menu').getByRole('menuitem', { name: 'Pause' }).click();
    await expect(window.locator('.paused-overlay')).toBeVisible();
    // No attach may fire while paused.
    expect(attachCount()).toBe(baseline);

    // Resume from the overlay → the effect re-runs with paused=false and
    // re-attaches.
    await window.locator('.paused-overlay').getByRole('button', { name: 'Resume' }).click();
    await expect(window.locator('.paused-overlay')).toBeHidden();
    // Exactly one new attach (the reattach) — generous timeout covers the
    // unpause refresh + the rAF-deferred attach. Asserting `=== baseline + 1`
    // (not just `> baseline`) proves no stray attach fired during the pause.
    await expect.poll(() => attachCount(), { timeout: 8_000 }).toBe(baseline + 1);
  } finally {
    await app.close();
  }
});

test('Strip/modal partition: paused → strip, stopped+deleted → modal Saved (#21)', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        { id: '01RUN0000000000000000000WS', name: 'api', containerId: 'c-api', state: 'running', workspaceRoot: '/tmp/a' },
        { id: '01PAU0000000000000000000WS', name: 'web', containerId: 'c-web', state: 'paused', workspaceRoot: '/tmp/b' },
        { id: '01STO0000000000000000000WS', name: 'db', containerId: 'c-db', state: 'stopped', workspaceRoot: '/tmp/c' },
        { id: '01DEL0000000000000000000WS', name: 'cron', state: 'deleted', workspaceRoot: '/tmp/d' }
      ]
    });

    // Top strip = warm fleet: running + paused only.
    const strip = window.locator('.top-strip');
    await expect(strip.locator('.ws-chip .name', { hasText: 'api' })).toBeVisible();
    await expect(strip.locator('.ws-chip .name', { hasText: 'web' })).toBeVisible();
    await expect(strip.locator('.ws-chip .name', { hasText: 'db' })).toHaveCount(0);
    await expect(strip.locator('.ws-chip .name', { hasText: 'cron' })).toHaveCount(0);

    // Modal Saved = cold fleet: stopped + deleted only (paused/running excluded).
    await strip.getByRole('button', { name: 'Add workspace' }).click();
    await expect(window.getByRole('tab', { name: 'Saved' })).toHaveAttribute('aria-selected', 'true');
    await expect(window.locator('.saved-row', { hasText: 'db' })).toBeVisible();
    await expect(window.locator('.saved-row', { hasText: 'cron' })).toBeVisible();
    await expect(window.locator('.saved-row', { hasText: 'web' })).toHaveCount(0);
    await expect(window.locator('.saved-row', { hasText: 'api' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

