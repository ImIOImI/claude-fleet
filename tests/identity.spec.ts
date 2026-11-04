// Settings › Account (remote-workspaces (b)), mock backend. No GitHub traffic:
// a fresh userData has no token, and status({refresh}) only calls GitHub when
// a token is saved. The real Sign in button is never clicked; the second test
// stubs identity:* in main.
import { test, expect } from '@playwright/test';
import { getCalls, launch, mockMainIpc } from './_helpers.js';

test('Settings › Account offers GitHub sign-in when a client id is set', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_GITHUB_CLIENT_ID: 'Iv1.e2eplaceholder' });
  const T = { timeout: 10_000 };
  try {
    await window.locator('.top-strip .settings-btn').click(T);
    await window.locator('.modal-tab', { hasText: 'Account' }).click(T);
    const tab = window.locator('.account-tab');
    await expect(tab.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible(T);
    await expect(tab).toContainText('read:org');
    await expect(tab).toContainText('read:packages');
  } finally {
    await app.close();
  }
});

test('Settings › Account: stubbed sign-in shows the code, Cancel and Sign out reset it', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  const T = { timeout: 10_000 };
  try {
    await mockMainIpc(app, {
      identityStatus: {
        signedIn: true,
        identity: { provider: 'github', login: 'octo', id: 42, name: 'Octo Cat', displayName: 'Octo Cat', avatarUrl: null, teams: ['acme/platform'] },
        scopes: ['read:org', 'read:packages'],
        packagesAccess: true
      }
    });
    await window.locator('.top-strip .settings-btn').click(T);
    await window.locator('.modal-tab', { hasText: 'Account' }).click(T);
    const tab = window.locator('.account-tab');

    await test.step('signed in: name, @login, teams', async () => {
      await expect(tab.locator('.account-name')).toHaveText('Octo Cat', T);
      await expect(tab.locator('.account-login')).toHaveText('@octo');
      await expect(tab).toContainText('acme/platform');
    });
    await test.step('sign out returns to the sign-in offer', async () => {
      await tab.getByRole('button', { name: 'Sign out' }).click(T);
      await expect(tab.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible(T);
    });
    await test.step('sign in shows the device code; Cancel abandons it', async () => {
      await tab.getByRole('button', { name: 'Sign in with GitHub' }).click(T);
      await expect(tab.locator('.device-code')).toHaveText('E2E0-0000', T);
      await tab.getByRole('button', { name: 'Cancel' }).click(T);
      await expect(tab.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible(T);
    });

    const calls = await getCalls(app);
    expect(calls.identityStatus).toEqual(expect.arrayContaining([{ refresh: false }, { refresh: true }]));
    expect(calls.identitySignOut).toHaveLength(1);
    expect(calls.identitySignInStart).toHaveLength(1);
    expect(calls.identitySignInCancel).toHaveLength(1);
  } finally {
    await app.close();
  }
});
