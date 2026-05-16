import { ipcMain, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import * as dockerSvc from './docker.js';
import * as vault from './vault.js';
import type { PtyHandle } from './docker.js';

const ptySessions = new Map<string, PtyHandle>();

export function registerIpc(): void {
  ipcMain.handle('docker:ping', () => dockerSvc.ping());
  ipcMain.handle('docker:list', () => dockerSvc.listContainers());
  ipcMain.handle('docker:create', (_e, spec) => dockerSvc.createContainer(spec));
  ipcMain.handle('docker:stop', (_e, id: string) => dockerSvc.stopContainer(id));
  ipcMain.handle('docker:remove', (_e, id: string) => dockerSvc.removeContainer(id));

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
