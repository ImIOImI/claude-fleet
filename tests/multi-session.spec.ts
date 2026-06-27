// The session tab strip inside TerminalPane: auto-created "main" tab,
// the + New session button, closing tabs, the session-ended overlay,
// and the sessions.json persistence roundtrip.

import { test, expect } from '@playwright/test';
import { launch, activePane } from './_helpers.js';

test('Sessions persistence: write then read returns the same inventory', async () => {
  // Exercises the sessions.json layer end-to-end through IPC. The
  // renderer-facing read/write API is what TerminalPane uses on mount
  // and on every tab-list change.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    const inv = {
      version: 1,
      sessions: [
        { id: 'aaa', name: 'main', createdAt: 1000 },
        { id: 'bbb', name: 'session 2', createdAt: 2000 }
      ],
      nextNum: 3,
      activeId: 'bbb'
    };
    await window.evaluate(async (inventory) => {
      await window.api.sessions.write('persistence-roundtrip-test', inventory);
    }, inv);

    const got = await window.evaluate(async () => {
      return window.api.sessions.read('persistence-roundtrip-test');
    });

    expect(got).toEqual(inv);
  } finally {
    await app.close();
  }
});

test('Multi-session: workspace starts with a "main" tab; + adds new tabs; close switches', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();

    const strip = activePane(window).locator('.session-tab-strip');
    await expect(strip).toBeVisible();

    // First session is auto-created and called "main".
    const tabs = strip.locator('.session-tab');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.nth(0)).toContainText('main');
    await expect(tabs.nth(0)).toHaveClass(/active/);

    // + adds a new session, becomes active, named "session 2".
    await strip.getByRole('button', { name: 'New session' }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toContainText('session 2');
    await expect(tabs.nth(1)).toHaveClass(/active/);
    await expect(tabs.nth(0)).not.toHaveClass(/active/);

    // Clicking the main tab switches focus back to it.
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveClass(/active/);
    await expect(tabs.nth(1)).not.toHaveClass(/active/);

    // Add a third — counter doesn't decrement, so it's "session 3".
    await strip.getByRole('button', { name: 'New session' }).click();
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(2)).toContainText('session 3');

    // Close the active "session 3" — focus moves to the tab on its left
    // (session 2), not all the way back to main.
    await tabs.nth(2).getByRole('button', { name: 'Actions for session 3' }).click();
    await window.getByRole('menuitem', { name: 'Close' }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toContainText('session 2');
    await expect(tabs.nth(1)).toHaveClass(/active/);
    await expect(tabs.nth(0)).not.toHaveClass(/active/);
  } finally {
    await app.close();
  }
});

test('Multi-session: closing the only tab respawns a fresh "main"', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();

    const strip = activePane(window).locator('.session-tab-strip');
    const tabs = strip.locator('.session-tab');
    await expect(tabs).toHaveCount(1);

    await tabs.nth(0).getByRole('button', { name: 'Actions for main' }).click();
    await window.getByRole('menuitem', { name: 'Close' }).click();

    // Strip is never empty: a fresh "main" appears in place.
    await expect(tabs).toHaveCount(1);
    await expect(tabs.nth(0)).toContainText('main');
    await expect(tabs.nth(0)).toHaveClass(/active/);
  } finally {
    await app.close();
  }
});

test('Session tab menu: rename via inline edit; auto-rename toggle marks the tab', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const strip = activePane(window).locator('.session-tab-strip');
    const tab = strip.locator('.session-tab').nth(0);
    await expect(tab).toContainText('main');

    // Rename: ⋮ → Rename → inline input → type → Enter.
    await tab.getByRole('button', { name: 'Actions for main' }).click();
    await window.getByRole('menuitem', { name: 'Rename' }).click();
    const input = tab.locator('.session-tab-rename');
    await expect(input).toBeVisible();
    await input.fill('backend work');
    await input.press('Enter');
    await expect(tab).toContainText('backend work');

    // Auto-rename: ⋮ → Auto rename → the tab gains the ✦ marker, and the
    // menu item reads back as checked.
    await tab.getByRole('button', { name: 'Actions for backend work' }).click();
    await window.getByRole('menuitemcheckbox', { name: 'Auto rename' }).click();
    await expect(tab.locator('.session-tab-auto')).toBeVisible();
    await tab.getByRole('button', { name: 'Actions for backend work' }).click();
    await expect(window.getByRole('menuitemcheckbox', { name: 'Auto rename' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  } finally {
    await app.close();
  }
});

test('Session ended overlay: "Start new session" reattaches a fresh claude', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const term = activePane(window).locator('.terminal-host');
    await expect(term).toBeVisible();

    // Type `exit` in the mock shell — closes the duplex, triggers
    // the "session ended" overlay in TerminalPane.
    await term.click();
    await window.keyboard.type('exit');
    await window.keyboard.press('Enter');

    const overlay = activePane(window).locator('.session-ended-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole('button', { name: 'Start new session' })).toBeVisible();

    // Click → overlay disappears (new attach succeeds in mock mode).
    await overlay.getByRole('button', { name: 'Start new session' }).click();
    await expect(overlay).toBeHidden();
    await expect(term).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Session tab menu: Refresh shows the toast and keeps the session live', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const pane = activePane(window);
    const tab = pane.locator('.session-tab-strip .session-tab').nth(0);
    await expect(tab).toContainText('main');
    const term = pane.locator('.terminal-host');
    await expect(term).toBeVisible();

    // ⋮ → Refresh
    await tab.getByRole('button', { name: 'Actions for main' }).click();
    const refresh = window.getByRole('menuitem', { name: 'Refresh' });
    await expect(refresh).toBeVisible();
    await refresh.click();

    // Idle session → toast without the "when idle" suffix.
    await expect(window.locator('.toast', { hasText: 'Refreshing main' })).toBeVisible();

    // Session stays usable — no stuck "ended" overlay or ended dot.
    await expect(term).toBeVisible();
    await expect(pane.locator('.session-ended-overlay')).toHaveCount(0);
    await expect(tab.locator('.session-tab-dot.ended')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Session tab menu: Refresh is disabled for an ended session', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const pane = activePane(window);
    const tab = pane.locator('.session-tab-strip .session-tab').nth(0);
    const term = pane.locator('.terminal-host');
    await expect(term).toBeVisible();

    // End the session via the mock shell.
    await term.click();
    await window.keyboard.type('exit');
    await window.keyboard.press('Enter');
    await expect(pane.locator('.session-ended-overlay')).toBeVisible();

    // Refresh is present but disabled — nothing to resume in place.
    await tab.getByRole('button', { name: 'Actions for main' }).click();
    await expect(window.getByRole('menuitem', { name: 'Refresh' })).toBeDisabled();
  } finally {
    await app.close();
  }
});
