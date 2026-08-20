import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron';

/** Outcome of a `pty:resize`. Lives here because preload is the IPC contract
 *  surface: main imports it type-only, and the renderer picks it up through
 *  `FleetApi = typeof api`. `ok` means the size reached the PTY; `actual` is
 *  the size the PTY reports holding afterwards, when the backend can read it
 *  back (node-pty only). See ipc.ts's handler and #268. */
export interface PtyResizeResult {
  ok: boolean;
  cols: number;
  rows: number;
  actual?: { cols: number; rows: number };
  reason?: 'unknown-handle' | 'not-delivered' | 'error';
}

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
  /** Per-session durable-mirror override; absent = use the workspace default. */
  mirror?: 'on' | 'off';
  /** When true, the tab name tracks Claude's session summary (auto-rename). */
  autoName?: boolean;
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
  /** Latest summary-chapter tags, relevance-ordered; [] when unsummarized. */
  tags: string[];
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
  /** Per-turn total tokens over recent turns, oldest→newest — the cost
   *  sparkline's sibling, shown when the rail's graph is toggled to tokens. */
  tokenSeries: number[];
}

/** One HTTP-serving container port in the rail's Serving section. pid /
 *  cmdline are null when the runner image's broker predates attribution;
 *  sessionId is likewise null on old brokers or orphaned servers. The kill
 *  affordance is always visible — on a pre-KILLPORT broker the kill fails
 *  with an error toast ("runner image too old — recreate the workspace"). */
