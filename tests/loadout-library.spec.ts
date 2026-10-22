// Loadout Library UI (#16-followup) end-to-end, mock backend. Real ipc + the
// seeded built-in starters. Creates a container workspace (so a manifest exists
// for the install to track), then browses / searches / installs / uninstalls a
// loadout via the left-rail Library accordion.

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, mockMainIpc, getCalls, callTestIpc } from './_helpers.js';

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

// ── Library v2 Phase 2: remote sources + Update ↑ ────────────────────────────

const SOURCE = 'ghcr.io/imioimi/claude-fleet-loadouts';

const PHASE2_ENTRY = {
  id: 'spec-driven',
  title: 'Spec-Driven',
  description: 'Spec-driven dev workflow',
  tags: ['workflow'],
  version: '1.0.0',
  remoteVersion: '1.1.0',
  present: true,
  installed: true,
  updateAvailable: true,
  favorited: false,
  sources: [SOURCE],
};

test('Library v2 Phase 2: source checkbox in browser modal + Update ↑ in rail', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          id: 'ws-p2',
          name: 'ws-p2',
          state: 'running',
          workspaceRoot: '/workspace/p2',
          containerId: 'container-p2',
          kind: 'container',
        },
      ],
      loadoutCatalog: [PHASE2_ENTRY],
      loadoutSources: [SOURCE],
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

    // Select the workspace so the Update ↑ button is enabled.
    const chip = window.locator('.ws-chip', { hasText: 'ws-p2' });
    await chip.waitFor({ state: 'visible', timeout: 6_000 });
    await chip.click();
    await window.waitForTimeout(200);

    // The installed card should show Update ↑ since updateAvailable=true.
    const card = window.locator('.loadout-card', { hasText: 'Spec-Driven' });
    await card.waitFor({ state: 'visible', timeout: 8_000 });
    const updateBtn = card.locator('.btn.update');
    await updateBtn.waitFor({ state: 'visible', timeout: 4_000 });
    await expect(updateBtn).toContainText('Update');

    // Open the browser modal and verify the source checkbox is present.
    const browseBtn = window.locator('.lib-browse');
    await browseBtn.waitFor({ state: 'visible', timeout: 4_000 });
    await browseBtn.click();

    const browserModal = window.locator('.modal.loadout-browser');
    await browserModal.waitFor({ state: 'visible', timeout: 6_000 });

    // The source row should be visible in the .lb-sources section.
    const sourceRow = browserModal.locator('.lb-source-row');
    await sourceRow.waitFor({ state: 'visible', timeout: 4_000 });
    await expect(sourceRow.locator('.lb-source-name')).toContainText('imioimi/claude-fleet-loadouts');

    // Close modal.
    await browserModal.locator('button', { hasText: 'Close' }).click();
    await expect(browserModal).not.toBeVisible();
  } finally {
    await app.close();
  }
});

test('Library v2: adding a source passes the optional access token', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [], loadoutCatalog: [PHASE1_ENTRY] });
    await window.waitForTimeout(400);

    const libraryAccHeader = window.locator('.acc-header', { hasText: 'Library' });
    await libraryAccHeader.waitFor({ state: 'visible', timeout: 8_000 });
    if ((await libraryAccHeader.getAttribute('aria-expanded')) !== 'true') {
      await libraryAccHeader.click();
      await window.waitForTimeout(200);
    }
    await window.locator('.lib-browse').click();
    const browserModal = window.locator('.modal.loadout-browser');
    await browserModal.waitFor({ state: 'visible', timeout: 6_000 });

    const add = browserModal.locator('.lb-add-source');
    await add.locator('input[placeholder="ghcr.io/owner/repo"]').fill('ghcr.io/sumersports/claude-fleet-loadouts');
    const tokenInput = add.locator('input[type="password"]');
    await tokenInput.fill('ghp_test');
    await add.locator('button', { hasText: 'Add' }).click();

    await expect.poll(async () => (await getCalls(app)).addSource).toEqual([
      { base: 'ghcr.io/sumersports/claude-fleet-loadouts', token: 'ghp_test' },
    ]);
    await expect(tokenInput).toHaveValue('');
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

