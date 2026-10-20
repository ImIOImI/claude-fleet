// Desktop presence (#407 Phase 2b), mock backend: the keep-running-in-tray
// setting persists, and the tray's "Open Inbox" (presence:openInbox) opens the
// inbox. Tray/overlay pixels are OS-drawn and covered by presenceCore units.
import { test, expect } from '@playwright/test';
import { launch, callTestIpc } from './_helpers.js';

test('Presence: keep-running toggle persists; tray Open Inbox opens the inbox (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    expect(await callTestIpc<boolean>(app, 'presence:getKeepRunning', [])).toBe(false);
    await window.getByRole('button', { name: 'Settings' }).click();
    await window.locator('.modal-tab', { hasText: 'Notifications' }).click();
    const toggle = window.getByLabel('Keep running in the background');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect.poll(() => callTestIpc<boolean>(app, 'presence:getKeepRunning', [])).toBe(true);
    await toggle.uncheck();
    await expect.poll(() => callTestIpc<boolean>(app, 'presence:getKeepRunning', [])).toBe(false);
    await window.locator('.modal-footer.notif-footer').getByRole('button', { name: 'Close' }).click();

    await expect(window.locator('.inbox-view')).toBeHidden();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('presence:openInbox'));
    await expect(window.locator('.inbox-view')).toBeVisible();
    await expect(window.locator('.inbox-chip')).toHaveClass(/active/);
  } finally {
    await app.close();
  }
});
