// Create-workspace flow: opening the modal, the OAuth-default submit, and
// the Container/Local kind picker.
//
// `contextBridge.exposeInMainWorld` makes the api object's properties
// effectively immutable from the renderer side, so we can't mock
// `window.api` from a `window.evaluate`. mockMainIpc swaps the
// underlying ipcMain handlers in the main process via `app.evaluate`.
//
// The workspace's private folder (<fleetRoot>/<id>) and the shared folder
// are created by the backend under the app-level fleet root — the form no
// longer collects a host path, so there's nothing to validate / pre-create
// here.
//
// The actual OAuth handshake (browser → Anthropic → auth code) can't
// be tested in CI — it needs real credentials and an interactive
// browser. What we guarantee here is the foundation: a default-form
// submit produces a workspace with `authMode='oauth'` and an empty
// env, so when claude starts in the PTY there's no ANTHROPIC_API_KEY
// env to win precedence over OAuth.

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc, getCalls, activePane, REPO_ROOT } from './_helpers.js';

test('"+" add-workspace button opens the modal', async () => {
  const { app, window } = await launch();
  try {
    // WorkspaceTabStrip disables the "+" add-workspace button when
    // backendReady === false; stub the backend so the test isn't gated
    // on host Docker state.
    await mockMainIpc(app);
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Create flow (OAuth mode): default submit produces authMode=oauth and empty env', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app);

    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('test-oauth-workspace');
    // Name only — image auto-fills to the default runner, no host path to pick.

    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.ensureImage).toHaveLength(1);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({
      name: 'test-oauth-workspace',
      workspaceSubdir: '',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] }
    });
    // Container workspaces don't carry a host path — the backend derives it
    // (local workspaces are the only ones that supply workspaceRoot, #16).
    expect((calls.create[0] as { workspaceRoot?: string }).workspaceRoot).toBeUndefined();
    // Every create is keyed by a freshly minted ULID.
    const spec = calls.create[0] as { id: string };
    expect(typeof spec.id).toBe('string');
    expect(spec.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
  } finally {
    await app.close();
  }
});

test('Workspace kind selector: Local reveals a working-directory field and creates with kind:local (#16)', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app);
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();

    // Both kind radios are visible; Container is the default.
    const container = window.getByRole('radio', { name: /Container/ });
    const local = window.getByRole('radio', { name: /Local/ });
    await expect(container).toBeChecked();
    await expect(local).not.toBeChecked();

    // Container shows the Image field; Local swaps it for a Working directory.
    await expect(window.getByLabel('Working directory')).toBeHidden();
    await local.check();
    await expect(window.getByLabel('Working directory')).toBeVisible();
    await expect(window.getByLabel('Image reference')).toBeHidden();

    // Submitting Local with no directory is blocked client-side (no create call).
    await window.getByLabel('Workspace name').fill('local-ws');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.locator('.error-text')).toContainText(/working directory/i);
    expect((await getCalls(app)).create).toEqual([]);

    // With a directory, the create fires with kind:'local' + the chosen path,
    // and NO image (and ensureImage is not pulled for a local workspace).
    await window.getByLabel('Working directory').fill('/home/me/proj');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.ensureImage ?? []).toEqual([]);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({
      name: 'local-ws',
      kind: 'local',
      workspaceRoot: '/home/me/proj'
    });
    expect((calls.create[0] as { image?: string }).image).toBeUndefined();
  } finally {
    await app.close();
  }
});

test('Local workspace (mock backend): create → terminal mounts → stop (#16)', async () => {
  // Real ipc handlers + mock backend. Exercises the full local create path
  // (kind dispatch, host-dir validation, manifest write) and that the pane
  // mounts a PTY. Uses an existing host dir since the real create handler
  // validates the working directory.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByRole('radio', { name: /Local/ }).check();
    await window.getByLabel('Workspace name').fill('local-mock');
    await window.getByLabel('Working directory').fill(REPO_ROOT);
    await window.getByRole('button', { name: 'Create & start' }).click();

    // The new local workspace appears in the warm strip and its terminal mounts.
    const chip = window.locator('.ws-chip', { hasText: 'local-mock' });
    await expect(chip).toBeVisible({ timeout: 5_000 });
    await chip.click();
    await expect(activePane(window).locator('.terminal-host')).toBeVisible();
  } finally {
    await app.close();
  }
});