test('Loadout automations: review lists them with ticks, install turns them on with $self bound, uninstall removes them (#407 Phase 8)', async () => {
  const { app, window, userDataDir } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('lo-ws');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();
    const ws = (await callTestIpc<Array<{ id: string; name: string }>>(app, 'workspace:list', [])).find((w) => w.name === 'lo-ws')!;

    const dir = path.join(userDataDir, 'loadouts', 'e2e-autos');
    const put = (rel: string, body: string) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), body); };
    put('loadout.md', '---\ntitle: E2E Autos\nversion: 1.0.0\ndescription: Ships automations\n---\nAutomations for e2e.\n');
    put('automations/watch/automation.yaml', 'name: e2e-watch\ntriggers: [{ manual: { allowFrom: [$self] } }]\nsteps:\n  - id: check\n    script: { run: ./check.sh, runIn: $self }\n  - id: tell\n    prompt: { workspace: $self, mode: live, message: "Look at {{steps.check.stdout}}" }\n');
    put('automations/watch/check.sh', 'echo checked\n');
    put('automations/needs-secret/automation.yaml', 'name: e2e-needs-secret\ntriggers: [{ manual: {} }]\nsteps: [{ id: s, script: { run: "echo $E2E_TOKEN", runIn: $self, secrets: [E2E_TOKEN] } }]\n');
    // A shell this computer has: Windows always has Windows PowerShell.
    const hostShell = process.platform === 'win32' ? 'powershell' : 'sh';
    put('automations/on-host/automation.yaml', `name: e2e-on-host\ntriggers: [{ manual: {} }]\nsteps: [{ id: s, script: { run: "date", runIn: host, shell: ${hostShell} } }]\n`);

    const preview = await callTestIpc<Array<{ folder: string; status: string; defaultOn: boolean; blocked: string | null }>>(app, 'loadouts:automations', [ws.id, 'e2e-autos']);
    expect(preview.map((p) => [p.folder, p.status, p.defaultOn, !!p.blocked])).toEqual([
      ['needs-secret', 'new', false, true], ['on-host', 'new', false, true], ['watch', 'new', true, false]
    ]);

    // The review shows them; install from it.
    await window.reload();
    await window.locator('.ws-chip', { hasText: 'lo-ws' }).click();
    const card = window.locator('.loadout-card', { hasText: 'E2E Autos' });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('.lc-title').click();
    const modal = window.locator('.modal.loadout-review');
    const list = modal.getByLabel('Automations in this loadout');
    await expect(list).toContainText('e2e-watch');
    await expect(modal.getByLabel('Turn on e2e-watch')).toBeChecked();
    await expect(modal.getByLabel('Turn on e2e-needs-secret')).toBeDisabled();
    await expect(list).toContainText('add the secret E2E_TOKEN to turn it on');
    await expect(list.locator('.tag.danger')).toContainText(`runs a script on your computer (${hostShell})`);
    await modal.getByRole('button', { name: /^Install/ }).click();
    await expect(modal).toBeHidden({ timeout: 10_000 });

    const autos = await callTestIpc<Array<{ name: string; enabled: boolean; definition: { steps: Array<Record<string, { workspace?: string; runIn?: string; run?: string }>> }; origin: { loadoutId: string; version: string } | null }>>(app, 'automations:list', []);
    expect(autos.map((a) => [a.name, a.enabled])).toEqual([['e2e-needs-secret', false], ['e2e-watch', true]]);
    const watch = autos.find((a) => a.name === 'e2e-watch')!;
    expect(watch.origin).toMatchObject({ loadoutId: 'e2e-autos', version: '1.0.0' });
    expect(watch.definition.steps[0].script).toEqual({ run: 'echo checked\n', runIn: ws.id });
    expect(watch.definition.steps[1].prompt.workspace).toBe(ws.id);
    const manifest = await callTestIpc<{ installedLoadouts: Array<{ id: string; automations?: string[] }> }>(app, 'workspace:getManifest', [ws.id]);
    expect(manifest.installedLoadouts.find((l) => l.id === 'e2e-autos')?.automations?.sort()).toEqual(['e2e-needs-secret', 'e2e-watch']);

    await callTestIpc(app, 'loadouts:uninstall', [ws.id, 'e2e-autos']);
    expect(await callTestIpc<unknown[]>(app, 'automations:list', [])).toEqual([]);
  } finally {
    await app.close();
  }
});
