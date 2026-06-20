// Phase 3 — shared OAuth credentials surface in the renderer.
//
// The actual bind-mount happens in main/docker.ts (covered by manual
// verification against real Docker). What we can guarantee at the
// renderer layer is that the `authMode` field flows correctly through
// workspace:create — that's what selects whether the shared bind
// gets added in main.

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc, getCalls } from './_helpers.js';

test('Create: default form submit ships authMode=oauth', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { isDirectoryReturns: true });

    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toHaveAttribute('aria-selected', 'true');

    await window.getByLabel('Workspace name').fill('test-oauth');
    await window.getByRole('button', { name: 'Create & start' }).click();

    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.create).toHaveLength(1);
    expect((calls.create[0] as { authMode: string }).authMode).toBe('oauth');
  } finally {
    await app.close();
  }
});

test('Create: switching to API key + supplying ANTHROPIC_API_KEY ships authMode=apikey', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { isDirectoryReturns: true });

    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

    await window.getByLabel('Workspace name').fill('test-apikey');

    // Open Env vars disclosure → add ANTHROPIC_API_KEY plain (so the
    // API-key radio unlocks without needing the keychain).
    await window.locator('.form-disclosure > summary', { hasText: 'Env vars' }).click();
    await window.getByRole('button', { name: '+ Add env var' }).click();
    await window.getByLabel('Env key 1').fill('ANTHROPIC_API_KEY');
    await window.getByLabel('Env value 1').fill('sk-ant-test');

    // Pick API key.
    await window.getByRole('radio', { name: /API key/ }).check();

    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.create).toHaveLength(1);
    const spec = calls.create[0] as { authMode: string; env: { plain: Record<string, string> } };
    expect(spec.authMode).toBe('apikey');
    expect(spec.env.plain.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  } finally {
    await app.close();
  }
});
