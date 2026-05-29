import { ipcMain, BrowserWindow, dialog, clipboard, Menu } from 'electron';
import { randomUUID } from 'node:crypto';
import * as realDocker from './docker.js';
import * as mockDocker from './mock.js';
import * as vault from './vault.js';
import * as fs from './fs.js';
import * as imageLibrary from './imageLibrary.js';
import * as sessions from './sessions.js';
import {
  listWorkspaceManifests,
  readWorkspaceManifest,
  touchWorkspaceUsed,
  writeWorkspaceManifest,
  type Workspace,
  type WorkspaceSpec
} from './workspaces.js';
import type { PtyHandle, RemoveWorkspaceOpts, CreateWorkspaceInput } from './docker.js';
import type { JsonlWatcher } from './jsonlWatcher.js';
import {
  eventsForSession,
  summaryForWorkspace,
  costForSession,
  costForWorkspace,
} from './db.js';
import { logError, getLogPath } from './errorLog.js';
import { broadcastObservabilitySummary } from './observabilityBroadcast.js';

export const MOCK_MODE = process.env.CLAUDE_FLEET_MOCK === '1';
const backend = MOCK_MODE ? mockDocker : realDocker;

const ptySessions = new Map<string, PtyHandle>();

interface RegisterIpcOpts {
  jsonlWatcher: JsonlWatcher | null;
}

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

