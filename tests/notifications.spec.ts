// Notifications UI (#407 Phase 2), mock backend: the 🔔 rule popover, the
// inbox header pause menu + banner, downtime editing and the rules table in
// Settings › Notifications, and "Send a test" landing in the Activity log.
import { test, expect, type Page } from '@playwright/test';
import { launch, callTestIpc } from './_helpers.js';

async function openInbox(window: Page) {
  await window.locator('.inbox-chip .ws-chip').click();
  await expect(window.locator('.inbox-view')).toBeVisible();
  return window.locator('.inbox-view');
}

test('Notifications: 🔔 rule mutes a source and shows in Settings (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await callTestIpc(app, 'inbox:create', [{ title: 'Drink water', priority: 'low' }]);
    const view = await openInbox(window);
    const row = view.locator('.todo-row', { hasText: 'Drink water' });
    await row.getByRole('button', { name: 'Notifications for "Drink water"' }).click();
    const pop = row.locator('.bell-pop');
    await expect(pop).toBeVisible();
    await expect(pop.getByRole('tab', { name: 'You' })).toBeVisible();
    await expect(pop).toContainText('Now: All, from your default');
    await pop.locator('.bp-level', { hasText: 'Off' }).click();
    await expect(pop).toContainText('Now: Off, from rule for You');
    await window.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await expect(row.locator('.todo-muted')).toHaveText('off for this source');

    await window.getByRole('button', { name: 'Settings' }).click();
    await window.locator('.modal-tab', { hasText: 'Notifications' }).click();
    const rules = window.locator('table.rules');
    await expect(rules.locator('tbody tr')).toHaveCount(1);
    await expect(rules).toContainText('You');
    await expect(rules).toContainText('Off');
    await rules.getByRole('button', { name: 'Remove' }).click();
    await expect(window.locator('.notif-settings')).toContainText('No rules yet.');
  } finally {
    await app.close();
  }
});

test('Notifications: pause from the header menu, banner, resume (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    const view = await openInbox(window);
    const ctl = view.getByRole('button', { name: /^Notifications: Notifying/ });
    await ctl.click();
    const menu = view.locator('.pause-menu');
    await expect(menu).toContainText('Pause notifications');
    await menu.getByRole('menuitem', { name: 'For 1 hour' }).click();
    const banner = view.locator('.pause-banner');
    await expect(banner).toContainText(/Notifications paused until \d\d:\d\d\./);
    await expect(view.getByRole('button', { name: /^Notifications: Paused/ })).toBeVisible();
    const q = await callTestIpc<{ pause: { until: number; letUrgent: boolean } | null }>(app, 'notifications:quietState', []);
    expect(q.pause?.letUrgent).toBe(true);
    expect((q.pause?.until ?? 0) - Date.now()).toBeGreaterThan(50 * 60_000);

    await banner.getByRole('button', { name: 'Resume now' }).click();
    await expect(banner).toBeHidden();
    await expect(view.getByRole('button', { name: /^Notifications: Notifying/ })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Notifications: add and remove a downtime; Send a test lands in Activity (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.getByRole('button', { name: 'Settings' }).click();
    await window.locator('.modal-tab', { hasText: 'Notifications' }).click();
    const s = window.locator('.notif-settings');
    await s.getByRole('button', { name: '+ Add downtime' }).click();
    await s.getByLabel('Downtime name').fill('Lunch');
    await s.getByLabel('Starts at').fill('12:00');
    await s.getByLabel('Ends at').fill('13:00');
    await s.getByLabel('During it').selectOption('urgent');
    await s.getByRole('button', { name: 'Save downtime' }).click();
    const item = s.locator('.dt-list li', { hasText: 'Lunch' });
    await expect(item).toContainText('Mon–Fri · 12:00–13:00');
    await expect(item).toContainText('urgent gets through');
    await expect(s.locator('.week .wblk')).toHaveCount(5);

    await s.getByRole('button', { name: '+ Add downtime' }).click();
    await s.getByLabel('Starts at').fill('nope');
    await s.getByRole('button', { name: 'Save downtime' }).click();
    await expect(s).toContainText('Times must look like 22:00.');
    await s.getByRole('button', { name: 'Cancel' }).click();

    await item.getByRole('button', { name: 'Remove' }).click();
    await expect(s.locator('.dt-list li')).toHaveCount(0);

    await s.getByRole('button', { name: 'Send a test' }).click();
    await expect(s.getByRole('button', { name: 'Sent' })).toBeVisible();
    await window.locator('.modal-footer.notif-footer').getByRole('button', { name: 'Close' }).click();
    const view = await openInbox(window);
    await view.getByRole('tab', { name: 'Activity' }).click();
    const log = view.locator('.notif-log');
    await expect(log.locator('.nl-row', { hasText: 'Test notification' })).toContainText('delivered');
  } finally {
    await app.close();
  }
});
