import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

async function launch(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [REPO_ROOT],
    cwd: REPO_ROOT
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

test('preload exposes window.api with all expected surfaces', async () => {
  const { app, window } = await launch();
  try {
    const types = await window.evaluate(() => ({
      api: typeof (window as unknown as { api?: unknown }).api,
      docker: typeof (window as unknown as { api?: { docker?: unknown } }).api?.docker,
      vault: typeof (window as unknown as { api?: { vault?: unknown } }).api?.vault,
      pty: typeof (window as unknown as { api?: { pty?: unknown } }).api?.pty,
      fs: typeof (window as unknown as { api?: { fs?: unknown } }).api?.fs,
      dialog: typeof (window as unknown as { api?: { dialog?: unknown } }).api?.dialog
    }));
    expect(types).toEqual({
      api: 'object',
      docker: 'object',
      vault: 'object',
      pty: 'object',
      fs: 'object',
      dialog: 'object'
    });
  } finally {
    await app.close();
  }
});

test('+ New container opens the modal', async () => {
  const { app, window } = await launch();
  try {
    await window.getByRole('button', { name: '+ New container' }).click();
    await expect(window.getByRole('heading', { name: 'New container' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Create button surfaces validation errors when fields are empty', async () => {
  const { app, window } = await launch();
  try {
    await window.getByRole('button', { name: '+ New container' }).click();
    await expect(window.getByRole('heading', { name: 'New container' })).toBeVisible();

    // Click Create with no input — should surface an error, not silently no-op
    await window.getByRole('button', { name: 'Create' }).click();
    await expect(window.locator('.error-text')).toContainText(/required|match/);
  } finally {
    await app.close();
  }
});
