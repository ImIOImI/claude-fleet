// Settings → Storage and the store banner (SPEC §6 *Store*).
import { app, ipcMain, type BrowserWindow } from 'electron';
import { getStoreConfig, setStoreChoice } from '../config.js';
import type { StoreChoice, StoreSettings, StoreStatus } from '../../preload/storeTypes.js';
import type { StoreConfig } from './storeConfig.js';
import { applyStoreChoice, type SwitchResult } from './storeSwitch.js';

export function storeChoiceOf(cfg: StoreConfig): StoreChoice {
  return cfg.kind === 'sqlite' ? 'sqlite' : cfg.kind === 'managed' ? 'managed' : 'external';
}

const SQLITE_READY = (choice: StoreChoice): StoreStatus => ({ choice, phase: 'ready', detail: null, progress: null, notice: null });

let active: StoreChoice = 'sqlite';
let statusOf: () => StoreStatus = () => SQLITE_READY(active);
let switchBack: (() => Promise<SwitchResult>) | null = null;
let notice: string | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** What this run opened, its live status (Postgres: the supervisor's), and
 *  (managed) how to leave it for SQLite with the inbox carried back. */
export function setActiveStore(
  choice: StoreChoice,
  status?: () => StoreStatus,
  onSwitchBack?: () => Promise<SwitchResult>,
): void {
  active = choice;
  statusOf = status ?? (() => SQLITE_READY(choice));
  switchBack = onSwitchBack ?? null;
}

async function settings(): Promise<StoreSettings> {
  const configured = storeChoiceOf(await getStoreConfig());
  return { configured, active, restartRequired: configured !== active, status: statusOf(), notice };
}

async function setChoice(choice: 'sqlite' | 'managed'): Promise<StoreSettings> {
  notice = await applyStoreChoice(choice, {
    configured: storeChoiceOf(await getStoreConfig()),
    active,
    write: setStoreChoice,
    switchBack,
  });
  return settings();
}

export function registerStoreIpc(): void {
  ipcMain.handle('store:getSettings', () => settings());
  ipcMain.handle('store:setChoice', (_e, choice: unknown) => {
    if (choice !== 'sqlite' && choice !== 'managed') throw new Error('store choice must be "sqlite" or "managed"');
    // One change at a time: a second click must not start a second switch back.
    const run = queue.then(() => setChoice(choice));
    queue = run.catch(() => undefined);
    return run;
  });
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });
}

export function broadcastStoreStatus(s: StoreStatus, windows: readonly BrowserWindow[]): void {
  for (const w of windows) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try {
      w.webContents.send('store:status', s);
    } catch {
      // a window mid-teardown can throw
    }
  }
}
