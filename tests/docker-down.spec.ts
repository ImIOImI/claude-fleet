// Daemon-down degraded mode (#380), driven through __test:setDockerDown so
// the mock backend itself stays untouched (it serves both backends in mock
// mode; the hook rejects only the docker half of the merge).
//
// Seeding note: the mock fleet seeds mock-alpha and mock-beta as running
// container workspaces, but they only exist in the mock's in-memory map with
// no on-disk manifests. mergeWorkspaces synthesises "unreachable" entries only
// for workspaces that have a manifest but are absent from the live list. So
// seeded mock workspaces disappear when docker goes down rather than becoming
// unreachable.
//
// The test therefore creates a container workspace via the UI first (which
// calls workspace:create → writeWorkspaceManifest on disk). After that the
// workspace has a manifest; flipping docker down causes mergeWorkspaces to
// produce state:'unreachable' with lastKnownState:'running'.

import { test, expect } from '@playwright/test';
import { launch, callTestIpc, REPO_ROOT } from './_helpers.js';

test('daemon down: banner, inert chip, gated create, recovery', async () => {
  // One continuous scenario (down → degraded UI → local create → recovery), so
  // the worst-case sum of poll waits (5s renderer poll + 1s list TTL per
  // transition, two workspace creations, app launch) legitimately exceeds the
  // 30s suite default — same pattern as committee-post.real.spec.ts.
  test.setTimeout(120_000);
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    // ── Baseline: no banner ───────────────────────────────────────────────────
    await expect(window.locator('.daemon-banner')).toHaveCount(0);

    // ── Create a container workspace so it gets a manifest on disk ────────────
    // Seeded mock workspaces have no manifests; a workspace created via the UI
    // goes through workspace:create → writeWorkspaceManifest and survives a
    // docker-down event as an "unreachable" chip.
    // The "Add workspace" button is always enabled (daemon state does not gate it).
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('test-container-ws');
    // Default kind is Container; submit immediately.
    await window.getByRole('button', { name: 'Create & start' }).click();

    // Wait for the new workspace chip to appear in the warm strip.
    const newChip = window.locator('.ws-chip', { hasText: 'test-container-ws' });
    await expect(newChip).toBeVisible({ timeout: 8_000 });

    // ── Open the create modal while docker is still up ────────────────────────
    // We open the modal before setting docker down so we can observe the
    // Container radio transition to disabled reactively (the renderer re-polls
    // workspace:ping every 5s; invalidateWorkspaceList wakes it sooner).
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    // Modal should be open on the New tab.
    await expect(window.getByLabel('Workspace name')).toBeVisible();
    const containerRadio = window.getByRole('radio', { name: /Container/ });
    const localRadio = window.getByRole('radio', { name: /Local/ });
    // Baseline: Container is enabled and checked, Local is enabled.
    await expect(containerRadio).toBeEnabled();
    await expect(localRadio).toBeEnabled();
    await expect(containerRadio).toBeChecked();

    // ── Flip the daemon down ──────────────────────────────────────────────────
    await callTestIpc(app, '__test:setDockerDown', [true]);

    // ── Banner visible within one poll cycle ──────────────────────────────────
    // The renderer polls workspace:ping every 5s; invalidateWorkspaceList fires
    // on setDockerDown to accelerate the cache miss. Allow 10s for the banner.
    await expect(window.locator('.daemon-banner')).toBeVisible({ timeout: 10_000 });

    // ── Create modal (still open): Container radio is disabled ────────────────
    // backendReady===false propagates into WorkspaceForm's dockerUp prop,
    // disabling the Container radio and showing the hint. Local remains enabled.
    await expect(containerRadio).toBeDisabled({ timeout: 10_000 });
    await expect(localRadio).toBeEnabled();
    // The hint text appears next to the disabled radio.
    await expect(window.locator('.kind-hint')).toContainText('needs Docker — daemon unreachable');

    // Close the modal via the form's Cancel button — Escape only dismisses the
    // labels dropdown, not the modal, and a lingering backdrop would swallow
    // every later click in this test.
    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(window.getByLabel('Workspace name')).toHaveCount(0);

    // ── "Add workspace" button is ENABLED while docker is down ───────────────
    // The button always allows opening the modal; gating happens inside the
    // modal (Container radio disabled, Local still enabled).
    await expect(
      window.locator('.top-strip').getByRole('button', { name: 'Add workspace' })
    ).toBeEnabled();

    // ── Unreachable chip: dimmed (opacity + dashed border class), labeled ─────
    // The created workspace had state:'running' at last-known, so it surfaces as
    // unreachable with lastKnownState:'running', rendering "unreachable · was running".
    const chip = window.locator('.ws-chip-group.unreachable', { hasText: 'test-container-ws' });
    await expect(chip).toHaveCount(1, { timeout: 10_000 });
    await expect(chip).toContainText('unreachable · was running');

    // Chip is still clickable and selects the workspace.
    await chip.click();

    // ── Selected unreachable workspace: main pane shows reattach card ─────────
    await expect(window.locator('.main-body')).toContainText('will reattach automatically');

    // ── Local workspace creation works while docker is down ───────────────────
    // The "Add workspace" button is enabled; open the modal and switch to Local.
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    // Modal opens — default tab: Saved (has workspaces) or New. Switch to New.
    const newTab = window.getByRole('tab', { name: 'New' });
    await newTab.click();
    // Container radio is disabled, Local is enabled and we select it.
    const containerRadio2 = window.getByRole('radio', { name: /Container/ });
    const localRadio2 = window.getByRole('radio', { name: /Local/ });
    await expect(containerRadio2).toBeDisabled();
    await expect(localRadio2).toBeEnabled();
    // WorkspaceForm defaults kind to 'local' when dockerUp===false, so Local
    // should already be selected; if not, select it explicitly.
    if (!(await localRadio2.isChecked())) {
      await localRadio2.check();
    }
    await expect(localRadio2).toBeChecked();
    // Fill in the local workspace form.
    await window.getByLabel('Workspace name').fill('local-while-down');
    await window.getByLabel('Working directory').fill(REPO_ROOT);
    await window.getByRole('button', { name: 'Create & start' }).click();

    // The new local workspace chip appears in the warm strip while daemon is still down.
    const localChip = window.locator('.ws-chip', { hasText: 'local-while-down' });
    await expect(localChip).toBeVisible({ timeout: 8_000 });

    // ── Recovery: flip docker back up ────────────────────────────────────────
    await callTestIpc(app, '__test:setDockerDown', [false]);

    // Banner drops within one poll cycle (up to 10s).
    await expect(window.locator('.daemon-banner')).toHaveCount(0, { timeout: 10_000 });

    // Unreachable chip class is gone; workspace re-merges as running.
    await expect(window.locator('.ws-chip-group.unreachable')).toHaveCount(0, { timeout: 10_000 });

    // The container workspace chip is still present and no longer dimmed.
    await expect(
      window.locator('.ws-chip-group', { hasText: 'test-container-ws' })
    ).toBeVisible();

    // "Add workspace" button is still enabled (it's always enabled).
    await expect(
      window.locator('.top-strip').getByRole('button', { name: 'Add workspace' })
    ).toBeEnabled();
  } finally {
    await app.close();
  }
});
