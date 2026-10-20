// Inbox (#407) end-to-end, mock backend: chip → view → add → triage → close,
// plus workspace-chip deselection and tag filtering. Real inbox.db in the temp userData.
import { test, expect, type Page } from '@playwright/test';
import { launch, callTestIpc } from './_helpers.js';

const chip = (w: Page) => w.locator('.inbox-chip');

test('Inbox: add, tag, prioritise, mark done (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await expect(chip(window)).toContainText('Automations');
    await expect(chip(window).locator('.ws-chip-sub')).toHaveText('nothing open');
    await chip(window).locator('.ws-chip').click();
    const view = window.locator('.inbox-view');
    await expect(view).toBeVisible();
    await expect(view.locator('.ib-empty')).toContainText('Nothing open');

    await view.getByLabel('New todo title').fill('Rotate the WebEx token');
    await view.getByLabel('New todo priority').selectOption('urgent');
    await view.getByRole('button', { name: 'Add todo' }).click();
    const row = view.locator('.todo-row', { hasText: 'Rotate the WebEx token' });
    await expect(row).toBeVisible();
    await expect(view.locator('.todo-group.g-urgent')).toContainText('Urgent · 1');
    await expect(chip(window).locator('.ws-chip-sub')).toHaveText('1 open · 1 urgent');

    await row.click();
    const detail = view.locator('.ib-detail');
    await expect(detail.locator('.ib-detail-title')).toHaveText('Rotate the WebEx token');
    await detail.getByLabel('Add tag').fill('WebEx');
    await detail.getByLabel('Add tag').press('Enter');
    await expect(row.locator('.tag', { hasText: 'webex' })).toBeVisible();
    await detail.getByLabel('Priority').selectOption('high');
    await expect(view.locator('.todo-group.g-high')).toContainText('High · 1');
    await expect(chip(window).locator('.ws-chip-sub')).toHaveText('1 open');

    await detail.getByRole('button', { name: 'Mark done' }).click();
    await expect(row).toBeHidden();
    await expect(chip(window).locator('.ws-chip-sub')).toHaveText('nothing open');
    await view.getByRole('tab', { name: 'Done' }).click();
    await view.locator('.todo-row', { hasText: 'Rotate the WebEx token' }).click();
    await expect(view.locator('.ib-hist li')).toHaveCount(4); // created, tag, priority, done
    await expect(view.locator('.ib-hist li').first()).toContainText('You marked it done');

    const all = await callTestIpc<Array<{ title: string; status: string }>>(app, 'inbox:list', [{ status: 'all' }]);
    expect(all).toEqual([expect.objectContaining({ title: 'Rotate the WebEx token', status: 'done' })]);
  } finally {
    await app.close();
  }
});

test('Inbox: search and tag filter; workspace chip deselects while open (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await callTestIpc(app, 'inbox:create', [{ title: 'Disk 91% on build-01', priority: 'high', tags: ['ops'] }]);
    await callTestIpc(app, 'inbox:create', [{ title: 'Drink water', priority: 'low', tags: ['health'] }]);
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('deselect-check');
    await window.getByRole('button', { name: 'Create & start' }).click();
    const ws = window.locator('.ws-chip-group', { hasText: 'deselect-check' });
    await expect(ws).toHaveClass(/active/);

    await chip(window).locator('.ws-chip').click();
    await expect(chip(window)).toHaveClass(/active/);
    await expect(ws).not.toHaveClass(/active/);
    const view = window.locator('.inbox-view');
    await expect(view.locator('.todo-row')).toHaveCount(2);
    await view.getByLabel('Search todos').fill('build-01');
    await expect(view.locator('.todo-row')).toHaveCount(1);
    await view.getByLabel('Search todos').fill('');
    await view.locator('.todo-row', { hasText: 'Drink water' }).locator('.tag', { hasText: 'health' }).click();
    await expect(view.locator('.todo-row')).toHaveCount(1);
    await view.locator('.pill', { hasText: '#health' }).click();
    await expect(view.locator('.todo-row')).toHaveCount(2);

    await ws.locator('.ws-chip').click();
    await expect(view).toBeHidden();
    await expect(ws).toHaveClass(/active/);
  } finally {
    await app.close();
  }
});
