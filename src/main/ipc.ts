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
  findWorkspaceByName,
  type Workspace,
  type WorkspaceSpec,
  type WorkspaceEnv,
  type WorkspaceResources,
  type WorkspaceColor,
  type AuthMode
} from './workspaces.js';
import type { PtyHandle, RemoveWorkspaceOpts } from './docker.js';
import type { JsonlWatcher } from './jsonlWatcher.js';
import {
  eventsForSession,
  summaryForWorkspace,
  summaryForBrokerSession,
  costForSession,
  costForWorkspace,
  learnBrokerSessionMapping,
  lookupBrokerSession,
} from './db.js';
import { logError, getLogPath } from './errorLog.js';
import { broadcastObservabilitySummary } from './observabilityBroadcast.js';
import { consumeForWorkspace, recordPendingAttach } from './pendingAttaches.js';

export const MOCK_MODE = process.env.CLAUDE_FLEET_MOCK === '1';
const backend = MOCK_MODE ? mockDocker : realDocker;

const ptySessions = new Map<string, PtyHandle>();

interface RegisterIpcOpts {
  jsonlWatcher: JsonlWatcher | null;
}

/**
 * Payload accepted by `workspace:create`. The renderer ships the
 * pre-allocated ULID along with every field that lands in the manifest;
 * the main process forwards container-level fields to the backend and
 * persists the full spec to disk.
 */
interface WorkspaceCreatePayload {
  id: string;
  name: string;
  description?: string;
  labels?: string[];
  color?: WorkspaceColor;
  workspaceRoot: string;
  workspaceSubdir: string;
  kind?: 'container' | 'local';
  image?: string;
  authMode: AuthMode;
  env: WorkspaceEnv;
  resources?: WorkspaceResources;
}

/**
 * Merge the live-workspace list (from the backend) with on-disk manifests
 * (from workspaces.ts) into a single Workspace[]. Live entries take
 * precedence for state/status; manifests provide the user-facing fields
 * (description/labels/color/env/etc.) that don't live on the container.
 */