export function registerIpc(opts: RegisterIpcOpts = { jsonlWatcher: null }): void {
  const { jsonlWatcher } = opts;

  // Live summary push: when the watcher ingests new lines, compute the
  // workspace summary once and broadcast to every BrowserWindow. The renderer
  // subscribes via `observability.onSummary` (see preload) and updates the
  // shared summaries map without polling. A 30s safety poll in App.tsx
  // refreshes relative-time displays and covers any missed event. See
  // `observabilityBroadcast.ts` for why per-target sends are guarded.
  if (jsonlWatcher) {
    jsonlWatcher.on('ingest', ({ workspaceName }) => {
      const summary = summaryForWorkspace(workspaceName);
      broadcastObservabilitySummary(
        { workspaceName, summary },
        BrowserWindow.getAllWindows()
      );
    });
  }

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
      jsonlWatcher?.registerWorkspace(ws.name);

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

  ipcMain.handle('sessions:read', (_e, workspaceName: string) =>
    sessions.readInventory(workspaceName)
  );
  ipcMain.handle(
    'sessions:write',
    (_e, workspaceName: string, inventory: sessions.SessionInventory) =>
      sessions.writeInventory(workspaceName, inventory)
  );

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
  ipcMain.handle('workspace:pause', (_e, id: string) => backend.pauseWorkspace(id));
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
    async (event, containerId: string, brokerSessionId: string, cols: number, rows: number) => {
      // Internal handle id, used by the renderer to address subsequent
      // input/resize/detach calls. Distinct from brokerSessionId (which
      // is the workspace-persistent id the broker keys its session map
      // by). The renderer doesn't need to learn the broker id.
      const ptyHandleId = randomUUID();
      let handle: PtyHandle;
      try {
        handle = await backend.attachPty(containerId, brokerSessionId, cols, rows);
      } catch (err) {
        // Capture the broker's recent stdout/stderr so the user has
        // something to diagnose with. The classic symptom we're chasing
        // is "broker: ATTACHED timed out" after a pause/resume — the
        // broker is alive but slow to dispatch the response. Without
        // these logs we have no visibility into what the broker is
        // doing on the other side of the socket. Best-effort: if the
        // logs call itself fails (container gone, dockerode flaked),
        // getBrokerLogs returns '' and we just rethrow the original.
        const brokerLog = await backend.getBrokerLogs(containerId, 100);
        logError({
          source: 'main',
          type: 'pty-attach-failed',
          message: `pty:attach failed: ${(err as Error).message}`,
          stack: err instanceof Error ? err.stack : undefined,
          extra: {
            brokerSessionId,
            containerId,
            cols,
            rows,
            brokerLog: brokerLog || '(no broker logs available)',
          },
        });
        throw err;
      }
      ptySessions.set(ptyHandleId, handle);
      // Diagnostic: ptySessions.size should oscillate around the count of
      // currently-mounted TerminalSession components. Unbounded growth =
      // detach isn't running (renderer cleanup race) or isn't reaching
      // here (channel mismatch). Surfaced via error.log so we can
      // correlate against attach failures across long sessions.
      logError({
        source: 'main',
        type: 'pty-attach',
        message: `pty:attach OK (live=${ptySessions.size})`,
        // cols/rows are the dimensions the broker spawned the PTY at.
        // If they're the xterm default (80x24) when the host element is
        // actually larger, claude will lay out at the wrong size and
        // subsequent resize will scramble its scrollback. Captured here
        // so we can regression-test that attach happens after fit.
        extra: {
          brokerSessionId,
          containerId,
          ptyHandleId,
          cols,
          rows,
          live: ptySessions.size
        }
      });

      const win = BrowserWindow.fromWebContents(event.sender);
      handle.stream.on('data', (chunk: Buffer) => {
        win?.webContents.send(`pty:data:${ptyHandleId}`, chunk);
      });
      handle.stream.on('end', () => {
        win?.webContents.send(`pty:end:${ptyHandleId}`);
        ptySessions.delete(ptyHandleId);
        logError({
          source: 'main',
          type: 'pty-stream-end',
          message: `pty stream ended (live=${ptySessions.size})`,
          extra: { brokerSessionId, ptyHandleId, live: ptySessions.size }
        });
      });
      handle.stream.on('error', (err) => {
        win?.webContents.send(`pty:error:${ptyHandleId}`, String(err));
        logError({
          source: 'main',
          type: 'pty-stream-error',
          message: String(err),
          stack: err instanceof Error ? err.stack : undefined,
          extra: { brokerSessionId, ptyHandleId }
        });
      });
      return ptyHandleId;
    }
  );

  ipcMain.handle('pty:input', (_e, sessionId: string, data: string) => {
    ptySessions.get(sessionId)?.stream.write(data);
  });

  ipcMain.handle('pty:resize', async (_e, sessionId: string, cols: number, rows: number) => {
    await ptySessions.get(sessionId)?.resize(cols, rows);
  });

  ipcMain.handle('pty:detach', (_e, sessionId: string) => {
    const present = ptySessions.has(sessionId);
    ptySessions.get(sessionId)?.detach();
    ptySessions.delete(sessionId);
    logError({
      source: 'main',
      type: 'pty-detach',
      message: present
        ? `pty:detach OK (live=${ptySessions.size})`
        : `pty:detach for unknown handle (live=${ptySessions.size})`,
      extra: { ptyHandleId: sessionId, hadHandle: present, live: ptySessions.size }
    });
  });

  // Observability — minimal step-1 surface. Renderer polls
  // eventsForSession with the latest id it has; the DB returns rows
  // ingested since. Live push + cost rollup + per-workspace queries
  // ship with steps 2-3 of #2.
  ipcMain.handle(
    'observability:eventsForSession',
    (_e, sessionId: string, sinceEventId = 0, limit = 500) =>
      eventsForSession(sessionId, sinceEventId, limit)
  );

  /**
   * Pragmatic v1: picks the most-recently-active Claude session in the
   * workspace. Precise per-tab mapping (broker session ↔ claude session
   * UUID) is a deferred follow-up; in practice the latest-active heuristic
   * matches the focused tab nearly always.
   */
  ipcMain.handle('observability:summaryForWorkspace', (_e, workspaceName: string) =>
    summaryForWorkspace(workspaceName)
  );

  // Cost rollups (#32). USD is derived from `events` via pricing.ts and is
  // pure SQL + arithmetic on this side — no caching layer yet. The pane
  // already polls summaryForWorkspace every 2s and now reads the included
  // `usd`; these per-session / per-workspace endpoints exist for the
  // sessions table (#3) and future detail views.
  ipcMain.handle('observability:getCost', (_e, sessionId: string) =>
    costForSession(sessionId)
  );
  ipcMain.handle('observability:getCostForWorkspace', (_e, workspaceName: string) =>
    costForWorkspace(workspaceName)
  );

  // Renderer-side error reporting bridge. The renderer's onerror /
  // onunhandledrejection handlers forward into here so all crashes
  // (main + renderer) land in a single `<userData>/error.log` users
  // can cat for diagnostic info.
  ipcMain.handle(
    'app:logError',
    (
      _e,
      payload: { type: string; message: string; stack?: string; extra?: Record<string, unknown> }
    ) => {
      logError({ source: 'renderer', ...payload });
    }
  );
  ipcMain.handle('app:errorLogPath', () => getLogPath());
}
