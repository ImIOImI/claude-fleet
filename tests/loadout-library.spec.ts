// Loadout Library UI (#16-followup) end-to-end, mock backend. Real ipc + the
// seeded built-in starters. Creates a container workspace (so a manifest exists
// for the install to track), then browses / searches / installs / uninstalls a
// loadout via the left-rail Library accordion.

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc, getCalls } from './_helpers.js';

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

test('Library: per-card chevron + Collapse all / Expand all (view A)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('lib-collapse');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();
    await window.locator('.ws-chip', { hasText: 'lib-collapse' }).click();

    const specCard = window.locator('.loadout-card', { hasText: 'Spec-Driven Dev' });
    await expect(specCard).toBeVisible({ timeout: 5_000 });

    // Cards start expanded — descriptions are present.
    await expect(window.locator('.loadout-card .lc-desc').first()).toBeVisible();
    const descCount = await window.locator('.loadout-card .lc-desc').count();
    expect(descCount).toBeGreaterThan(1);

    // Per-card chevron collapses just that card (its description goes away;
    // others remain). The chevron stops propagation, so no review modal opens.
    await specCard.locator('.lc-chevron').click();
    await expect(specCard.locator('.lc-desc')).toHaveCount(0);
    await expect(window.locator('.modal.loadout-review')).toHaveCount(0);
    expect(await window.locator('.loadout-card .lc-desc').count()).toBe(descCount - 1);

    // Collapse all → every description hidden; the toggle flips to Expand all.
    await window.getByRole('button', { name: /Collapse all/ }).click();
    await expect(window.locator('.loadout-card .lc-desc')).toHaveCount(0);

    // Expand all → descriptions return.
    await window.getByRole('button', { name: /Expand all/ }).click();
    expect(await window.locator('.loadout-card .lc-desc').count()).toBe(descCount);
  } finally {
    await app.close();
  }
});

// ── Library v2 Phase 1: favorites + browse modal ─────────────────────────────
// These tests use mockMainIpc so they don't rely on seeded built-in starters or
// Docker. They exercise: the .lc-fav favorite toggle wires loadouts:setFavorite
// IPC, the .fav-filter hides non-favorited entries, and .lib-browse opens the
// LoadoutBrowserModal (.modal.loadout-browser) with the catalog entry visible.

const PHASE1_ENTRY = {
  id: 'spec-driven',
  title: 'Spec-Driven',
  description: 'Spec-driven dev workflow',
  tags: ['workflow'],
  version: '1.0.0',
  present: true,
  installed: false,
  updateAvailable: false,
  favorited: false,
  sources: [],
};

test('Library v2: favorite toggle calls setFavorite IPC', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          id: 'ws-1',
          name: 'test-workspace',
          state: 'running',
          workspaceRoot: '/workspace/test',
          containerId: 'container-abc',
          kind: 'container',
        },
      ],
      loadoutCatalog: [PHASE1_ENTRY],
    });

    await window.waitForTimeout(400);

    // Ensure Library accordion is open.
    const libraryAccHeader = window.locator('.acc-header', { hasText: 'Library' });
    await libraryAccHeader.waitFor({ state: 'visible', timeout: 8_000 });
    const isExpanded = await libraryAccHeader.getAttribute('aria-expanded');
    if (isExpanded !== 'true') {
      await libraryAccHeader.click();
      await window.waitForTimeout(200);
    }

    // The catalog entry should appear as a loadout card.
    const card = window.locator('.loadout-card', { hasText: 'Spec-Driven' });
    await card.waitFor({ state: 'visible', timeout: 8_000 });

    // Click the .lc-fav button (visible on expanded cards).
    const favBtn = card.locator('.lc-fav');
    await favBtn.waitFor({ state: 'visible', timeout: 4_000 });
    await favBtn.click();
    await window.waitForTimeout(300);

    // Assert loadouts:setFavorite was called with id='spec-driven', on=true.
    const calls = await getCalls(app);
    const favCalls = calls.setFavorite as Array<{ id: string; on: boolean }>;
    expect(favCalls.length).toBeGreaterThanOrEqual(1);
    expect(favCalls[favCalls.length - 1]).toMatchObject({ id: 'spec-driven', on: true });
  } finally {
    await app.close();
  }
});

test('Library v2: favorites filter hides non-favorited entries', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [],
      loadoutCatalog: [PHASE1_ENTRY],
    });

    await window.waitForTimeout(400);

    const libraryAccHeader = window.locator('.acc-header', { hasText: 'Library' });
    await libraryAccHeader.waitFor({ state: 'visible', timeout: 8_000 });
    const isExpanded = await libraryAccHeader.getAttribute('aria-expanded');
    if (isExpanded !== 'true') {
      await libraryAccHeader.click();
      await window.waitForTimeout(200);
    }

    const card = window.locator('.loadout-card', { hasText: 'Spec-Driven' });
    await card.waitFor({ state: 'visible', timeout: 8_000 });

    const favFilter = window.locator('.fav-filter');
    await favFilter.waitFor({ state: 'visible', timeout: 4_000 });

    // Card is visible before filter is active.
    await expect(card).toBeVisible();

    // Activate the favorites filter — our entry is not favorited, so it should
    // disappear and the "No loadouts match." placeholder should appear.
    await favFilter.click();
    await window.waitForTimeout(200);
    await expect(favFilter).toHaveClass(/\bon\b/);
    await expect(window.locator('.pane-placeholder', { hasText: 'No loadouts match.' })).toBeVisible();

    // Deactivate the filter — card returns.
    await favFilter.click();
    await window.waitForTimeout(200);
    await expect(favFilter).not.toHaveClass(/\bon\b/);
    await expect(card).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Library v2: Browse-all button opens loadout browser modal', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [],
      loadoutCatalog: [PHASE1_ENTRY],
    });

    await window.waitForTimeout(400);

    const libraryAccHeader = window.locator('.acc-header', { hasText: 'Library' });
    await libraryAccHeader.waitFor({ state: 'visible', timeout: 8_000 });
    const isExpanded = await libraryAccHeader.getAttribute('aria-expanded');
    if (isExpanded !== 'true') {
      await libraryAccHeader.click();
      await window.waitForTimeout(200);
    }

    // The "Browse all" button has class .lib-browse and opens the modal.
    const browseBtn = window.locator('.lib-browse');
    await browseBtn.waitFor({ state: 'visible', timeout: 4_000 });
    await browseBtn.click();

    // LoadoutBrowserModal renders as .modal.loadout-browser.
    const browserModal = window.locator('.modal.loadout-browser');
    await browserModal.waitFor({ state: 'visible', timeout: 6_000 });

    // The catalog entry should appear in the results list.
    const browserRow = browserModal.locator('.lb-row', { hasText: 'Spec-Driven' });
    await browserRow.waitFor({ state: 'visible', timeout: 4_000 });
    await expect(browserRow.locator('.lb-row-title')).toContainText('Spec-Driven');

    // Close the modal via the Close button.
    await browserModal.locator('button', { hasText: 'Close' }).click();
    await expect(browserModal).not.toBeVisible();
  } finally {
    await app.close();
  }
});
