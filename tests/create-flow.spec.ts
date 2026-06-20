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
import { launch, mockMainIpc, getCalls } from './_helpers.js';

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
    // The renderer no longer supplies a host path — the backend derives it.
    expect(calls.create[0]).not.toHaveProperty('workspaceRoot');
    // Every create is keyed by a freshly minted ULID.
    const spec = calls.create[0] as { id: string };
    expect(typeof spec.id).toBe('string');
    expect(spec.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
  } finally {
    await app.close();
  }
});

test('Workspace kind selector: Local shows a "coming soon" error on submit', async () => {
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

    // Pick Local and submit — should block with a "not implemented" error,
    // never call workspace:create.
    await local.check();
    await window.getByRole('button', { name: 'Create & start' }).click();

    await expect(window.locator('.error-text')).toContainText(/aren't implemented yet|coming soon/i);
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();
    const calls = await getCalls(app);
    expect(calls.create).toEqual([]);
  } finally {
    await app.close();
  }
});
