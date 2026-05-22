import { ipcMain, BrowserWindow, dialog, clipboard, Menu } from 'electron';
import { randomUUID } from 'node:crypto';
import * as realDocker from './docker.js';
import * as mockDocker from './mock.js';
import * as vault from './vault.js';
import * as fs from './fs.js';
import type { PtyHandle, RemoveContainerOpts } from './docker.js';

export const MOCK_MODE = process.env.CLAUDE_FLEET_MOCK === '1';
const dockerSvc = MOCK_MODE ? mockDocker : realDocker;

const ptySessions = new Map<string, PtyHandle>();

export function registerIpc(): void {
  ipcMain.handle('docker:ping', () => dockerSvc.ping());
  ipcMain.handle('docker:ensureImage', async (event, channelId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    await dockerSvc.ensureImage((p) => {
      win?.webContents.send(`docker:ensureImage:progress:${channelId}`, p);
    });
  });
  ipcMain.handle('docker:list', () => dockerSvc.listContainers());
  ipcMain.handle('docker:create', (_e, spec) => dockerSvc.createContainer(spec));
  ipcMain.handle('docker:stop', (_e, id: string) => dockerSvc.stopContainer(id));
  ipcMain.handle(
    'docker:remove',
    (_e, id: string, opts?: RemoveContainerOpts) =>
      dockerSvc.removeContainer(id, opts)
  );

  ipcMain.handle('app:mockMode', () => MOCK_MODE);

  ipcMain.handle('fs:isDirectory', (_e, path: string) => fs.isDirectory(path));
  ipcMain.handle('fs:mkdirp', (_e, path: string) => fs.mkdirp(path));

  ipcMain.handle('dialog:pickDirectory', async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      defaultPath,
      title: 'Select workspace root'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('clipboard:write', (_e, text: string) => {
    if (typeof text === 'string' && text.length > 0) clipboard.writeText(text);
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());

  ipcMain.handle(
    'menu:showTerminalContextMenu',
    async (event, opts: { hasSelection: boolean }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      return new Promise<'copy' | 'paste' | 'selectAll' | null>((resolve) => {
        let resolved = false;
        const settle = (choice: 'copy' | 'paste' | 'selectAll' | null) => {
          if (resolved) return;
          resolved = true;
          resolve(choice);
        };
        const menu = Menu.buildFromTemplate([
          { label: 'Copy', enabled: opts.hasSelection, click: () => settle('copy') },
          { label: 'Paste', click: () => settle('paste') },
          { type: 'separator' },
          { label: 'Select All', click: () => settle('selectAll') }
        ]);
        menu.popup({ window: win, callback: () => settle(null) });
      });
    }
  );

  ipcMain.handle('vault:available', () => vault.isVaultAvailable());
  ipcMain.handle('vault:list', () => vault.listProfileNames());
  ipcMain.handle('vault:get', (_e, name: string) => vault.getProfile(name));
  ipcMain.handle('vault:set', (_e, p: vault.Profile) => vault.setProfile(p));
  ipcMain.handle('vault:delete', (_e, name: string) => vault.deleteProfile(name));

  ipcMain.handle(
    'pty:attach',
    async (event, containerId: string, cols: number, rows: number) => {
      const sessionId = randomUUID();
      const handle = await dockerSvc.attachPty(containerId, cols, rows);
      ptySessions.set(sessionId, handle);

      const win = BrowserWindow.fromWebContents(event.sender);
      handle.stream.on('data', (chunk: Buffer) => {
        win?.webContents.send(`pty:data:${sessionId}`, chunk);
      });
      handle.stream.on('end', () => {
        win?.webContents.send(`pty:end:${sessionId}`);
        ptySessions.delete(sessionId);
      });
      handle.stream.on('error', (err) => {
        win?.webContents.send(`pty:error:${sessionId}`, String(err));
      });
      return sessionId;
    }
  );

  ipcMain.handle('pty:input', (_e, sessionId: string, data: string) => {
    ptySessions.get(sessionId)?.stream.write(data);
  });

  ipcMain.handle('pty:resize', async (_e, sessionId: string, cols: number, rows: number) => {
    await ptySessions.get(sessionId)?.resize(cols, rows);
  });

  ipcMain.handle('pty:detach', (_e, sessionId: string) => {
    ptySessions.get(sessionId)?.detach();
    ptySessions.delete(sessionId);
  });
}