export interface ServingPort {
  port: number;
  pid: number | null;
  cmdline: string | null;
  /** Broker session id of the tab whose process tree owns the server;
   *  null when the broker couldn't attribute one (orphan, old image). */
  sessionId: string | null;
  firstSeenAt: number;
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

/** Which Claude plan the observability rail's usage bar measures spend against. */
export type UsageBudgetPreset = 'pro' | 'max5' | 'max20' | 'custom';

/** Resolved plan-usage budget (mirrors `ResolvedUsageBudget` in main/config). */
export interface UsageBudget {
  preset: UsageBudgetPreset;
  customTokens: number;
  /** Effective allowance after resolving preset → tokens (0 hides the % bar). */
  allowanceTokens: number;
  windowHours: number;
  presets: Record<Exclude<UsageBudgetPreset, 'custom'>, number>;
}

/** Display preferences (mirrors `UiPrefs` in main/config). 0 = unlimited. */
export interface UiPrefs {
  showBudgetBar: boolean;
  showSessionCost: boolean;
  maxSessions: number;
  maxSessionAgeDays: number;
}

/** Perf-telemetry status snapshot (mirrors `PerfStatus` in main/perf). */
export interface PerfStatusPayload {
  enabled: boolean;
  source: 'settings' | 'env-override';
  otlp: { enabled: boolean; endpoint: string | null; source: 'settings' | 'env' };
  eventCounts: Record<string, number>;
}

const api = {
  app: {
    mockMode: (): Promise<boolean> => ipcRenderer.invoke('app:mockMode'),
    platform: (): Promise<NodeJS.Platform> => Promise.resolve(process.platform),
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
    errorLogPath: (): Promise<string> => ipcRenderer.invoke('app:errorLogPath'),
    /** Open error.log in the OS default app — the MCP-unreachable toast's action. */
    openErrorLog: (): Promise<string> => ipcRenderer.invoke('app:openErrorLog'),
    /** Current host MCP listener health, for a window mounting mid-outage. */
    getMcpStatus: (): Promise<{ ok: boolean; detail?: string }> =>
      ipcRenderer.invoke('mcp:status:get'),
    /** Subscribe to host MCP listener health changes (drives the sticky "MCP
     *  unreachable" toast). Returns an unsubscribe function. */
    onMcpStatus: (cb: (s: { ok: boolean; detail?: string }) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, s: { ok: boolean; detail?: string }): void => cb(s);
      ipcRenderer.on('mcp:status', handler);
      return () => ipcRenderer.removeListener('mcp:status', handler);
    }
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
    ensureImage: async (
      onProgress: (p: { message: string }) => void,
      image?: string
    ): Promise<void> => {
      const channelId = globalThis.crypto.randomUUID();
      const channel = `workspace:ensureImage:progress:${channelId}`;
      const handler = (_e: IpcRendererEvent, p: { message: string }) => onProgress(p);
      ipcRenderer.on(channel, handler);
      try {
        await ipcRenderer.invoke('workspace:ensureImage', channelId, image);
      } finally {
        ipcRenderer.removeListener(channel, handler);
      }
    }
  },
  local: {
    /** Installed WSL distros (win32; empty elsewhere) — populates the launcher picker (#253). */
    listWslDistros: (): Promise<{ distros: string[]; defaultDistro: string | null }> =>
      ipcRenderer.invoke('local:listWslDistros'),
    /** Probe one distro for shells/login shell/$HOME/claude/interop (#253). */
    probeWslDistro: (
      distro: string
    ): Promise<{
      shells: string[];
      loginShell: string;
      home: string;
      claudePath: string | null;
      interopEnabled: boolean;
    }> => ipcRenderer.invoke('local:probeWslDistro', distro)
  },
  images: {
    list: () => ipcRenderer.invoke('images:list'),
    remove: (ref: string) => ipcRenderer.invoke('images:remove', ref)
  },
  /** Cross-workspace committee control (#119). `callerId` is the workspace
   *  acting as manager; the host gates every call via assertControl. */
  committee: {
    pause: (callerId: string, targetId: string): Promise<{ id: string; paused: true }> =>
      ipcRenderer.invoke('committee:pause', callerId, targetId),
    unpause: (callerId: string, targetId: string): Promise<{ id: string; running: true }> =>
      ipcRenderer.invoke('committee:unpause', callerId, targetId),
    post: (
      callerId: string,
      targetId: string,
      message: string
    ): Promise<{ id: string; via: 'attached' | 'headless'; brokerSessionId?: string }> =>
      ipcRenderer.invoke('committee:post', callerId, targetId, message),
    collect: (
      callerId: string,
      targetId: string,
      since?: number
    ): Promise<{
      id: string;
      sessionId: string | null;
      cursor: number;
      turns: Array<{ id: number; ts: number | null; role: string; text: string }>;
    }> => ipcRenderer.invoke('committee:collect', callerId, targetId, since),
    status: (
      callerId: string,
      targetId: string
    ): Promise<{
      id: string;
      name: string;
      description?: string;
      labels: string[];
      roleHint?: string;
      installedLoadouts: Array<{ id: string; title: string }>;
      paused: boolean;
      busy: boolean;
      stalled: boolean;
      lastActiveAt: number | null;
    }> => ipcRenderer.invoke('committee:status', callerId, targetId),
    /** Discover experts that have opted in to `callerId` (reachable + acceptFrom
     *  names it), with metadata, liveness, and whether a grant is held. */
    roster: (
      callerId: string
    ): Promise<
      Array<{
        id: string;
        name: string;
        description?: string;
        labels: string[];
        roleHint?: string;
        installedLoadouts: Array<{ id: string; title: string }>;
        status: { paused: boolean; busy: boolean; stalled: boolean; lastActiveAt: number | null };
        grant: { controllable: boolean; verbs: Array<'read' | 'post' | 'pause'> };
      }>
    > => ipcRenderer.invoke('committee:roster', callerId),
    /** Subscribe to committee messages injected into a workspace (#123) so its
     *  tab can show a `[committee]` toast. Returns an unsubscribe. */
    onInbound: (cb: (workspaceId: string, message: string) => void): (() => void) => {
      const channel = 'committee:inbound';
      const handler = (_e: IpcRendererEvent, payload: { workspaceId: string; message: string }): void =>
        cb(payload.workspaceId, payload.message);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
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
  files: {
    /**
     * Resolve the host path of a dragged OS File. `webUtils.getPathForFile`
     * replaces the removed `File.path` property and must be called in the
     * preload (the renderer has no access to webUtils). Returns '' for
     * non-OS-file drops (synthetic File objects from web/text drags).
     */
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    /** OS file drag → saved container paths (`/workspace/_dropped/<name>`). */
    dropOsFiles: (workspaceId: string, sourcePaths: string[]): Promise<string[]> =>
      ipcRenderer.invoke('files:dropOsFiles', workspaceId, sourcePaths),
    /** Clipboard image / inline bytes → saved container path. */
    dropBytes: (
      workspaceId: string,
      payload: { suggestedName?: string; mime?: string; bytes: Uint8Array }
    ): Promise<string> => ipcRenderer.invoke('files:dropBytes', workspaceId, payload),
    /** Dragged web URL (fetched in main) → saved container path. */
    dropUrl: (workspaceId: string, url: string): Promise<string> =>
      ipcRenderer.invoke('files:dropUrl', workspaceId, url),
    /** Dragged text/HTML → saved container path. */
    dropText: (
      workspaceId: string,
      payload: { mime: 'text/plain' | 'text/html'; text: string }
    ): Promise<string> => ipcRenderer.invoke('files:dropText', workspaceId, payload)
  },
  loadouts: {
    /** Loadout library (#16-followup): browse, inspect, install/uninstall. */
    list: (): Promise<unknown[]> => ipcRenderer.invoke('loadouts:list'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('loadouts:get', id),
    openFolder: (id: string): Promise<string> => ipcRenderer.invoke('loadouts:openFolder', id),
    install: (
      workspaceId: string,
      loadoutId: string,
      opts?: { source?: string; version?: string; force?: boolean }
    ): Promise<{ status: 'installed' } | { status: 'needs-confirm'; reason: string }> =>
      ipcRenderer.invoke('loadouts:install', workspaceId, loadoutId, opts),
    uninstall: (workspaceId: string, loadoutId: string): Promise<void> =>
      ipcRenderer.invoke('loadouts:uninstall', workspaceId, loadoutId),
    catalog: (
      workspaceId?: string
    ): Promise<
      Array<{
        id: string;
        title: string;
        description: string;
        tags: string[];
        version: string;
        remoteVersion?: string;
        present: boolean;
        installed: boolean;
        installedVersion?: string;
        updateAvailable: boolean;
        favorited: boolean;
        sources: string[];
      }>
    > => ipcRenderer.invoke('loadouts:catalog', workspaceId),
    setFavorite: (id: string, on: boolean): Promise<string[]> =>
      ipcRenderer.invoke('loadouts:setFavorite', id, on),
    listSources: (): Promise<string[]> => ipcRenderer.invoke('loadouts:listSources'),
    addSource: (
      base: string
    ): Promise<Array<{ id: string; title: string; description: string; tags: string[]; version: string }>> =>
      ipcRenderer.invoke('loadouts:addSource', base),
    removeSource: (base: string): Promise<void> => ipcRenderer.invoke('loadouts:removeSource', base),
    refreshSource: (
      base: string
    ): Promise<Array<{ id: string; title: string; description: string; tags: string[]; version: string }>> =>
      ipcRenderer.invoke('loadouts:refreshSource', base)
  },
  config: {
    /** App-level settings: the fleet root, its derived shared folder, and the
     *  hardware-acceleration toggle. */
    get: (): Promise<{
      fleetRoot: string;
      sharedDir: string;
      disableHardwareAcceleration: boolean;
      autoReloadLoadouts: boolean;
      usageBudget: UsageBudget;
      uiPrefs: UiPrefs;
      perfTelemetry: boolean;
      perfOtlp: { enabled: boolean; endpoint: string };
    }> => ipcRenderer.invoke('config:get'),
    setFleetRoot: (path: string): Promise<{ fleetRoot: string; sharedDir: string }> =>
      ipcRenderer.invoke('config:setFleetRoot', path),
    setHardwareAccelDisabled: (
      disabled: boolean
    ): Promise<{ disableHardwareAcceleration: boolean }> =>
      ipcRenderer.invoke('config:setHardwareAccelDisabled', disabled),
    setAutoReloadLoadouts: (enabled: boolean): Promise<{ autoReloadLoadouts: boolean }> =>
      ipcRenderer.invoke('config:setAutoReloadLoadouts', enabled),
    setUsageBudget: (
      preset: UsageBudgetPreset,
      customTokens: number
    ): Promise<{ usageBudget: UsageBudget }> =>
      ipcRenderer.invoke('config:setUsageBudget', preset, customTokens),
    setUiPrefs: (prefs: Partial<UiPrefs>): Promise<{ uiPrefs: UiPrefs }> =>
      ipcRenderer.invoke('config:setUiPrefs', prefs),
    setPerfTelemetry: (enabled: boolean): Promise<PerfStatusPayload> =>
      ipcRenderer.invoke('config:setPerfTelemetry', enabled),
    setPerfOtlp: (enabled: boolean, endpoint: string): Promise<PerfStatusPayload> =>
      ipcRenderer.invoke('config:setPerfOtlp', enabled, endpoint)
  },
  usage: {
    /** Total tokens spent across the fleet in the trailing rolling window —
     *  the plan-usage bar's numerator. Poll it; the allowance is in config. */
    rollingSpend: (): Promise<{ spentTokens: number; windowHours: number }> =>
      ipcRenderer.invoke('usage:rollingSpend')
  },
  dialog: {
    pickDirectory: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickDirectory', defaultPath)
  },
  clipboard: {
    write: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
    read: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
    /** Image on the clipboard as PNG bytes, or null. For Ctrl+V image drops. */
    readImage: (): Promise<{ bytes: Uint8Array; mime: string } | null> =>
      ipcRenderer.invoke('clipboard:readImage')
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
  endpoints: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('endpoints:list'),
    save: (input: unknown): Promise<unknown> => ipcRenderer.invoke('endpoints:save', input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('endpoints:delete', id),
    setApiKey: (id: string, value: string | null): Promise<void> =>
      ipcRenderer.invoke('endpoints:setApiKey', id, value),
    probe: (baseUrl: string, modelId: string, apiKey?: string | null): Promise<unknown> =>
      ipcRenderer.invoke('endpoints:probe', baseUrl, modelId, apiKey ?? null)
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
    input: (sessionId: string, data: string, ts?: number) =>
      ipcRenderer.invoke('pty:input', sessionId, data, ts),
    /** Push a new terminal size to the PTY. Resolves the *outcome* — a resize
     *  can be dropped silently (unknown handle during the attach window, pty
     *  already exited), and the caller must not record a dropped size as
     *  delivered or claude stays pinned at a stale width (#268). */
    resize: (sessionId: string, cols: number, rows: number): Promise<PtyResizeResult> =>
      ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
    detach: (sessionId: string) => ipcRenderer.invoke('pty:detach', sessionId),
    /** Terminate the session (kills claude). Returns true if a handle was live. */
    closeSession: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('pty:closeSession', sessionId),
    /** Terminate a session by (workspace, broker session id) — used by tab-close,
     *  which knows the stable broker session id but not the per-attach handle.
     *  Kills claude via the same broker CLOSE the refresh path uses. */
    closeSessionByBroker: (workspaceId: string, brokerSessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('pty:closeSessionByBroker', workspaceId, brokerSessionId),
    onData: (sessionId: string, cb: (chunk: Uint8Array, ts?: number) => void) => {
      const channel = `pty:data:${sessionId}`;
      const handler = (_e: IpcRendererEvent, chunk: Buffer, ts?: number) => cb(new Uint8Array(chunk), ts);
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
  ports: {
    /** Subscribe to "dev server detected on port N" events (toast cue).
     *  Returns an unsubscribe function. */
    onDetected: (cb: (workspaceId: string, port: number) => void): (() => void) => {
      const channel = 'ports:detected';
      const handler = (_e: IpcRendererEvent, payload: { workspaceId: string; port: number }): void =>
        cb(payload.workspaceId, payload.port);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    /** Open a loopback forward to a container port and the system browser;
     *  returns the bound host port, or null when nothing answers on the
     *  container port anymore (stale toast). */
    open: (workspaceId: string, containerPort: number): Promise<{ hostPort: number | null }> =>
      ipcRenderer.invoke('ports:open', workspaceId, containerPort),
    /** Subscribe to per-workspace Serving snapshots (full replace per event;
     *  an empty array clears the workspace). Returns an unsubscribe fn. */
    onChanged: (cb: (workspaceId: string, ports: ServingPort[]) => void): (() => void) => {
      const channel = 'ports:changed';
      const handler = (
        _e: IpcRendererEvent,
        payload: { workspaceId: string; ports: ServingPort[] }
      ): void => cb(payload.workspaceId, payload.ports);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    /** Current Serving snapshots for all running workspaces (mount seed). */
    list: (): Promise<Array<{ workspaceId: string; ports: ServingPort[] }>> =>
      ipcRenderer.invoke('ports:list'),
    /** Kill the process behind a serving port (broker resolves the pid at
     *  kill time). The row clears via the next poll's ports:changed. */
    kill: (workspaceId: string, port: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ports:kill', workspaceId, port)
  },
  // Newer-claude cue for wsl-launcher workspaces (#336).
  claudeUpdate: {
    /** Subscribe to "a newer in-distro claude exists" cues (start-time check).
     *  Returns an unsubscribe function. */
    onAvailable: (
      cb: (update: {
        workspaceId: string;
        distro: string;
        pinned: { path: string; version: string | null };
        best: { path: string; version: string };
      }) => void
    ): (() => void) => {
      const channel = 'local:claude-update-available';
      const handler = (
        _e: IpcRendererEvent,
        payload: {
          workspaceId: string;
          distro: string;
          pinned: { path: string; version: string | null };
          best: { path: string; version: string };
        }
      ): void => cb(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    /** Persist a toast decision: adopt repins launcher.claudePath (new
     *  sessions only), ignore suppresses re-offers up to that version. */
    decide: (
      workspaceId: string,
      decision: { action: 'adopt'; path: string } | { action: 'ignore'; version: string }
    ): Promise<void> => ipcRenderer.invoke('local:claude-update-decision', workspaceId, decision)
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
     * Resume-grade tab→conversation resolution: the claude session UUID this
     * tab may `--resume`, or null when the mapping isn't verified (learned
     * deterministically at spawn, #195). Distinct from the summary lookup
     * above, which may serve legacy guessed mappings for display purposes.
     */
    resolveResumeTarget: (
      workspaceId: string,
      brokerSessionId: string
    ): Promise<string | null> =>
      ipcRenderer.invoke('sessions:resolveResumeTarget', workspaceId, brokerSessionId),
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
    },
    /**
     * Subscribe to live "needs input" pushes. Main fires one per change with the
     * full set of claude session UUIDs in that workspace currently blocked on an
     * AskUserQuestion prompt. Returns an unsubscribe.
     */
    onInputWait: (
      cb: (workspaceId: string, waitingSessionIds: string[]) => void
    ): (() => void) => {
      const channel = 'inputwait:update';
      const handler = (
        _e: IpcRendererEvent,
        payload: { workspaceId: string; waitingSessionIds: string[] }
      ): void => cb(payload.workspaceId, payload.waitingSessionIds);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    /**
     * Subscribe to authoritative peer-status pushes (#286): a flat list of
     * `{ claudeSessionId, status }` from claude's `~/.claude/sessions/<pid>.json`
     * files. The renderer merges this over the title glyph. Returns an unsubscribe.
     */
    onSessionStatus: (
      cb: (statuses: Array<{ claudeSessionId: string; status: 'busy' | 'idle' | 'waiting'; waitingFor?: string }>) => void
    ): (() => void) => {
      const channel = 'sessionstatus:update';
      const handler = (
        _e: IpcRendererEvent,
        payload: { statuses: Array<{ claudeSessionId: string; status: 'busy' | 'idle' | 'waiting'; waitingFor?: string }> }
      ): void => cb(payload.statuses);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
  },
  perf: {
    status: (): Promise<PerfStatusPayload> => ipcRenderer.invoke('perf:status'),
    /** Fire-and-forget latency sample batch (perf Phase 2). */
    samples: (payload: {
      sessionId: string;
      samples: Array<{ kind: 'output_hop' | 'echo_rtt'; durMs: number }>;
    }): void => ipcRenderer.send('perf:samples', payload),
    /** Subscribe to recording-state pushes. Returns an unsubscribe fn. */
    onState: (cb: (recording: boolean) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, recording: boolean): void => cb(recording);
      ipcRenderer.on('perf:state', handler);
      return () => ipcRenderer.removeListener('perf:state', handler);
    }
  }
};

contextBridge.exposeInMainWorld('api', api);

export type FleetApi = typeof api;
