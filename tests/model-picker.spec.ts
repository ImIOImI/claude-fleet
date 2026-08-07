// tests/model-picker.spec.ts
// Model combobox in the workspace form (#256): endpoint selection derives
// authMode/endpointId on the wire; Auth morphs; dangling endpoints block
// submit; saved-tab resume keeps endpointId (the #252 savedToInitial bug).
import { expect, test } from '@playwright/test';
import { getCalls, launch, mockMainIpc } from './_helpers.js';

const EP = { id: 'ep1', name: 'ollama-local', modelId: 'qwen3:4b', baseUrl: 'http://host.docker.internal:11434' };

test('picking an endpoint morphs Auth and submits authMode=endpoint', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [EP] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('ep-ws');

    await window.getByRole('button', { name: 'Model' }).click();
    await window.getByRole('option', { name: /ollama-local/ }).click();

    // Auth radios are gone; the passive note names the endpoint.
    // The radio accessible name includes its help text so use regex.
    await expect(window.getByRole('radio', { name: /OAuth/ })).toBeHidden();
    await expect(window.locator('.auth-note')).toContainText('ollama-local');
    await expect(window.locator('.auth-note')).toContainText('key from endpoint registry');

    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();
    const calls = await getCalls(app);
    expect(calls.create[0]).toMatchObject({ name: 'ep-ws', authMode: 'endpoint', endpointId: 'ep1' });
  } finally {
    await app.close();
  }
});

test('empty registry: combobox lists Claude + Add endpoint only; default submit stays oauth', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByRole('button', { name: 'Model' }).click();
    const listbox = window.locator('[role="listbox"][aria-label="Model options"]');
    const options = listbox.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.first()).toContainText('Claude');
    await expect(options.last()).toContainText('Add endpoint');
    await window.keyboard.press('Escape');

    await window.getByLabel('Workspace name').fill('plain-ws');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();
    const calls = await getCalls(app);
    expect(calls.create[0]).toMatchObject({ authMode: 'oauth' });
    expect((calls.create[0] as { endpointId?: string }).endpointId).toBeUndefined();
  } finally {
    await app.close();
  }
});

test('radio memory: model switch away and back keeps the Claude auth choice', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [EP] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    // Enable the API-key radio by adding the env var, then select it.
    await window.getByText('Env vars').click();
    await window.getByRole('button', { name: '+ Add env var' }).click();
    await window.getByLabel('Env key 1').fill('ANTHROPIC_API_KEY');
    await window.getByLabel('Env value 1').fill('sk-test');
    // Radio accessible name includes help text ("ANTHROPIC_API_KEY in env" etc.) — use regex.
    await window.getByRole('radio', { name: /API key/ }).check();

    await window.getByRole('button', { name: 'Model' }).click();
    await window.getByRole('option', { name: /ollama-local/ }).click();
    await window.getByRole('button', { name: 'Model' }).click();
    await window.getByRole('option', { name: /Claude/ }).click();
    await expect(window.getByRole('radio', { name: /API key/ })).toBeChecked();
  } finally {
    await app.close();
  }
});

test('dangling endpoint: edit form shows (deleted endpoint) and blocks submit', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      endpoints: [], // registry no longer has ep-gone
      workspaceList: [
        { name: 'stale-ep-ws', state: 'stopped', authMode: 'endpoint', endpointId: 'ep-gone', kind: 'container', image: 'x' }
      ]
    });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    const row = window.locator('.saved-row', { hasText: 'stale-ep-ws' });
    // Expand by clicking the saved-row-header button (the li itself is not clickable).
    await row.locator('.saved-row-header').click();
    await expect(row.getByRole('button', { name: 'Model' })).toContainText('(deleted endpoint)');
    await row.locator('.modal-footer').getByRole('button', { name: 'Resume' }).click();
    await expect(row.getByText(/model endpoint was deleted/)).toBeVisible();
    const calls = await getCalls(app);
    expect(calls.writeManifest).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test('saved-tab resume keeps endpointId (#252 regression class)', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      endpoints: [EP],
      workspaceList: [
        { name: 'ep-resume-ws', state: 'stopped', authMode: 'endpoint', endpointId: 'ep1', kind: 'container', image: 'x' }
      ]
    });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    const row = window.locator('.saved-row', { hasText: 'ep-resume-ws' });
    // Expand by clicking the saved-row-header button (the li itself is not clickable).
    await row.locator('.saved-row-header').click();
    await expect(row.getByRole('button', { name: 'Model' })).toContainText('ollama-local');
    await row.locator('.modal-footer').getByRole('button', { name: 'Resume' }).click();
    await expect(window.getByRole('tab', { name: 'Saved' })).toBeHidden();
    const calls = await getCalls(app);
    expect(calls.writeManifest[0]).toMatchObject({ authMode: 'endpoint', endpointId: 'ep1' });
  } finally {
    await app.close();
  }
});

test('＋ Add endpoint… opens Settings on the Model Endpoints tab', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByRole('button', { name: 'Model' }).click();
    await window.getByRole('option', { name: /Add endpoint/ }).click();
    // SettingsModal tabs are <div class="modal-tab"> not <button> — locate by class + text.
    await expect(window.locator('.modal-tab', { hasText: 'Model Endpoints' })).toHaveAttribute('aria-current', 'page');
  } finally {
    await app.close();
  }
});
