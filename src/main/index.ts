import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc.js';
import { openDb, closeDb, recordError } from './db.js';
import { startMcpServer, stopMcpServer, ensureWorkspaceSocket, setMcpStatusListener } from './mcpServer.js';
import { broadcastMcpStatus } from './mcpStatusBroadcast.js';
import { ensureBuiltinLoadouts } from './loadouts.js';
import { JsonlWatcher } from './jsonlWatcher.js';
import { listWorkspaceManifests } from './workspaces.js';
import { installMainProcessHandlers, getLogPath, setErrorSink } from './errorLog.js';
import { runStartupMigration } from './migration.js';
import { hardwareAccelDisabledAtStartup } from './config.js';
import { setWorkspaceDefault } from './mirrorPolicy.js';

// Mock mode is for UI iteration without Docker; no real JSONLs exist, so the
// watcher and DB stay dormant.
const isMock = process.env.CLAUDE_FLEET_MOCK === '1';
const jsonlWatcher = isMock ? null : new JsonlWatcher();

const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_RENDERER_URL;

// The most recently created window, so a second-instance launch can focus it
// instead of starting a rival process (see the single-instance lock below).
let mainWindow: BrowserWindow | null = null;

// Single-instance lock (#159). Two claude-fleet processes can't coexist: the
// second one loses the race to bind the host MCP listener (127.0.0.1:7071) with
// EADDRINUSE, and every container's claude-fleet-state MCP then silently shows
// "Failed to connect" against whichever instance didn't get the port. So a
// second launch must not start the app at all — it hands off to the running
// instance (which focuses its window via 'second-instance' below) and exits.
// requestSingleInstanceLock() must be called before app is ready; if we didn't
// get the lock, quit now and skip all startup.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// On WSLg (and some headless/virtualized Linux setups) Chromium's GPU process
// fails to initialize ("Exiting GPU process due to errors during
// initialization") — harmless (rendering falls back to CPU) but it spams the
// dev terminal every session and buries real errors. Controlled by the
// Settings panel toggle (persisted in config.json) or the CLAUDE_FLEET_DISABLE_HWA
// env override. Must run before the `ready` event, hence the sync read.
if (hardwareAccelDisabledAtStartup()) {
  app.disableHardwareAcceleration();
}

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

// A second launch lands here in the already-running primary instead of starting
// a rival process: restore + focus the existing window (#159).
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Only the primary instance boots the app; a duplicate already called app.quit()
// above and must not register the startup path (which would bind the listeners
// it can't acquire).
if (gotSingleInstanceLock) app.whenReady().then(async () => {
  // First thing after whenReady: register error logging. From here on,
  // any thrown error or rejected promise on main lands in error.log
  // before potentially propagating into a crash.
  installMainProcessHandlers();
  // Surface the log location so users (and Playwright tests) can find it.
  console.log(`[claude-fleet] error log: ${getLogPath()}`);

  // Clean-slate migration to the ULID-keyed workspace model. Runs every
  // boot but no-ops once everything's already on the new shape.
  await runStartupMigration();

  // Seed the built-in loadout starters if the library doesn't exist yet
  // (#16-followup). Idempotent; non-fatal — a seeding hiccup must not block launch.
  await ensureBuiltinLoadouts().catch((e) => console.warn('[loadouts] seed failed:', e));

  if (jsonlWatcher) {
    openDb(app.getPath('userData'));
    // Wire the crash-safe DB sink so every logError call is also persisted to
    // the errors table (best-effort; a wedged DB must never break crash logging).
    setErrorSink((row) => recordError(row));
    // Read-only MCP server over <userData>/mcp.sock so in-container claude can
    // query the state DB (sessions/events/cost). Opens its own readonly conn.
    startMcpServer(app.getPath('userData'));
    // Surface host MCP listener health to renderers as the "MCP unreachable"
    // sticky toast (#159 follow-up): fan the change-only status out to every
    // window. Wired before the listener can fail so the first event is caught.
    setMcpStatusListener((s) => broadcastMcpStatus(s, BrowserWindow.getAllWindows()));
    const manifests = await listWorkspaceManifests();
    // Re-establish a per-workspace MCP listener for every known workspace (#117)
    // so a paused container that survived the restart finds its socket again
    // (its bind points at <userData>/mcp/<id>/, whose listener must be rebuilt).
    for (const m of manifests) ensureWorkspaceSocket(m.id);
    // Seed each workspace's durable-mirror default from its manifest before the
    // watcher starts ingesting, so the very first lines are mirrored per the
    // saved setting — not dependent on the renderer's later workspace:list poll.
    for (const m of manifests) setWorkspaceDefault(m.id, m.mirror.default);
    await jsonlWatcher.start(manifests.map((m) => m.id));
  }
  registerIpc({ jsonlWatcher });
  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('before-quit', async () => {
  await jsonlWatcher?.stop();
  stopMcpServer();
  closeDb();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
