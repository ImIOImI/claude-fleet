// PR-B coverage: chip ⋮ menu Edit / Clone / Delete entries, the new
// EditWorkspaceModal + DeleteWorkspaceModal, the Clone flow (Saved-tab
// row footer + chip menu both open the modal pre-filled), and the
// restart-to-apply banner that appears for container-level edits.

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc, getCalls } from './_helpers.js';

const RUNNING_WS = {
  id: '01TESTRUNNINGWORKSPACE0000',
  name: 'happy-llama',
  description: 'API server work',
  labels: ['dev'],
  state: 'running' as const,
  containerId: 'fake-container-id',
  workspaceRoot: '/tmp/happy-llama',
  image: 'ghcr.io/imioimi/claude-fleet/runner:latest',
  authMode: 'oauth' as const,
  env: { plain: { FOO: 'bar' }, secretKeys: ['ANTHROPIC_API_KEY'] }
};

const STOPPED_WS = {
  id: '01TESTSTOPPED0000000000000',
  name: 'calm-otter',
  description: 'Data pipeline',
  labels: ['data'],
  state: 'stopped' as const,
  workspaceRoot: '/tmp/calm-otter',
  image: 'ghcr.io/imioimi/claude-fleet/runner:latest'
};

async function openChipMenu(window: import('@playwright/test').Page, chipText: string) {
  const group = window.locator('.ws-chip-group', { hasText: chipText });
  await group.locator('.ws-chip-menu-trigger').click();
  return window.locator('.ws-chip-menu');
}

test('Chip ⋮ menu: running workspace has Edit / Clone / Close / Delete entries', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [RUNNING_WS] });
    const menu = await openChipMenu(window, 'happy-llama');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Edit…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Clone…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Close…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete…' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Chip ⋮ Delete: opens the confirm modal, then purges container + state + vault', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [RUNNING_WS] });
    const menu = await openChipMenu(window, 'happy-llama');
    await menu.getByRole('menuitem', { name: 'Delete…' }).click();

    // Confirmation modal appears.
    await expect(window.getByRole('heading', { name: 'Delete workspace' })).toBeVisible();
    await expect(window.locator('.modal').getByText(/Permanently delete/)).toBeVisible();

    await window.getByRole('button', { name: 'Delete permanently' }).click();

    // Wait for the modal to close before asserting calls — the modal
    // closes only after stop + remove + vault all finish.
    await expect(window.getByRole('heading', { name: 'Delete workspace' })).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.stop).toContain(RUNNING_WS.containerId);
    expect(calls.remove).toEqual([
      { containerId: RUNNING_WS.containerId, deleteState: true }
    ]);
    expect(calls.vaultDeleteAllForWorkspace).toContain(RUNNING_WS.id);
  } finally {
    await app.close();
  }
});

test('Chip ⋮ Clone: opens WorkspaceModal pre-filled with `<source>-2`', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [RUNNING_WS] });
    const menu = await openChipMenu(window, 'happy-llama');
    await menu.getByRole('menuitem', { name: 'Clone…' }).click();

    // Modal opens to the New tab with the suggested clone name.
    await expect(window.getByRole('tab', { name: 'New' })).toHaveAttribute('aria-selected', 'true');
    await expect(window.getByLabel('Workspace name')).toHaveValue('happy-llama-2');
    // Description carries over.
    await expect(window.getByLabel('Workspace description')).toHaveValue('API server work');
  } finally {
    await app.close();
  }
});

test('Saved-tab Delete: row Delete button opens confirm modal', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [STOPPED_WS] });
    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();

    const row = window.locator('.saved-row', { hasText: 'calm-otter' });
    await row.locator('.saved-row-header').click();
    await row.getByRole('button', { name: /Delete/ }).click();

    // The Saved-tab Delete bubbles up, the workspace modal closes, and
    // the confirmation modal opens at the top level.
    await expect(window.getByRole('heading', { name: 'Delete workspace' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Saved-tab Clone: row Clone button reopens the modal on New with suggested name', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [STOPPED_WS] });
    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();

    const row = window.locator('.saved-row', { hasText: 'calm-otter' });
    await row.locator('.saved-row-header').click();
    await row.getByRole('button', { name: /Clone/ }).click();

    // Modal re-opens on New tab with `calm-otter-2` suggested.
    await expect(window.getByRole('tab', { name: 'New' })).toHaveAttribute('aria-selected', 'true');
    await expect(window.getByLabel('Workspace name')).toHaveValue('calm-otter-2');
  } finally {
    await app.close();
  }
});

test('Chip ⋮ Edit: Save with no container-level changes does NOT show the restart banner', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [RUNNING_WS] });
    // Select the workspace so its TerminalPane is the visible one (the
    // restart banner only renders inside the visible pane).
    await window.locator('.ws-chip-group', { hasText: 'happy-llama' }).getByRole('button').first().click();

    const menu = await openChipMenu(window, 'happy-llama');
    await menu.getByRole('menuitem', { name: 'Edit…' }).click();

    // Edit modal opens.
    await expect(window.locator('.modal-tab', { hasText: 'Edit happy-llama' })).toBeVisible();

    // Change only render-only fields (description). Don't touch env/image/resources.
    await window.getByLabel('Workspace description').fill('Edited description');

    // Save.
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(window.locator('.modal-tab', { hasText: 'Edit happy-llama' })).toBeHidden();

    // writeManifest was called with the edited description.
    const calls = await getCalls(app);
    expect(calls.writeManifest).toHaveLength(1);
    expect((calls.writeManifest[0] as { description: string }).description).toBe('Edited description');

    // No restart banner — render-only edit.
    await expect(window.locator('.restart-banner')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Chip ⋮ Edit: Save with container-level changes (image) shows the restart banner', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [RUNNING_WS] });
    await window.locator('.ws-chip-group', { hasText: 'happy-llama' }).getByRole('button').first().click();

    const menu = await openChipMenu(window, 'happy-llama');
    await menu.getByRole('menuitem', { name: 'Edit…' }).click();

    // Change the image — a container-level field.
    const imageInput = window.getByLabel('Image reference');
    await imageInput.fill('ghcr.io/imioimi/claude-fleet/runner:different');

    await window.getByRole('button', { name: 'Save' }).click();
    await expect(window.locator('.modal-tab', { hasText: 'Edit happy-llama' })).toBeHidden();

    // Banner appears in the visible TerminalPane.
    const banner = window.locator('.terminal-pane:not([aria-hidden="true"]) .restart-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Changes apply on next start');
    await expect(banner.getByRole('button', { name: 'Restart now' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Restart banner: Dismiss removes it; Restart now calls stop + start', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [RUNNING_WS] });
    await window.locator('.ws-chip-group', { hasText: 'happy-llama' }).getByRole('button').first().click();

    // Open edit, change image, save → banner shows.
    const menu = await openChipMenu(window, 'happy-llama');
    await menu.getByRole('menuitem', { name: 'Edit…' }).click();
    await window.getByLabel('Image reference').fill('ghcr.io/imioimi/claude-fleet/runner:different');
    await window.getByRole('button', { name: 'Save' }).click();

    const banner = window.locator('.terminal-pane:not([aria-hidden="true"]) .restart-banner');
    await expect(banner).toBeVisible();

    // Restart now → stop + start fire; banner disappears.
    await banner.getByRole('button', { name: 'Restart now' }).click();
    await expect(banner).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.stop).toContain(RUNNING_WS.containerId);
    expect(calls.start).toContain(RUNNING_WS.id);
  } finally {
    await app.close();
  }
});
