// Desktop presence (#407 Phase 2b): the tray icon + menu, the Windows taskbar
// overlay, the macOS/Linux badge, attention on new urgent items, and the
// keep-running-in-tray window behaviour. The rules are in presenceCore.ts.
import { app, BrowserWindow, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { join } from 'node:path';
import type { InboxStore } from './inboxDb.js';
import type { NotifyService } from './notifyService.js';
import { NotifyStore } from './notifyStore.js';
import { inboxEvents } from './inboxEvents.js';
import { dockBadge, needsYou, overlayAsset, overlayDescription, tooltip, trayAsset } from './presenceCore.js';
import { getKeepRunningInTray } from '../config.js';
import { logError } from '../errorLog.js';

const PRODUCT = 'claude-fleet';

export function presenceDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'presence') : join(app.getAppPath(), 'resources', 'presence');
}

const cache = new Map<string, NativeImage>();
function image(name: string): NativeImage {
  const hit = cache.get(name);
  if (hit) return hit;
  const img = nativeImage.createFromPath(join(presenceDir(), `${name}.png`));
  cache.set(name, img);
  return img;
}

/** 16px tray image with its 32px @2x representation. */
function trayImage(name16: string, name32: string): NativeImage {
  const img = nativeImage.createEmpty();
  const a = image(name16), b = image(name32);
  if (!a.isEmpty()) img.addRepresentation({ scaleFactor: 1, buffer: a.toPNG() });
  if (!b.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: b.toPNG() });
  return img;
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

function showWindow(): BrowserWindow | null {
  const w = mainWindow();
  if (!w) return null;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  return w;
}

let quitting = false;
export function markQuitting(): void {
  quitting = true;
}

/** Hide instead of close when keep-running-in-tray is on (and a tray exists). */
export function attachKeepRunning(win: BrowserWindow, hasTray: () => boolean): void {
  let keep = false;
  const refresh = () => void getKeepRunningInTray().then((v) => { keep = v; }).catch(() => {});
  refresh();
  inboxEvents.on('settings', refresh);
  win.on('close', (e) => {
    if (keep && !quitting && hasTray()) {
      e.preventDefault();
      win.hide();
    }
  });
}

export function startPresence(inbox: InboxStore, notify: NotifyService, approvals: () => number = () => 0): { hasTray: () => boolean; stop: () => void } {
  const notifyStore = new NotifyStore(inbox.db);
  let tray: Tray | null = null;
  try {
    tray = new Tray(trayImage('tray-none-16', 'tray-none-32'));
    tray.setToolTip(PRODUCT);
    tray.on('click', () => { showWindow(); });
  } catch (e) {
    logError({ source: 'main', type: 'tray-create-failed', level: 'warn', message: String(e) });
    tray = null;
  }
  let lastKey = '';

  const sendOpenInbox = () => {
    const w = showWindow();
    w?.webContents.send('presence:openInbox');
  };

  const update = () => {
    try {
      const counts = inbox.counts();
      const n = needsYou(counts.urgent, notify.waitingWorkspaces().length, approvals());
      const q = notify.quietState();
      const quietText = q.pause ? (q.pause.until === null ? 'notifications paused' : `paused until ${new Date(q.pause.until).toTimeString().slice(0, 5)}`) : q.activeDowntime ? `${q.activeDowntime.name} downtime` : null;
      const key = JSON.stringify([n, counts, quietText]);
      if (key === lastKey) return;
      lastKey = key;
      const win = mainWindow();
      if (process.platform === 'win32' && win && !win.isDestroyed()) {
        const asset = overlayAsset(n);
        win.setOverlayIcon(asset ? image(asset) : null, overlayDescription(n));
      }
      if (process.platform === 'darwin' || process.platform === 'linux') {
        app.setBadgeCount(n.count);
        if (process.platform === 'darwin') app.dock?.setBadge(dockBadge(n));
      }
      if (tray) {
        tray.setImage(trayImage(trayAsset(n, 16), trayAsset(n, 32)));
        tray.setToolTip(tooltip(PRODUCT, n, counts, quietText));
        const paused = !!q.pause;
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: tooltip(PRODUCT, n, counts, quietText), enabled: false },
          { type: 'separator' },
          { label: 'Open Inbox', click: sendOpenInbox },
          { label: `Open ${PRODUCT}`, click: () => { showWindow(); } },
          { type: 'separator' },
          ...(paused
            ? [{ label: 'Resume notifications', click: () => { notifyStore.clearPause(); notify.tick(); emit(); } }]
            : [
                { label: 'Pause notifications for 1 hour', click: () => { notifyStore.setPause({ until: Date.now() + 3_600_000, letUrgent: true, setAt: Date.now() }); notify.tick(); emit(); } },
                { label: 'Pause until tomorrow 08:00', click: () => {
                  const d = new Date();
                  const until = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8, 0).getTime();
                  notifyStore.setPause({ until, letUrgent: true, setAt: Date.now() });
                  notify.tick();
                  emit();
                } }
              ]),
          { type: 'separator' },
          { label: `Quit ${PRODUCT}`, click: () => { markQuitting(); app.quit(); } }
        ]));
      }
    } catch (e) {
      logError({ source: 'main', type: 'presence-update', level: 'warn', message: String(e) });
    }
  };
  // Tray pause/resume go through the store directly, so tell the renderers too.
  const emit = () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('notifications:changed', notify.quietState());
    }
    update();
  };

  const attention = () => {
    const w = mainWindow();
    if (!w || w.isDestroyed() || w.isFocused()) return;
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else {
      w.flashFrame(true);
      w.once('focus', () => w.flashFrame(false));
    }
  };

  inboxEvents.on('changed', update);
  inboxEvents.on('attention', attention);
  const timer = setInterval(update, 60_000); // pauses/downtimes expire on their own
  timer.unref?.();
  update();

  return {
    hasTray: () => tray !== null,
    stop: () => {
      clearInterval(timer);
      inboxEvents.off('changed', update);
      inboxEvents.off('attention', attention);
      tray?.destroy();
      tray = null;
    }
  };
}

/** `presence:*` IPC: the keep-running-in-tray setting. */
export function registerPresenceIpc(ipcMain: Electron.IpcMain, cfg: { get: () => Promise<boolean>; set: (v: boolean) => Promise<void> }): void {
  ipcMain.handle('presence:getKeepRunning', () => cfg.get());
  ipcMain.handle('presence:setKeepRunning', async (_e, v: boolean) => {
    await cfg.set(v === true);
    inboxEvents.emit('settings');
  });
}
