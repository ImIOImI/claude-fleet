import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Mirrored from src/main/sessions.ts. Kept here as a type-only declaration so
// the preload doesn't reach into main-process code (and so the renderer can
// import it via FleetApi without a separate path mapping).
export interface SessionEntry {
  id: string;
  name: string;
  createdAt: number;
  /**
   * When set, this tab resumes a prior claude session: its first attach
   * spawns `claude --resume <resumeOf>` instead of a fresh claude, and the
   * broker→claude mapping is learned directly (resume appends to the
   * existing transcript, so no 'new-session' event fires). `resumeOf` is the
   * claude session UUID. Persisted so a reattach after the broker died
   * (host reboot) re-resumes the same session.
   */
  resumeOf?: string;
}
export interface SessionInventory {
  version: 1;
  sessions: SessionEntry[];
  nextNum: number;
  activeId?: string;
}

/**
 * One row of the Sessions table (#3). Mirrors db.SessionListRow plus the
 * overlaid workspace display fields the main process joins in. The renderer
 * computes the display title as `userSetName ?? aiTitle ?? firstUserMessage
 * ?? '(untitled)'`.
 */
export interface SessionListItem {
  id: string;
  workspaceId: string;
  aiTitle: string | null;
  firstUserMessage: string | null;
  userSetName: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  eventCount: number;
  usd: number;
  workspaceName: string;
  workspaceColorHue: number | null;
  workspaceState: 'running' | 'paused' | 'stopped' | 'deleted';
}

/**
 * Row shape from the JSONL → SQLite cache. Mirrors db.EventRow with the
 * subset the renderer needs. `rawJsonl` holds the original line so the
 * renderer can pull fields the extract columns don't cover yet.
 */
/**
 * Per-workspace summary for the right-rail observability pane. Reflects
 * the most-recently-active Claude session in the workspace; null when
 * no events have been ingested for that workspace yet.
 */
export interface WorkspaceObservabilitySummary {
  sessionId: string | null;
  title: string | null;
  model: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Total USD across all events in the session, derived from the pricing table. */
  usd: number;
  /**
   * Tokens consumed by the most recent assistant turn (input + cache_read +
   * cache_creation). Pair with `contextWindowTokens` for the displayed
   * percentage. Null when no assistant event has been seen yet.
   */
  lastTurnContextTokens: number | null;
  /**
   * Effective context window for this session in tokens — 200K for stock
   * Claude 4.x, 1M when the model id carries the `[1m]` marker OR when
   * any observed turn already exceeded 200K (handles the 1M beta header
   * case where the model string itself doesn't change). The terminal-pane
   * context bar divides `lastTurnContextTokens` by this for the fill.
   */
  contextWindowTokens: number;
  topTools: Array<{ name: string; count: number }>;
  /** Recent tool calls with input/duration/status, newest first. */
  recentToolCalls: Array<{
    name: string;
    input: string | null;
    durationMs: number | null;
    status: 'ok' | 'error' | 'pending';
    ts: number | null;
  }>;
  /** Per-turn USD cost over recent turns, oldest→newest (sparkline series). */
  costSeries: number[];
}

export interface ObservabilityCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  usd: number;
}

export interface ObservabilityEventRow {
  id: number;
  sessionId: string;
  workspaceName: string;
  ts: number | null;
  type: string;
  subtype: string | null;
  uuid: string | null;
  parentUuid: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  serviceTier: string | null;
  toolName: string | null;
  rawJsonl: string;
}