async function listAllWorkspaces(): Promise<Workspace[]> {
  const [live, manifests] = await Promise.all([
    backend.listLiveWorkspaces(),
    listWorkspaceManifests()
  ]);
  const manifestById = new Map(manifests.map((m) => [m.id, m]));
  const result: Workspace[] = [];

  for (const w of live) {
    const m = manifestById.get(w.id);
    result.push({
      ...w,
      // Manifest is authoritative for user-facing fields; container labels
      // only carry id/name/subdir/workspaceRoot.
      name: m?.name ?? w.name,
      description: m?.description,
      labels: m?.labels ?? w.labels,
      color: m?.color,
      workspaceRoot: w.workspaceRoot || m?.workspaceRoot || '',
      workspaceSubdir: w.workspaceSubdir || m?.workspaceSubdir || '',
      authMode: m?.authMode ?? w.authMode,
      env: m?.env ?? w.env,
      resources: m?.resources,
      createdAt: m?.createdAt ?? w.createdAt,
      lastUsedAt: m?.lastUsedAt ?? w.lastUsedAt
    });
    manifestById.delete(w.id);
  }

  // Manifests with no live container → deleted (recoverable from spec)
  for (const m of manifestById.values()) {
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
    jsonlWatcher.on('ingest', ({ workspaceId }) => {
      const summary = summaryForWorkspace(workspaceId);
      broadcastObservabilitySummary(
        { workspaceId, summary },
        BrowserWindow.getAllWindows()
      );
    });
    // Per-tab mapping: when a brand-new claude JSONL appears in a
    // workspace, ask the pending-attach map if there's exactly one
    // recent unmapped attach for that workspace. If so, persist the
    // broker→claude pairing. Conservative single-match rule documented
    // in pendingAttaches.ts; concurrent attaches fall back to the
    // workspace summary (v1 behavior) until the user re-mounts a tab
    // alone and we can disambiguate.
    jsonlWatcher.on('new-session', ({ workspaceId, sessionId: claudeSessionId }) => {
      const brokerSessionId = consumeForWorkspace(workspaceId);
      if (!brokerSessionId) return;
      learnBrokerSessionMapping(workspaceId, brokerSessionId, claudeSessionId);
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
    async (_e, input: WorkspaceCreatePayload) => {
      if (input.kind === 'local') {
        throw new Error(
          "Local workspaces aren't implemented yet. Pick 'Container' for now."
        );
      }
      // Name-uniqueness is checked here (and not in the renderer alone) so
      // a stale list doesn't allow duplicates through.
      const existing = await findWorkspaceByName(input.name);
      if (existing && existing.id !== input.id) {
        throw new Error(`A workspace named "${input.name}" already exists.`);
      }

      const ws = await backend.createWorkspace({
        id: input.id,
        name: input.name,
        workspaceRoot: input.workspaceRoot,
        workspaceSubdir: input.workspaceSubdir,
        env: input.env,
        image: input.image,
        resources: input.resources
      });

      const spec: WorkspaceSpec = {
        id: input.id,
        name: input.name,
        description: input.description,
        labels: input.labels ?? [],
        color: input.color,
        workspaceRoot: input.workspaceRoot,
        workspaceSubdir: input.workspaceSubdir,
        kind: 'container',
        image: ws.image,
        authMode: input.authMode,
        env: input.env,
        resources: input.resources,
        createdAt: ws.createdAt,
        lastUsedAt: ws.lastUsedAt
      };
      await writeWorkspaceManifest(spec);
      jsonlWatcher?.registerWorkspace(input.id);

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

      // Merge manifest fields back onto the backend's Workspace so the
      // renderer sees its color/labels/description immediately.
      return { ...ws, ...spec, state: ws.state, containerId: ws.containerId, status: ws.status };
    }
  );

  ipcMain.handle('images:list', () => imageLibrary.listImages());
  ipcMain.handle('images:remove', (_e, ref: string) => imageLibrary.removeImage(ref));

  ipcMain.handle('sessions:read', (_e, workspaceId: string) =>
    sessions.readInventory(workspaceId)
  );
  ipcMain.handle(
    'sessions:write',
    (_e, workspaceId: string, inventory: sessions.SessionInventory) =>
      sessions.writeInventory(workspaceId, inventory)
  );

  /**
   * Start an existing (live, possibly stopped) workspace by id. Returns
   * the workspace if a container with that id exists; null otherwise,
   * signalling the renderer to recreate from the saved manifest using the
   * normal create flow (which resolves vault credentials).
   */
  ipcMain.handle('workspace:start', async (_e, id: string): Promise<Workspace | null> => {
    const containerId = await backend.startWorkspace(id);
    if (!containerId) return null;
    await touchWorkspaceUsed(id);
    // Find the freshly-running workspace in the merged list so the
    // renderer gets the up-to-date state/status fields.
    const all = await listAllWorkspaces();
    return all.find((w) => w.id === id) ?? null;
  });

  ipcMain.handle('workspace:getManifest', async (_e, id: string) => {
    return readWorkspaceManifest(id);
  });

  ipcMain.handle('workspace:stop', (_e, containerId: string) => backend.stopWorkspace(containerId));
  ipcMain.handle('workspace:pause', (_e, containerId: string) => backend.pauseWorkspace(containerId));
  ipcMain.handle(
    'workspace:remove',
    (_e, containerId: string, opts?: RemoveWorkspaceOpts) => backend.removeWorkspace(containerId, opts)
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

  // Per-workspace vault. All operations are keyed by the workspace's id
  // (the ULID). The renderer never sees raw secret values for keys it
  // didn't just set — only the list of keys + the secret value on
  // explicit getSecret. setSecret/deleteSecret update the per-workspace
  // index in keytar; deleteAllForWorkspace runs at workspace delete time.
  ipcMain.handle('vault:available', () => vault.isVaultAvailable());
  ipcMain.handle('vault:listKeys', (_e, workspaceId: string) => vault.listKeys(workspaceId));
  ipcMain.handle('vault:getSecret', (_e, workspaceId: string, key: string) =>
    vault.getSecret(workspaceId, key)
  );
  ipcMain.handle('vault:setSecret', (_e, workspaceId: string, key: string, value: string) =>
    vault.setSecret(workspaceId, key, value)
  );
  ipcMain.handle('vault:deleteSecret', (_e, workspaceId: string, key: string) =>
    vault.deleteSecret(workspaceId, key)
  );
  ipcMain.handle('vault:deleteAllForWorkspace', (_e, workspaceId: string) =>
    vault.deleteAllForWorkspace(workspaceId)
  );

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
  ipcMain.handle('observability:summaryForWorkspace', (_e, workspaceId: string) =>
    summaryForWorkspace(workspaceId)
  );

  /**
   * Per-tab variant. Resolves broker→claude via the `broker_sessions`
   * table and returns that session's summary; falls back to the
   * workspace summary when no mapping is known (concurrent attach
   * disambiguation skipped, mapping pre-dates this PR, etc.). Same
   * `WorkspaceSummary` shape so the renderer treats both endpoints
   * interchangeably.
   */
  ipcMain.handle(
    'observability:summaryForBrokerSession',
    (_e, workspaceId: string, brokerSessionId: string) =>
      summaryForBrokerSession(workspaceId, brokerSessionId)
  );

  // Cost rollups (#32). USD is derived from `events` via pricing.ts and is
  // pure SQL + arithmetic on this side — no caching layer yet. The pane
  // already polls summaryForWorkspace every 2s and now reads the included
  // `usd`; these per-session / per-workspace endpoints exist for the
  // sessions table (#3) and future detail views.
  ipcMain.handle('observability:getCost', (_e, sessionId: string) =>
    costForSession(sessionId)
  );
  ipcMain.handle('observability:getCostForWorkspace', (_e, workspaceId: string) =>
    costForWorkspace(workspaceId)
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

  // Test-only IPC handlers. Gated by CLAUDE_FLEET_E2E=1 so they don't
  // ship in production builds. The mapping-learning path normally
  // depends on the docker/broker stack (attachPty records the pending
  // attach), which playwright can't reach — these handlers let an
  // e2e test drive the same logic against the real watcher + DB.
  if (process.env.CLAUDE_FLEET_E2E === '1') {
    ipcMain.handle(
      '__test:recordPendingAttach',
      (_e, workspaceId: string, brokerSessionId: string, recordedAt?: number) => {
        recordPendingAttach(workspaceId, brokerSessionId, recordedAt);
      }
    );
    ipcMain.handle(
      '__test:lookupBrokerSession',
      (_e, workspaceId: string, brokerSessionId: string) =>
        lookupBrokerSession(workspaceId, brokerSessionId)
    );
  }
}
