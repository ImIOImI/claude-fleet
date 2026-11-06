// Settings › Storage › History and inbox (async store part 4b). Mock mode never
// starts the container: the first test pins the real config.json write, the
// second stubs the store:* channels in main to drive the banner and the
// switch back from a running Postgres store.
import { test, expect, type ElectronApplication } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './_helpers.js';

test('Storage: SQLite by default; a confirmed switch to managed Postgres writes config.json and asks for a restart', async () => {
  const { app, window, userDataDir } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  const storeKey = (): unknown => {
    try {
      return (JSON.parse(readFileSync(join(userDataDir, 'config.json'), 'utf8')) as { store?: unknown }).store;
    } catch {
      return undefined;
    }
  };
  try {
    await expect(window.locator('.store-banner')).toHaveCount(0);
    await window.getByRole('button', { name: 'Settings' }).click();
    const sqlite = window.getByRole('radio', { name: /SQLite \(built in\)/ });
    const managed = window.getByRole('radio', { name: /Postgres, managed by claude-fleet/ });
    await expect(sqlite).toBeChecked();
    await expect(window.getByText('Restart required.')).toHaveCount(0);

    // Cancel leaves everything as it was.
    await managed.click();
    const confirm = window.getByRole('dialog', { name: 'Switch to managed Postgres' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('copies your SQLite inbox and history');
    await expect(confirm).toContainText('Summaries and embeddings regenerate in the background after a switch.');
    await expect(confirm).toContainText('claude-fleet-postgres-data');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(sqlite).toBeChecked();
    expect(storeKey()).toBeUndefined();

    await managed.click();
    await window.getByRole('dialog', { name: 'Switch to managed Postgres' }).getByRole('button', { name: 'Switch at next start' }).click();
    await expect(managed).toBeChecked();
    await expect(window.getByText('Restart required.')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Restart now' })).toBeVisible();
    await expect.poll(storeKey).toEqual({ kind: 'postgres', managed: true });

    // Undoing a choice that hasn't applied only rewrites config.json.
    await sqlite.click();
    await window.getByRole('dialog', { name: 'Keep SQLite' }).getByRole('button', { name: 'Keep' }).click();
    await expect(sqlite).toBeChecked();
    await expect(window.getByText('Restart required.')).toHaveCount(0);
    await expect.poll(storeKey).toBeUndefined();
  } finally {
    await app.close();
  }
});

interface StubState {
  settings: Record<string, unknown>;
  setChoice: unknown[];
  relaunch: number;
  nextResults: Array<Record<string, unknown>>;
}

async function stubStoreIpc(app: ElectronApplication, settings: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ ipcMain }, settings) => {
    const g = globalThis as unknown as { __store: StubState };
    g.__store = { settings, setChoice: [], relaunch: 0, nextResults: [] };
    for (const ch of ['store:getSettings', 'store:setChoice', 'app:relaunch']) ipcMain.removeHandler(ch);
    ipcMain.handle('store:getSettings', () => g.__store.settings);
    ipcMain.handle('store:setChoice', (_e, choice: unknown) => {
      g.__store.setChoice.push(choice);
      const next = g.__store.nextResults.shift();
      if (next) g.__store.settings = { ...g.__store.settings, ...next };
      return g.__store.settings;
    });
    ipcMain.handle('app:relaunch', () => {
      g.__store.relaunch += 1;
    });
  }, settings);
}

const sendStatus = (app: ElectronApplication, status: Record<string, unknown>) =>
  app.evaluate(({ BrowserWindow }, s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('store:status', s);
  }, status);

const stubState = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __store: StubState }).__store);

test('Storage: store banner phases; switching back from a running Postgres store confirms, reports a refusal, then relaunches', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  const status = (p: Record<string, unknown>) => ({ choice: 'managed', phase: 'ready', detail: null, progress: null, notice: null, ...p });
  const conflict = 'inbox.db was not copied: it and the Postgres inbox both changed since they were last in step.';
  try {
    await stubStoreIpc(app, {
      configured: 'managed', active: 'managed', restartRequired: false, notice: null, status: status({ notice: conflict }),
    });

    const banner = window.locator('.store-banner');
    await sendStatus(app, status({ phase: 'starting' }));
    await expect(banner).toHaveText(/^Starting the Postgres store/);
    await sendStatus(app, status({ phase: 'importing', progress: { source: 'state', table: 'events', copied: 1500, total: 20000 } }));
    await expect(banner).toContainText('Copying your history to Postgres: events, 1,500 of 20,000 rows.');
    await sendStatus(app, status({ phase: 'down', detail: 'Docker is not running' }));
    await expect(banner).toContainText('Postgres store unreachable. History and inbox are unavailable: Docker is not running');
    await expect(window.locator('.app.has-banners')).toHaveCount(1);
    await sendStatus(app, status({ phase: 'ready', detail: 'History unavailable: db not opened' }));
    await expect(banner).toContainText('History unavailable: db not opened');
    await sendStatus(app, status({}));
    await expect(banner).toHaveCount(0);
    await expect(window.locator('.app.has-banners')).toHaveCount(0);

    await window.getByRole('button', { name: 'Settings' }).click();
    const sqlite = window.getByRole('radio', { name: /SQLite \(built in\)/ });
    const managed = window.getByRole('radio', { name: /Postgres, managed by claude-fleet/ });
    await expect(managed).toBeChecked();
    await expect(window.getByText(conflict)).toBeVisible();

    // A refused switch back: the notice is shown and Postgres stays chosen.
    const refused = 'Not switched; the app stays on Postgres: an automation is running.';
    await app.evaluate((_e, r) => {
      (globalThis as unknown as { __store: StubState }).__store.nextResults.push({ notice: r });
    }, refused);
    await sqlite.click();
    const confirm = window.getByRole('dialog', { name: 'Switch back to SQLite' });
    await expect(confirm).toContainText('copies the Postgres inbox');
    await expect(confirm).toContainText('relaunches on SQLite');
    await expect(confirm).toContainText('stays on Postgres');
    await confirm.getByRole('button', { name: 'Copy and relaunch' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(window.getByText(refused)).toBeVisible();
    await expect(managed).toBeChecked();

    await app.evaluate(() => {
      (globalThis as unknown as { __store: StubState }).__store.nextResults.push({ configured: 'sqlite', restartRequired: true, notice: null });
    });
    await sqlite.click();
    await window.getByRole('dialog', { name: 'Switch back to SQLite' }).getByRole('button', { name: 'Copy and relaunch' }).click();
    await expect(sqlite).toBeChecked();
    await expect(window.getByText('The app is relaunching on SQLite.')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Restart now' })).toHaveCount(0);
    expect((await stubState(app)).setChoice).toEqual(['sqlite', 'sqlite']);

    // A pending switch to Postgres offers Restart now.
    await window.getByRole('button', { name: 'Cancel', exact: true }).click();
    await app.evaluate(() => {
      const g = (globalThis as unknown as { __store: StubState }).__store;
      g.settings = { configured: 'managed', active: 'sqlite', restartRequired: true, notice: null,
        status: { choice: 'sqlite', phase: 'ready', detail: null, progress: null, notice: null } };
    });
    await window.getByRole('button', { name: 'Settings' }).click();
    await window.getByRole('button', { name: 'Restart now' }).click();
    await expect.poll(async () => (await stubState(app)).relaunch).toBe(1);
  } finally {
    await app.close();
  }
});