const api = {
  app: {
    mockMode: (): Promise<boolean> => ipcRenderer.invoke('app:mockMode'),
    /**
     * Forward a renderer-side error into the main process's error.log.
     * Called automatically by the global onerror/onunhandledrejection
     * handlers wired in src/renderer/src/main.tsx; callers can also use
     * it manually around a known-risky operation.
     */
    logError: (payload: {
      type: string;
      message: string;
      stack?: string;
      extra?: Record<string, unknown>;
    }): Promise<void> => ipcRenderer.invoke('app:logError', payload),
    /** Absolute path of the error.log file (so we can surface it in the UI later). */
    errorLogPath: (): Promise<string> => ipcRenderer.invoke('app:errorLogPath')
  },
  workspace: {
    backendReady: (): Promise<boolean> => ipcRenderer.invoke('workspace:ping'),
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (input: unknown) => ipcRenderer.invoke('workspace:create', input),
    /** Start an existing workspace by id. Returns null if no container exists for that id. */
    start: (id: string) => ipcRenderer.invoke('workspace:start', id),
    getManifest: (id: string) => ipcRenderer.invoke('workspace:getManifest', id),
    /** Update an existing workspace's manifest in place. Container is not touched — caller starts/stops separately. */
    writeManifest: (spec: unknown): Promise<void> =>
      ipcRenderer.invoke('workspace:writeManifest', spec),
    stop: (containerId: string) => ipcRenderer.invoke('workspace:stop', containerId),
    pause: (containerId: string) => ipcRenderer.invoke('workspace:pause', containerId),
    remove: (containerId: string, opts?: { deleteState?: boolean; id?: string }) =>
      ipcRenderer.invoke('workspace:remove', containerId, opts),
    ensureImage: async (onProgress: (p: { message: string }) => void): Promise<void> => {
      const channelId = globalThis.crypto.randomUUID();
      const channel = `workspace:ensureImage:progress:${channelId}`;
      const handler = (_e: IpcRendererEvent, p: { message: string }) => onProgress(p);
      ipcRenderer.on(channel, handler);
      try {
        await ipcRenderer.invoke('workspace:ensureImage', channelId);
      } finally {
        ipcRenderer.removeListener(channel, handler);
      }
    }
  },
  images: {
    list: () => ipcRenderer.invoke('images:list'),
    remove: (ref: string) => ipcRenderer.invoke('images:remove', ref)
  },
  sessions: {
    read: (workspaceId: string): Promise<SessionInventory> =>
      ipcRenderer.invoke('sessions:read', workspaceId),
    write: (workspaceId: string, inventory: SessionInventory): Promise<void> =>
      ipcRenderer.invoke('sessions:write', workspaceId, inventory),
    /**
     * Sessions table (#3). Omit `workspaceId` for the global list; pass it to
     * scope to one workspace. Returns newest-active first, with sessions whose
     * workspace was deleted already filtered out.
     */
    list: (workspaceId?: string): Promise<SessionListItem[]> =>
      ipcRenderer.invoke('sessions:list', workspaceId),
    /** Set (empty string clears) the manual name override for a session. */
    rename: (sessionId: string, name: string): Promise<void> =>
      ipcRenderer.invoke('sessions:rename', sessionId, name),
    /** Drop a session from the cache and delete its on-disk transcript. */
    delete: (workspaceId: string, sessionId: string): Promise<void> =>
      ipcRenderer.invoke('sessions:delete', workspaceId, sessionId),
    /**
     * Bring the session's workspace container up (unpause/start/no-op) and
     * return its containerId so the renderer can open a resume tab. Null when
     * the container is gone and can't be brought up here.
     */
    resume: (workspaceId: string): Promise<{ containerId: string } | null> =>
      ipcRenderer.invoke('sessions:resume', workspaceId)
  },
  fs: {
    isDirectory: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:isDirectory', path),
    mkdirp: (path: string): Promise<void> => ipcRenderer.invoke('fs:mkdirp', path),
    /** Reveal a host path in the OS file manager. Resolves '' on success, else an error string. */
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('fs:openPath', path)
  },
  loadouts: {
    /** Loadout library (#16-followup): browse, inspect, install/uninstall. */
    list: (): Promise<unknown[]> => ipcRenderer.invoke('loadouts:list'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('loadouts:get', id),
    openFolder: (id: string): Promise<string> => ipcRenderer.invoke('loadouts:openFolder', id),
    install: (workspaceId: string, loadoutId: string): Promise<unknown> =>
      ipcRenderer.invoke('loadouts:install', workspaceId, loadoutId),
    uninstall: (workspaceId: string, loadoutId: string): Promise<void> =>
      ipcRenderer.invoke('loadouts:uninstall', workspaceId, loadoutId)
  },
  config: {
    /** App-level settings: the fleet root, its derived shared folder, and the
     *  hardware-acceleration toggle. */
    get: (): Promise<{
      fleetRoot: string;
      sharedDir: string;
      disableHardwareAcceleration: boolean;
      autoReloadLoadouts: boolean;
    }> => ipcRenderer.invoke('config:get'),
    setFleetRoot: (path: string): Promise<{ fleetRoot: string; sharedDir: string }> =>
      ipcRenderer.invoke('config:setFleetRoot', path),
    setHardwareAccelDisabled: (
      disabled: boolean
    ): Promise<{ disableHardwareAcceleration: boolean }> =>
      ipcRenderer.invoke('config:setHardwareAccelDisabled', disabled),
    setAutoReloadLoadouts: (enabled: boolean): Promise<{ autoReloadLoadouts: boolean }> =>
      ipcRenderer.invoke('config:setAutoReloadLoadouts', enabled)
  },
  dialog: {
    pickDirectory: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickDirectory', defaultPath)
  },
  clipboard: {
    write: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
    read: (): Promise<string> => ipcRenderer.invoke('clipboard:read')
  },
  menu: {
    showTerminalContextMenu: (
      opts: { hasSelection: boolean }
    ): Promise<'copy' | 'paste' | 'selectAll' | null> =>
      ipcRenderer.invoke('menu:showTerminalContextMenu', opts)
  },
  vault: {
    /** Probe whether the OS keychain is reachable. Cached after first call. */
    available: (): Promise<boolean> => ipcRenderer.invoke('vault:available'),
    /** List the secret keys stored for one workspace. */
    listKeys: (workspaceId: string): Promise<string[]> =>
      ipcRenderer.invoke('vault:listKeys', workspaceId),
    /** Fetch a specific secret value. Returns null when missing or no keychain. */
    getSecret: (workspaceId: string, key: string): Promise<string | null> =>
      ipcRenderer.invoke('vault:getSecret', workspaceId, key),
    /** Store or update a secret. Throws when keychain unavailable. */
    setSecret: (workspaceId: string, key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('vault:setSecret', workspaceId, key, value),
    /** Delete a single secret. No-op when missing. */
    deleteSecret: (workspaceId: string, key: string): Promise<void> =>
      ipcRenderer.invoke('vault:deleteSecret', workspaceId, key),
    /** Purge every secret for a workspace + its index. Called on workspace delete. */
    deleteAllForWorkspace: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke('vault:deleteAllForWorkspace', workspaceId)
  },
  pty: {
    attach: (
      containerId: string,
      brokerSessionId: string,
      cols: number,
      rows: number,
      // claude session UUID to resume — spawns `claude --resume <uuid>` on
      // the first CREATE for this tab. Omitted for ordinary new sessions.
      resumeOf?: string
    ): Promise<string> =>
      ipcRenderer.invoke('pty:attach', containerId, brokerSessionId, cols, rows, resumeOf),
    input: (sessionId: string, data: string) =>
      ipcRenderer.invoke('pty:input', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
    detach: (sessionId: string) => ipcRenderer.invoke('pty:detach', sessionId),
    /** Terminate the session (kills claude). Returns true if a handle was live. */
    closeSession: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('pty:closeSession', sessionId),
    onData: (sessionId: string, cb: (chunk: Uint8Array) => void) => {
      const channel = `pty:data:${sessionId}`;
      const handler = (_e: IpcRendererEvent, chunk: Buffer) => cb(new Uint8Array(chunk));
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onEnd: (sessionId: string, cb: () => void) => {
      const channel = `pty:end:${sessionId}`;
      const handler = () => cb();
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
  },
  // Durable transcript mirror (#10). The renderer addresses sessions by their
  // broker session id; the main process resolves that to the claude session
  // id (the mirror filename) internally.
  mirror: {
    /** Set the per-session mirror override before attaching this tab. */
    setOverride: (workspaceId: string, brokerSessionId: string, setting: 'on' | 'off') =>
      ipcRenderer.invoke('mirror:setOverride', workspaceId, brokerSessionId, setting),
    /** Whether this tab has a mirror file on disk (false if no mapping yet). */
    hasForBrokerSession: (workspaceId: string, brokerSessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('transcript:hasForBrokerSession', workspaceId, brokerSessionId),
    /** Delete this tab's mirror file (no-op if none). */
    deleteForBrokerSession: (workspaceId: string, brokerSessionId: string): Promise<void> =>
      ipcRenderer.invoke('transcript:deleteForBrokerSession', workspaceId, brokerSessionId),
    /** Claude session ids that have a mirror file (sessions-table cleanup). */
    list: (workspaceId: string): Promise<string[]> =>
      ipcRenderer.invoke('transcript:list', workspaceId)
  },
  observability: {
    /**
     * Pull rows from the JSONL→SQLite cache for one session, in id order,
     * after `sinceEventId`. Renderer polls this for catch-up; a live-push
     * channel arrives with the cost-rollup work in step 2 / observability
     * UI in step 3.
     */
    eventsForSession: (
      sessionId: string,
      sinceEventId = 0,
      limit = 500
    ): Promise<ObservabilityEventRow[]> =>
      ipcRenderer.invoke('observability:eventsForSession', sessionId, sinceEventId, limit),
    summaryForWorkspace: (
      workspaceId: string
    ): Promise<WorkspaceObservabilitySummary | null> =>
      ipcRenderer.invoke('observability:summaryForWorkspace', workspaceId),
    /**
     * Per-tab variant — looks up the claude session UUID mapped to
     * `brokerSessionId` and returns that session's summary. Falls back
     * to the workspace summary when no mapping is known yet, so the
     * caller always gets something usable.
     */
    summaryForBrokerSession: (
      workspaceId: string,
      brokerSessionId: string
    ): Promise<WorkspaceObservabilitySummary | null> =>
      ipcRenderer.invoke(
        'observability:summaryForBrokerSession',
        workspaceId,
        brokerSessionId
      ),
    /**
     * Per-session USD + token totals. The summary endpoint already carries
     * `usd` for the active session, so the right-rail pane doesn't need
     * this call; it's here for the sessions table (#3) and future per-
     * session detail views.
     */
    getCost: (sessionId: string): Promise<ObservabilityCost> =>
      ipcRenderer.invoke('observability:getCost', sessionId),
    /** USD + token totals aggregated across all sessions in a workspace. */
    getCostForWorkspace: (workspaceId: string): Promise<ObservabilityCost> =>
      ipcRenderer.invoke('observability:getCostForWorkspace', workspaceId),
    /**
     * Subscribe to live summary pushes. Main fires one push per ingest batch
     * (one JSONL flush ≈ one push) with the freshly computed summary for the
     * affected workspace. Returns an unsubscribe; callers in App.tsx
     * distribute the result into the shared summaries map.
     */
    onSummary: (
      cb: (workspaceId: string, summary: WorkspaceObservabilitySummary | null) => void
    ): (() => void) => {
      const channel = 'observability:summary';
      const handler = (
        _e: IpcRendererEvent,
        payload: { workspaceId: string; summary: WorkspaceObservabilitySummary | null }
      ): void => cb(payload.workspaceId, payload.summary);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
  }
};

contextBridge.exposeInMainWorld('api', api);

export type FleetApi = typeof api;
