import { ipcMain, BrowserWindow, dialog, clipboard, Menu } from 'electron';
import { randomUUID } from 'node:crypto';
import * as realDocker from './docker.js';
import * as mockDocker from './mock.js';
import * as vault from './vault.js';
import * as fs from './fs.js';
import * as imageLibrary from './imageLibrary.js';
import {
  listWorkspaceManifests,
  readWorkspaceManifest,
  touchWorkspaceUsed,
  writeWorkspaceManifest,
  type Workspace,
  type WorkspaceSpec
} from './workspaces.js';
import type { PtyHandle, RemoveWorkspaceOpts, CreateWorkspaceInput } from './docker.js';

export const MOCK_MODE = process.env.CLAUDE_FLEET_MOCK === '1';
const backend = MOCK_MODE ? mockDocker : realDocker;

const ptySessions = new Map<string, PtyHandle>();

/**
 * Merge the live-workspace list (from the backend) with on-disk manifests
 * (from workspaces.ts) into a single Workspace[]. Live entries take
 * precedence for state/status; manifests provide workspaceRoot/lastUsedAt
 * for workspaces whose container has been removed.
 */
async function listAllWorkspaces(): Promise<Workspace[]> {
  const [live, manifests] = await Promise.all([
    backend.listLiveWorkspaces(),
    listWorkspaceManifests()
  ]);
  const manifestByName = new Map(manifests.map((m) => [m.name, m]));
  const result: Workspace[] = [];

  for (const w of live) {
    const m = manifestByName.get(w.name);
    result.push({
      ...w,
      workspaceRoot: w.workspaceRoot || m?.workspaceRoot || '',
      workspaceSubdir: w.workspaceSubdir || m?.workspaceSubdir || '',
      profile: w.profile || m?.profile || '',
      createdAt: m?.createdAt ?? w.createdAt,
      lastUsedAt: m?.lastUsedAt ?? w.lastUsedAt
    });
    manifestByName.delete(w.name);
  }

  // Manifests with no live container → deleted (recoverable from spec)
  for (const m of manifestByName.values()) {
    result.push({ ...m, state: 'deleted' });
  }

  return result;
}

export function registerIpc(): void {
  ipcMain.handle('workspace:ping', () => backend.ping());
  ipcMain.handle('workspace:ensureImage', async (event, channelId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    await backend.ensureImage((p) => {
      win?.webContents.send(`workspace:ensureImage:progress:${channelId}`, p);
    });
  });

  ipcMain.handle('workspace:list', () => listAllWorkspaces());

  ipcMain.handle(
    'workspace:create',
    async (_e, input: CreateWorkspaceInput & { kind?: 'container' | 'local' }) => {
      if (input.kind === 'local') {
        throw new Error(
          "Local workspaces aren't implemented yet. Pick 'Container' for now."
        );
      }
      const ws = await backend.createWorkspace(input);
      const spec: WorkspaceSpec = {
        name: ws.name,
        workspaceRoot: ws.workspaceRoot,
        workspaceSubdir: ws.workspaceSubdir,
        profile: ws.profile,
        kind: 'container',
        image: ws.image,
        createdAt: ws.createdAt,
        lastUsedAt: ws.lastUsedAt
      };
      await writeWorkspaceManifest(spec);

      // Auto-record the image into the library so the next create's
      // picker shows it (and any labels it was built with). Best-effort:
      // a failed inspect (image just pulled but inspect bombs) shouldn't
      // fail the workspace create.
      if (ws.image) {
        try {
          const inspected = await backend.inspectImage(ws.image);
          await imageLibrary.recordImage(inspected);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('imageLibrary.recordImage failed:', err);
        }
      }

      return ws;
    }
  );

  ipcMain.handle('images:list', () => imageLibrary.listImages());
  ipcMain.handle('images:remove', (_e, ref: string) => imageLibrary.removeImage(ref));

  /**
   * Start an existing (live, possibly stopped) workspace by name. Returns
   * the workspace if a container with that name exists; null otherwise,
   * signalling the renderer to recreate from the saved manifest using the
   * normal create flow (which resolves vault credentials).
   */
  ipcMain.handle('workspace:start', async (_e, name: string): Promise<Workspace | null> => {
    const id = await backend.startWorkspace(name);
    if (!id) return null;
    await touchWorkspaceUsed(name);
    // Find the freshly-running workspace in the merged list so the
    // renderer gets the up-to-date state/status fields.
    const all = await listAllWorkspaces();
    return all.find((w) => w.name === name) ?? null;
  });

  ipcMain.handle('workspace:getManifest', async (_e, name: string) => {
    return readWorkspaceManifest(name);
  });

  ipcMain.handle('workspace:stop', (_e, id: string) => backend.stopWorkspace(id));
  ipcMain.handle(
    'workspace:remove',
    (_e, id: string, opts?: RemoveWorkspaceOpts) => backend.removeWorkspace(id, opts)
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
      const handle = await backend.attachPty(containerId, cols, rows);
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
