// Create-workspace flow: opening the modal, validation, OAuth submit,
// missing-workspace-dir confirmation, the Container/Local kind picker,
// and remembering the last workspace root across opens.
//
// `contextBridge.exposeInMainWorld` makes the api object's properties
// effectively immutable from the renderer side, so we can't mock
// `window.api` from a `window.evaluate`. mockMainIpc swaps the
// underlying ipcMain handlers in the main process via `app.evaluate`.
//
// The actual OAuth handshake (browser → Anthropic → auth code) can't
// be tested in CI — it needs real credentials and an interactive
// browser. What we guarantee here is the foundation: a default-form
// submit produces a workspace with `authMode='oauth'` and an empty
// env, so when claude starts in the PTY there's no ANTHROPIC_API_KEY
// env to win precedence over OAuth.

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc, getCalls } from './_helpers.js';

test('+ New workspace opens the modal', async () => {
  const { app, window } = await launch();
  try {
    // WorkspaceTabStrip disables the + New workspace button when
    // backendReady === false; stub the backend so the test isn't gated
    // on host Docker state.
    await mockMainIpc(app);
    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Create button surfaces validation errors when required fields are empty', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app);
    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();

    // Name now has a pet-name placeholder default, so the remaining required
    // field is the workspace root — we still expect a "required" / "match"
    // error to be surfaced rather than a silent no-op.
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.locator('.error-text')).toContainText(/required|match/);
  } finally {
    await app.close();
  }
});

test('Create flow (OAuth mode): default submit produces authMode=oauth and empty env', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { isDirectoryReturns: true });

    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await window.getByLabel('Workspace name').fill('test-oauth-workspace');
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/fleet-test');
    // Subdir + env left blank → OAuth-only workspace

    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.ensureImage).toHaveLength(1);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({
      name: 'test-oauth-workspace',
      workspaceRoot: '/tmp/fleet-test',
      workspaceSubdir: '',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] }
    });
    // Every create is keyed by a freshly minted ULID.
    const spec = calls.create[0] as { id: string };
    expect(typeof spec.id).toBe('string');
    expect(spec.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
  } finally {
    await app.close();
  }
});

test('Create flow: missing workspace prompts to create it and mkdirps before workspace-create', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { isDirectoryReturns: false });
    // window.confirm is a vanilla window method (not contextBridge-managed),
    // so we can override it from the renderer side directly.
    await window.evaluate(() => {
      const g = window as unknown as { __confirmArgs: string[] };
      g.__confirmArgs = [];
      window.confirm = (msg?: string) => {
        g.__confirmArgs.push(msg ?? '');
        return true;
      };
    });

    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await window.getByLabel('Workspace name').fill('test-mkdir');
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/does-not-exist-yet');

    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();

    const confirmArgs = await window.evaluate(
      () => (window as unknown as { __confirmArgs: string[] }).__confirmArgs
    );
    const calls = await getCalls(app);
    expect(confirmArgs[0]).toContain('/tmp/does-not-exist-yet');
    expect(calls.mkdirp).toEqual(['/tmp/does-not-exist-yet']);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({ workspaceRoot: '/tmp/does-not-exist-yet' });
  } finally {
    await app.close();
  }
});

test('Create flow: declining the missing-workspace confirm aborts without mkdirp or create', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { isDirectoryReturns: false });
    await window.evaluate(() => {
      window.confirm = () => false;
    });

    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await window.getByLabel('Workspace name').fill('test-decline');
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/declined-path');
    await window.getByRole('button', { name: 'Create & start' }).click();

    // Modal stays open after user declines the create-folder confirmation
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();

    const calls = await getCalls(app);
    expect(calls.mkdirp).toEqual([]);
    expect(calls.create).toEqual([]);
  } finally {
    await app.close();
  }
});

test('Create modal: workspace root persists across opens', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app);
    // Start with no remembered workspace so the first open's input
    // value is deterministically empty.
    await window.evaluate(() => localStorage.removeItem('claude-fleet:lastWorkspaceRoot'));

    const newWorkspace = window
      .locator('.top-strip')
      .getByRole('button', { name: '+ New workspace' });
    const wsInput = window.getByPlaceholder('/home/troy/repos');

    // First open + submit
    await newWorkspace.click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();
    await expect(wsInput).toHaveValue('');
    await window.getByLabel('Workspace name').fill('persistence-test-1');
    await wsInput.fill('/tmp/persistence-test-A');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();

    // Second open — the workspace input should remember the previous value.
    await newWorkspace.click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();
    await expect(wsInput).toHaveValue('/tmp/persistence-test-A');
  } finally {
    await app.close();
  }
});

test('Workspace kind selector: Local shows a "coming soon" error on submit', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app);
    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();

    // Both kind radios are visible; Container is the default.
    const container = window.getByRole('radio', { name: /Container/ });
    const local = window.getByRole('radio', { name: /Local/ });
    await expect(container).toBeChecked();
    await expect(local).not.toBeChecked();

    // Pick Local and submit — should block with a "not implemented" error,
    // never call workspace:create.
    await local.check();
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/local-ws');
    await window.getByRole('button', { name: 'Create & start' }).click();

    await expect(window.locator('.error-text')).toContainText(/aren't implemented yet|coming soon/i);
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();
    const calls = await getCalls(app);
    expect(calls.create).toEqual([]);
  } finally {
    await app.close();
  }
});
