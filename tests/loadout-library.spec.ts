// Loadout Library UI (#16-followup) end-to-end, mock backend. Real ipc + the
// seeded built-in starters. Creates a container workspace (so a manifest exists
// for the install to track), then browses / searches / installs / uninstalls a
// loadout via the left-rail Library accordion.

import { test, expect } from '@playwright/test';
import { launch } from './_helpers.js';

test('Library: accordion lists starters, search filters, install + uninstall round-trip (#16)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Create a container workspace — install needs a manifest on disk to track.
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('lib-test');
    // Container is the default kind; the image input auto-fills the runner.
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();
    // Explicitly select the new workspace (with seeded mock workspaces present,
    // auto-selection can bounce); the Library installs into the selected one.
    await window.locator('.ws-chip', { hasText: 'lib-test' }).click();

    // The Library accordion shows the two built-in starters.
    const specCard = window.locator('.loadout-card', { hasText: 'Spec-Driven Dev' });
    const ccCard = window.locator('.loadout-card', { hasText: 'Conventional Commits' });
    await expect(specCard).toBeVisible({ timeout: 5_000 });
    await expect(ccCard).toBeVisible();

    // Search filters by title/description.
    await window.getByLabel('Search loadouts').fill('spec');
    await expect(ccCard).toHaveCount(0);
    await expect(specCard).toBeVisible();
    await window.getByLabel('Search loadouts').fill('');
    await expect(ccCard).toBeVisible();

    // Install Spec-Driven Dev → the card flips to Installed.
    await specCard.getByRole('button', { name: '+ Install' }).click();
    await expect(specCard.getByRole('button', { name: '✓ Installed' })).toBeVisible({ timeout: 5_000 });
    // Conventional Commits is still installable (per-loadout state).
    await expect(ccCard.getByRole('button', { name: '+ Install' })).toBeVisible();

    // Uninstall via the ⋮ menu → back to installable.
    await specCard.getByRole('button', { name: 'Loadout actions' }).click();
    await window.getByRole('button', { name: 'Uninstall' }).click();
    await expect(specCard.getByRole('button', { name: '+ Install' })).toBeVisible({ timeout: 5_000 });
  } finally {
    await app.close();
  }
});

test('Library: clicking a card opens the review with files + Install (#16)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('lib-test2');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();
    // Explicitly select the new workspace (with seeded mock workspaces present,
    // auto-selection can bounce); the Library installs into the selected one.
    await window.locator('.ws-chip', { hasText: 'lib-test2' }).click();

    const specCard = window.locator('.loadout-card', { hasText: 'Spec-Driven Dev' });
    await expect(specCard).toBeVisible({ timeout: 5_000 });
    // Click the card body (not the install button) → review modal.
    await specCard.locator('.lc-title').click();

    const modal = window.locator('.modal.loadout-review');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Loadout · review')).toBeVisible();
    // Files-written manifest lists the CLAUDE.md block the starter ships.
    await expect(modal.locator('.manifest .path', { hasText: 'CLAUDE.md' })).toBeVisible();
    // Install from the review.
    await modal.getByRole('button', { name: /^Install/ }).click();
    await expect(modal).toBeHidden();
    await expect(specCard.getByRole('button', { name: '✓ Installed' })).toBeVisible({ timeout: 5_000 });
  } finally {
    await app.close();
  }
});
