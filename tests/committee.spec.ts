// Committee permission UI (#118) end-to-end, mock backend. Real ipc + manifest
// IO (writeManifest/list are backend-agnostic). Exercises the full round-trip:
// an expert opts in via the edit modal → its chip shows the wifi glyph → a
// manager grants it a verb in the left-rail Committee matrix → the manager's
// chip shows the manager glyph.

import { test, expect, type Page } from '@playwright/test';
import { launch } from './_helpers.js';

async function createWorkspace(window: Page, name: string): Promise<void> {
  await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
  await window.getByLabel('Workspace name').fill(name);
  await window.getByRole('button', { name: 'Create & start' }).click();
  await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();
}

async function openChipMenu(window: Page, name: string) {
  const group = window.locator('.ws-chip-group', { hasText: name });
  await group.locator('.ws-chip-menu-trigger').click();
  return window.locator('.ws-chip-menu');
}

test('Committee: expert opt-in → wifi chip; manager grant → manager chip (#118)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await createWorkspace(window, 'expert-sec');
    await createWorkspace(window, 'mgr-one');

    // 1) expert-sec opts in via its edit modal's Committee access section.
    const menu = await openChipMenu(window, 'expert-sec');
    await menu.getByRole('menuitem', { name: 'Edit…' }).click();
    await expect(window.locator('.modal-tab', { hasText: 'Edit expert-sec' })).toBeVisible();
    await window.getByText('Committee access').click(); // expand the disclosure
    await window.getByLabel('Reachable by managers').check();
    await window.getByLabel('Role hint').fill('security');
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(window.locator('.modal-tab', { hasText: 'Edit expert-sec' })).toBeHidden();

    // The expert chip now carries the wifi (reachable) glyph.
    const expertChip = window.locator('.ws-chip-group', { hasText: 'expert-sec' });
    await expect(expertChip.locator('.committee-glyph.wifi')).toBeVisible({ timeout: 5_000 });

    // 2) Select mgr-one and grant it `post` over expert-sec in the matrix.
    await window.locator('.ws-chip', { hasText: 'mgr-one' }).click();
    // The Committee accordion section is present and open by default.
    await expect(window.getByRole('button', { name: /Committee/ })).toBeVisible();
    const postBox = window.getByLabel('post expert-sec');
    await expect(postBox).toBeVisible({ timeout: 5_000 });
    await postBox.check();

    // 3) Granting makes mgr-one a manager → its chip shows the manager glyph.
    const mgrChip = window.locator('.ws-chip-group', { hasText: 'mgr-one' });
    await expect(mgrChip.locator('.committee-glyph.mgr')).toBeVisible({ timeout: 5_000 });

    // The grant persisted: re-reading shows `post` still checked.
    await expect(window.getByLabel('post expert-sec')).toBeChecked();
  } finally {
    await app.close();
  }
});
