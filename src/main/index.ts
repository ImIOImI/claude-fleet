import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc.js';
import { openDb, closeDb } from './db.js';
import { JsonlWatcher } from './jsonlWatcher.js';
import { listWorkspaceManifests } from './workspaces.js';
import { installMainProcessHandlers, logError, getLogPath } from './errorLog.js';

// Mock mode is for UI iteration without Docker; no real JSONLs exist, so the
// watcher and DB stay dormant.
const isMock = process.env.CLAUDE_FLEET_MOCK === '1';
const jsonlWatcher = isMock ? null : new JsonlWatcher();

const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_RENDERER_URL;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    title: 'claude-fleet',
    backgroundColor: '#101216',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.on('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

app.whenReady().then(async () => {
  // First thing after whenReady: register error logging. From here on,
  // any thrown error or rejected promise on main lands in error.log
  // before potentially propagating into a crash.
  installMainProcessHandlers();
  // Surface the log location so users (and Playwright tests) can find it.
  console.log(`[claude-fleet] error log: ${getLogPath()}`);

  if (jsonlWatcher) {
    openDb(app.getPath('userData'));
    const manifests = await listWorkspaceManifests();
    await jsonlWatcher.start(manifests.map((m) => m.name));
  }
  registerIpc({ jsonlWatcher });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', async () => {
  await jsonlWatcher?.stop();
  closeDb();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
