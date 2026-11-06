import { app, BrowserWindow, dialog, shell, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerIpc, invalidateWorkspaceList, stopRemoteBackend } from './ipc.js';
import { openDb, openDbPostgres, closeDb, deleteEmbeddingsForOtherModels, listSessionIds, recordError, stateKysely, sessionCaptureSignals, isAutomationSession } from './db.js';
import { initPerf, shutdownPerf, perfSpan, perfSpanAsync } from './perf.js';
import { PerfStore } from './perfStore.js';
import { resolvePerfConfig } from './perfConfig.js';
import { getPerfTelemetry, getPerfOtlp, getKnowledgeCapture, getKnowledgeCaptureDailyCap } from './config.js';
import { instrumentIpcHandle } from './perfIpc.js';
import { EMBED_MODEL_ID } from './vectors.js';
import { startMcpServer, stopMcpServer, ensureWorkspaceSocket, setMcpStatusListener, setQueryEmbedder, setClaimHandlers, setCaptureSettingsHandlers, setSearchHitHook, setReadSource, TOOLS } from './mcpServer.js';
import { broadcastMcpStatus } from './mcpStatusBroadcast.js';
import { ensureBuiltinLoadouts } from './loadouts.js';
import { JsonlWatcher } from './jsonlWatcher.js';
import { PeerStatusWatcher } from './peerStatusWatcher.js';
import { broadcastSessionStatus } from './sessionStatusBroadcast.js';
import { listWorkspaceManifests, manifestInvariant, readWorkspaceManifest, writeWorkspaceManifest, type WorkspaceSpec } from './workspaces.js';
import { wslLocalProjectsDir, wslLocalSessionsDir } from './localLauncher.js';
import { encodeClaudeProjectDir, workspaceClaudeSessionsDir, hostLocalSessionsDir } from './paths.js';
import { installMainProcessHandlers, getLogPath, setErrorSink, logError } from './errorLog.js';
import { installAppMenu } from './appMenu.js';
import { isOpenableExternalUrl } from './externalUrl.js';
import { appBuildSha, appVersionString } from './appVersion.js';
import { runStartupMigration } from './migration.js';
import { InboxStore } from './inbox/inboxDb.js';
import { registerInboxIpc } from './inbox/inboxIpc.js';
import { registerNotifyIpc } from './inbox/notifyIpc.js';
import { registerAutomationIpc } from './automations/automationIpc.js';
import { startPresence, attachKeepRunning, markQuitting, presenceDir, registerPresenceIpc } from './inbox/presence.js';
import { getKeepRunningInTray, setKeepRunningInTray, getStoreConfig, setStoreChoice } from './config.js';
import { migratePgStores, openPgStores, pingStore, type PgStores } from './store/pgStores.js';
import type { ManagedStoreConfig, PostgresStoreConfig, StoreConfig } from './store/storeConfig.js';
import { StoreSupervisor } from './store/storeSupervisor.js';
import { broadcastStoreStatus, registerStoreIpc, setActiveStore, storeChoiceOf } from './store/storeIpc.js';
import { setActiveStoreConfig } from './store/activeStore.js';
import { firstSwitchCopy, switchBackPlan, switchBackToSqlite } from './store/firstSwitch.js';
import { switchBackLive } from './store/storeSwitch.js';
import { InboxWriteGate } from './store/inboxWriteGate.js';
import { INBOX_PG_MARKER } from './store/sqliteFiles.js';
import { IMPORT_PG_TRACK } from './store/storeImport.js';
import { ensureManagedPostgres, stopManagedPostgres, type ManagedDocker } from './store/managedPostgres.js';
import { dockerodeManagedDocker } from './store/managedDocker.js';
import { recordHandlers } from './ipcHandlerScope.js';
import { broadcastInboxChanged } from './inbox/inboxBroadcast.js';
import { getSecret, setSecret } from './vault.js';
import { MANAGED_STORE_PASSWORD_KEY, MANAGED_STORE_SCOPE } from './vaultScopes.js';
import type { StoreStatus } from '../preload/storeTypes.js';
import { openPgMcpReadSource } from './store/pgReadSource.js';
import { schemaOf } from './store/postgres.js';
import { storeStartupOutcome, storeStartupPrompt } from './store/startupPrompt.js';
import { ensureWorkspaceClaudeJson } from './docker.js';
import { hardwareAccelDisabledAtStartup } from './config.js';
import { setWorkspaceDefault } from './mirrorPolicy.js';
import { makeEmbedder } from './embeddings.js';
import { indexSessionTurns, indexSessionSummaries, type EmbedFn } from './transcriptIndex.js';
import { ClaimStore } from './claims/claimStore.js';
import { CaptureRunStore, startOfLocalDay } from './claims/captureRunStore.js';
import { CaptureSettingsLogStore } from './claims/captureSettingsLog.js';
import { createCaptureSettingsService } from './claims/captureSettingsService.js';
import { onCaptureSettingsChanged } from './claims/captureSettingsEvents.js';
import { ClaimService } from './claims/claimService.js';
import { CaptureScheduler } from './claims/captureScheduler.js';
import { loadCaptureForks } from './claims/captureForks.js';
import { killLocalCaptures, resolveCaptureTarget, runCapture } from './claims/captureExec.js';
import { ensureContainerRetention } from './claims/retention.js';
import { effectiveCaptureSettings } from '../preload/captureSettings.js';
import { randomUUID } from 'node:crypto';

// Mock mode is for UI iteration without Docker; no real JSONLs exist, so the
// watcher and DB stay dormant.
const isMock = process.env.CLAUDE_FLEET_MOCK === '1';
const jsonlWatcher = isMock ? null : new JsonlWatcher();
// Authoritative busy/idle/waiting from claude's peer-status files (#286).
const peerStatusWatcher = isMock ? null : new PeerStatusWatcher();
// Authoritative inbox store (#407); opened at ready, closed on quit.
let inboxStore: InboxStore | null = null;
// Knowledge claims (#483); assigned once the inbox (and its Kysely handle) is
// open. Reused by the background capture scheduler (Task 9).
let captureRuns: CaptureRunStore | null = null;
let claimService: ClaimService | null = null;
let captureScheduler: CaptureScheduler | null = null;
// The Postgres store's shared pool when config.json chooses it.
let pgStores: PgStores | null = null;
let supervisor: StoreSupervisor<PgStores> | null = null;
// Set when the store is the managed container: stopped at quit.
let managedDocker: ManagedDocker | null = null;
// Where the inbox lives this run; the switch back to SQLite moves it.
let inboxOn: 'sqlite' | 'postgres' | null = null;
// The Postgres inbox's afterBeginWrite: closed while the switch back copies it.
const inboxGate = new InboxWriteGate();
// Undoes what the inbox-backed services registered, so they can start again on the other store.
const inboxTeardown: Array<() => void> = [];
let keepRunningAttached = false;
let presence: ReturnType<typeof startPresence> | null = null;
// Notification + automation timers (#457): stopped in before-quit, ahead of inboxStore.close().
let notifySvc: ReturnType<typeof registerNotifyIpc> | null = null;
let auto: ReturnType<typeof registerAutomationIpc> | null = null;

/** Register each workspace's peer-status `sessions/` dir with the watcher.
 *  Container: the bind-mounted host dir. Local native/custom: the shared host
 *  ~/.claude/sessions (registered once). Local WSL: the polled 9P-share dir. */
function registerPeerStatusDirs(
  watcher: PeerStatusWatcher,
  manifests: Awaited<ReturnType<typeof listWorkspaceManifests>>
): void {
  let hostNativeRegistered = false;
  for (const m of manifests) {
    if (m.kind === 'local') {
      if (m.launcher?.mode === 'wsl') {
        watcher.registerPolledDir(wslLocalSessionsDir(m.launcher.distro, m.launcher.home));
      } else if (!hostNativeRegistered) {
        watcher.registerDir(hostLocalSessionsDir());
        hostNativeRegistered = true;
      }
    } else {
      watcher.registerDir(workspaceClaudeSessionsDir(m.id));
    }
  }
}

/** The inbox's timers and background writers. */
function stopInboxWriters(): void {
  notifySvc?.stop();
  auto?.stop();
  captureScheduler?.stop();
}

function teardownInboxServices(): void {
  stopInboxWriters();
  for (const undo of inboxTeardown.splice(0).reverse()) undo();
}

function portOf(cfg: PostgresStoreConfig): number | null {
  const c = cfg.connection;
  return 'port' in c ? c.port : null;
}

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
    ...(process.platform === 'linux' ? { icon: join(presenceDir(), 'window-256.png') } : {}),
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
    if (isOpenableExternalUrl(details.url)) void shell.openExternal(details.url);
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
  installAppMenu();
  // Surface the log location so users (and Playwright tests) can find it.
  console.log(`[claude-fleet] error log: ${getLogPath()}`);

  // Clean-slate migration to the ULID-keyed workspace model. Runs every
  // boot but no-ops once everything's already on the new shape.
  await runStartupMigration();

  // Seed the built-in loadout starters if the library doesn't exist yet
  // (#16-followup). Idempotent; non-fatal — a seeding hiccup must not block launch.
  await ensureBuiltinLoadouts().catch((e) => console.warn('[loadouts] seed failed:', e));

  // The store (§8 Startup). SQLite opens inline. A Postgres store (managed or
  // external) comes up under the supervisor without holding the launch, and the
  // services that read or write it start once it is ready. A config error stops
  // the launch: silently using SQLite would split the history and inbox in two.
  // Mock mode has no Docker and no transcripts, so it always uses SQLite.
  const userData = app.getPath('userData');
  let storeCfg: StoreConfig = { kind: 'sqlite' };
  try {
    storeCfg = await getStoreConfig();
  } catch (e) {
    logError({ source: 'main', type: 'store-open-failed', level: 'error', message: String(e) });
    const prompt = storeStartupPrompt(e, join(userData, 'config.json'));
    const { response } = await dialog.showMessageBox({ type: 'error', noLink: true, ...prompt });
    if (storeStartupOutcome(prompt, response) === 'quit') {
      app.exit(1);
      return;
    }
  }
  if (isMock) storeCfg = { kind: 'sqlite' };
  setActiveStoreConfig(storeCfg);
  const sqlite = storeCfg.kind === 'sqlite';

  if (sqlite) {
    // Authoritative inbox (#407): opens in mock AND real mode. state.db is a
    // droppable cache gated on the JSONL watcher; the inbox is neither.
    try {
      inboxStore = InboxStore.open(userData);
      inboxOn = 'sqlite';
    } catch (e) {
      logError({ source: 'main', type: 'inbox-open-failed', level: 'error', message: String(e) });
    }
  }

  /** The error sink, the app-start row and perf telemetry: all write state.db. */
  const startStateWrites = async (): Promise<void> => {
    // Wire the crash-safe DB sink so every logError call is also persisted to
    // the errors table.
    // best-effort; a wedged DB must never break crash logging, so the async
    // write's rejection is swallowed here.
    setErrorSink((row) => {
      void recordError(row).catch(() => undefined);
    });
    // One line per app run identifying the build (#298): the error.log header
    // and an errors-table row that lets historical telemetry be partitioned by
    // build sha when two builds share a semver.
    logError({
      source: 'main',
      type: 'app-start',
      level: 'info',
      message: `claude-fleet ${appVersionString()} starting`,
      extra: { sha: appBuildSha() ?? null }
    });
    const perfStore = new PerfStore(stateKysely());
    initPerf(
      perfStore,
      resolvePerfConfig(
        { perfTelemetry: await getPerfTelemetry(), perfOtlp: await getPerfOtlp() },
        process.env
      )
    );
  };

  /** Knowledge claims (#483): record_claim/search_claims/retract_claim MCP
   *  tools, backed by the inbox's Kysely handle. captureRuns/claimService are
   *  module-scoped so the background capture scheduler (Task 9) can reuse them. */
  const startClaims = (inbox: InboxStore, embedFn: EmbedFn): void => {
    const claimStore = new ClaimStore(inbox.kysely, inbox.dialect);
    captureRuns = new CaptureRunStore(inbox.kysely);
    claimService = new ClaimService({
      claims: claimStore, runs: captureRuns, embed: embedFn,
      workspaceName: async (id) => (await readWorkspaceManifest(id))?.name ?? null
    });
    setClaimHandlers({
      record: (c, a) => claimService!.record(c, a),
      search: (c, a) => claimService!.search(c, a),
      retract: (c, a) => claimService!.retract(c, a)
    });
    inboxTeardown.push(() => setClaimHandlers(null));
    void captureRuns.failRunning(Date.now(), 'interrupted by app restart').catch((e) =>
      logError({ source: 'main', level: 'warn', type: 'capture-fail-running', message: String(e) }));
    void claimService.backfillVectors().catch((e) =>
      logError({ source: 'main', level: 'warn', type: 'claims-backfill', message: String(e) }));
  };

  /** Seed each workspace's durable-mirror default from its manifest before the
   *  watcher starts ingesting, so the very first lines are mirrored per the
   *  saved setting — not dependent on the renderer's later workspace:list poll. */
  const startWatcher = async (watcher: JsonlWatcher, manifests: WorkspaceSpec[]): Promise<void> => {
    for (const m of manifests) setWorkspaceDefault(m.id, m.mirror.default);
    await perfSpanAsync('claude_fleet.boot.jsonl_watcher_start', () => watcher.start(manifests.map((m) => m.id)));
  };

  /** Knowledge capture (#483 §5): background capture forks, triggered by
   *  context bands on ingest and by search hits from the MCP search tools. */
  const startCaptureScheduler = async (watcher: JsonlWatcher): Promise<void> => {
    if (inboxStore && captureRuns && claimService) {
      const runs = captureRuns;
      const claimsSvc = claimService;
      // Never let a store failure block registerIpc/createWindow: without the
      // seed, old fork transcripts merely aren't recognised as forks.
      try {
        loadCaptureForks(await runs.forkSessionIds());
      } catch (e) {
        logError({ source: 'main', level: 'warn', type: 'capture-fork-seed', message: String(e) });
      }
      const scheduler = new CaptureScheduler({
        runs,
        signals: (id) => sessionCaptureSignals(id),
        isAutomation: (id) => isAutomationSession(id),
        globalEnabled: () => getKnowledgeCapture(),
        settings: async (ws) => {
          const m = await readWorkspaceManifest(ws);
          return m ? effectiveCaptureSettings(m) : null;
        },
        dailyCap: () => getKnowledgeCaptureDailyCap(),
        // Null for a container that isn't running, before admit: no daily-cap slot.
        target: (ws) => resolveCaptureTarget(ws),
        topTopics: async (ws) => [...new Set((await claimsSvc.search(ws, { query: 'fleet', limit: 20 })).results.flatMap((r) => r.topics))].slice(0, 15),
        exec: (t, args, timeoutMs) => runCapture(t, args, timeoutMs),
        fleetToolNames: TOOLS.map((t) => t.name),
        killInFlight: () => { killLocalCaptures(); },
        newUuid: () => randomUUID(),
        now: () => Date.now(),
        log: (message, extra) => logError({ source: 'main', level: 'info', type: 'knowledge-capture', message, extra })
      });
      captureScheduler = scheduler;
      const onIngest = (e: { workspaceId: string; sessionId: string }): void => scheduler.onIngest(e);
      watcher.on('ingest', onIngest);
      setSearchHitHook((e) => scheduler.onSearchHit(e));
      inboxTeardown.push(() => {
        watcher.off('ingest', onIngest);
        setSearchHitHook(null);
      });
    }
  };

  /** Local-backend workspaces write to the host's real ~/.claude, not the
   *  per-workspace state dir — register those host project dirs so their
   *  (and their subagents') token spend is ingested (#plan-usage). */
  const registerLocalDirs = (watcher: JsonlWatcher, manifests: WorkspaceSpec[]): void => {
    for (const m of manifests) {
      // Sweep for states that should be impossible (#323). writeWorkspaceManifest
      // catches these as they're written, but a manifest already on disk in a bad
      // state is never re-written, so it would otherwise stay silent forever —
      // which is exactly what happened for ~6 days in #313.
      const violation = manifestInvariant(m);
      if (violation) {
        logError({
          source: 'main',
          type: 'manifest-invariant',
          level: 'error',
          message: `${violation} (found at startup)`,
          workspaceId: m.id,
          extra: { workspaceRoot: m.workspaceRoot, launcher: m.launcher, kind: m.kind }
        });
      }
      if (m.kind === 'local' && m.workspaceRoot) {
        if (m.launcher?.mode === 'wsl') {
          watcher.registerPolledLocalDir(
            m.id,
            wslLocalProjectsDir(
              m.launcher.distro, m.launcher.home, m.workspaceRoot, encodeClaudeProjectDir
            )
          );
        } else {
          watcher.registerLocalWorkspace(m.id, m.workspaceRoot);
        }
      }
    }
  };

  /** Backfill embeddings for sessions ingested before this feature / after a
   *  model change. Non-blocking; walks every known session once. */
  const startEmbedBackfill = (embedFn: EmbedFn): void => {
    void (async () => {
      try {
        // A model/dtype change re-keys EMBED_MODEL_ID; drop vectors under
        // retired keys so they don't accumulate as dead weight.
        // Spanned (#perf boot attribution): the post-launch stall storm overlaps
        // this backfill; boot.embed_backfill is wall time, the index.* / embed.*
        // child spans carry the synchronous parts that can block the loop.
        await perfSpanAsync('claude_fleet.boot.embed_backfill', async () => {
          await perfSpanAsync('claude_fleet.index.delete_stale_models', () => deleteEmbeddingsForOtherModels(EMBED_MODEL_ID));
          const sessionIds = await perfSpanAsync('claude_fleet.index.list_sessions', () => listSessionIds());
          for (const id of sessionIds) await indexSessionTurns(id, embedFn);
          await indexSessionSummaries(embedFn);
        });
      } catch (e) {
        logError({ source: 'main', level: 'warn', type: 'index-backfill', message: String(e) });
      }
    })();
  };

  /** Inbox, notification and automation IPC plus their timers, and the
   *  knowledge-capture settings that log to the inbox. */
  const startInboxServices = (inbox: InboxStore): void => {
    const scope = recordHandlers(ipcMain, () => {
      notifySvc = registerNotifyIpc(inbox);
      auto = registerAutomationIpc(inbox, notifySvc);
      const inboxHost = registerInboxIpc(inbox, notifySvc ?? undefined, auto ? (r, c) => auto!.automations.attribution(r, c) : undefined);
      auto?.setInboxSink(inboxHost);
    });
    inboxTeardown.push(() => scope.dispose());
    // Knowledge capture settings (#483 §5a): get/set_capture_settings MCP tools,
    // capture-settings proposals, and the change log for form edits.
    if (auto) {
      const settingsLog = new CaptureSettingsLogStore(inbox.kysely);
      const runsForCount = captureRuns ?? new CaptureRunStore(inbox.kysely);
      const proposals = auto.proposals;
      const captureSettings = createCaptureSettingsService({
        readManifest: (id) => readWorkspaceManifest(id),
        writeManifest: (spec) => writeWorkspaceManifest(spec),
        trusted: async (id) => {
          const m = await readWorkspaceManifest(id);
          return m?.kind === 'container' && (m.inbox?.trusted === true || m.role === 'automations');
        },
        log: settingsLog,
        propose: (callerId, change, reason) => proposals.proposeCaptureSettings(callerId, change, reason),
        notify: (n) => {
          if (!notifySvc) return;
          void notifySvc.request(n).catch((e) => logError({ source: 'main', type: 'notify-request', level: 'warn', message: String(e) }));
        },
        globalEnabled: () => getKnowledgeCapture(),
        dailyCap: () => getKnowledgeCaptureDailyCap(),
        capturesToday: () => runsForCount.countSince(startOfLocalDay(Date.now())),
        workspaceName: async (id) => (await readWorkspaceManifest(id))?.name ?? id,
        now: () => Date.now(),
        invalidateWorkspaceList
      });
      proposals.setCaptureSettingsApplier((ws, change, proposalId) => captureSettings.applyApproved(ws, change, proposalId));
      setCaptureSettingsHandlers({ get: (c) => captureSettings.get(c), set: (c, a) => captureSettings.set(c, a) });
      const offSettingsLog = onCaptureSettingsChanged((e) => {
        if (e.source !== 'form') return; // MCP/proposal writes log themselves (with their reason)
        void settingsLog.append({
          workspaceId: e.workspaceId, actor: 'user', before: e.before, after: e.after, reason: null, applied: true, proposalId: null, now: Date.now()
        }).catch((err) => logError({ source: 'main', type: 'capture-settings-log', level: 'warn', message: String(err), workspaceId: e.workspaceId }));
      });
      inboxTeardown.push(() => {
        offSettingsLog();
        setCaptureSettingsHandlers(null);
      });
    }
  };

  /** Desktop presence (#407 Phase 2b): tray, taskbar overlay, badge, attention. */
  const startPresenceServices = (win: BrowserWindow): void => {
    if (!inboxStore || !notifySvc) return;
    presence = startPresence(inboxStore, notifySvc, () => auto?.proposals.pendingCount() ?? 0);
    if (!keepRunningAttached) {
      keepRunningAttached = true;
      attachKeepRunning(win, () => presence?.hasTray() ?? false);
    }
    inboxTeardown.push(() => {
      presence?.stop();
      presence = null;
    });
  };

  const broadcastCounts = (inbox: InboxStore): void => {
    void inbox.counts().then((c) => broadcastInboxChanged(c, BrowserWindow.getAllWindows())).catch(() => undefined);
  };

  let embed: EmbedFn | null = null;
  if (jsonlWatcher) {
    if (sqlite) {
      openDb(userData);
      await startStateWrites();
    }
    // Read-only MCP server over <userData>/mcp.sock so in-container claude can
    // read history (sessions/events/cost): its own read-only state.db
    // connection on SQLite; on Postgres the history tools wait for setReadSource.
    perfSpan('claude_fleet.boot.mcp_server', () => startMcpServer(userData, sqlite ? {} : { readSource: null }));
    // Local embedder for semantic transcript search (native onnxruntime-node, on-host).
    const embedFn = makeEmbedder(join(userData, 'models'));
    embed = embedFn;
    setQueryEmbedder(embedFn);

    if (sqlite && inboxStore) startClaims(inboxStore, embedFn);

    // Index new turns/summaries as they land. Fire-and-forget: indexing must
    // never block ingest, and a failure degrades search silently (logged).
    jsonlWatcher.on('ingest', ({ sessionId }) => {
      indexSessionTurns(sessionId, embedFn).catch((e) =>
        logError({ source: 'main', level: 'warn', type: 'transcript-index', message: String(e) }));
    });
    jsonlWatcher.on('ingest', () => {
      indexSessionSummaries(embedFn).catch((e) =>
        logError({ source: 'main', level: 'warn', type: 'summary-index', message: String(e) }));
    });
    // Surface host MCP listener health to renderers as the "MCP unreachable"
    // sticky toast (#159 follow-up): fan the change-only status out to every
    // window. Wired before the listener can fail so the first event is caught.
    setMcpStatusListener((s) => broadcastMcpStatus(s, BrowserWindow.getAllWindows()));
    // Remote bookmarks have no local socket, transcripts or peer-status dir.
    const manifests = (await listWorkspaceManifests()).filter((m) => m.kind !== 'remote');
    // Re-establish a per-workspace MCP listener for every known workspace (#117)
    // so a paused container that survived the restart finds its socket again
    // (its bind points at <userData>/mcp/<id>/, whose listener must be rebuilt).
    perfSpan('claude_fleet.boot.workspace_sockets', () => { for (const m of manifests) ensureWorkspaceSocket(m.id); });
    // Reconcile the app-managed mcpServers entry in every container workspace's
    // bind-mounted ~/.claude.json at startup — not just at container create.
    // Without this, a bridge fix never reaches an existing workspace until its
    // container is recreated: the old socat entry kept eating the first MCP
    // request after every app restart (the first-call hang) indefinitely.
    // Live claude sessions still pick it up only when they (re)spawn the MCP
    // server process — a tab Refresh or a new session, not a container rebuild.
    for (const m of manifests) {
      if (m.kind !== 'container') continue;
      const workingDir = `/workspace/${m.workspaceSubdir}`.replace(/\/$/, '') || '/workspace';
      ensureWorkspaceClaudeJson(m.id, workingDir).catch((e) =>
        logError({
          source: 'main',
          type: 'claude-json-reconcile',
          level: 'warn',
          message: `startup reconcile of ~/.claude.json failed: ${String(e)}`,
          workspaceId: m.id
        })
      );
      ensureContainerRetention(m.id, effectiveCaptureSettings(m).transcriptRetentionDays).catch((e) =>
        logError({ source: 'main', type: 'claude-retention', level: 'warn', message: String(e), workspaceId: m.id }));
    }
    // #483 §5a: re-apply container retention when a workspace's setting changes
    // (form save, MCP set_capture_settings, or an approved proposal). Local
    // workspaces pick it up on their next launch.
    onCaptureSettingsChanged((e) => {
      if (e.before.transcriptRetentionDays === e.after.transcriptRetentionDays) return;
      void readWorkspaceManifest(e.workspaceId)
        .then((m) => (m?.kind === 'container' ? ensureContainerRetention(m.id, e.after.transcriptRetentionDays) : false))
        .catch((err) => logError({ source: 'main', type: 'claude-retention', level: 'warn', message: String(err), workspaceId: e.workspaceId }));
    });
    if (sqlite) {
      await startWatcher(jsonlWatcher, manifests);
      await startCaptureScheduler(jsonlWatcher);
      registerLocalDirs(jsonlWatcher, manifests);
    }
    // Peer-status reconciler (#286): watch each workspace's claude
    // `sessions/<pid>.json` files and push an authoritative busy/idle/waiting
    // snapshot to every renderer, which merges it over the title glyph.
    if (peerStatusWatcher) {
      await perfSpanAsync('claude_fleet.boot.peer_status_start', () => peerStatusWatcher.start());
      registerPeerStatusDirs(peerStatusWatcher, manifests);
      peerStatusWatcher.on('change', (snapshot) => {
        broadcastSessionStatus(
          snapshot.map((s) => ({ claudeSessionId: s.sessionId, status: s.status, waitingFor: s.waitingFor })),
          BrowserWindow.getAllWindows()
        );
      });
    }
    if (sqlite) startEmbedBackfill(embedFn);
  }

  if (!sqlite) {
    const pgCfg = storeCfg as PostgresStoreConfig | ManagedStoreConfig;
    const docker = pgCfg.kind === 'managed' ? dockerodeManagedDocker() : null;
    managedDocker = docker;
    const resolveCfg = (): Promise<PostgresStoreConfig> =>
      pgCfg.kind === 'managed'
        ? ensureManagedPostgres({
          docker: docker!,
          password: {
            get: () => getSecret(MANAGED_STORE_SCOPE, MANAGED_STORE_PASSWORD_KEY),
            set: (v) => setSecret(MANAGED_STORE_SCOPE, MANAGED_STORE_PASSWORD_KEY, v),
          },
        }, pgCfg.poolMax)
        : Promise.resolve(pgCfg);
    let openedPort: number | null = null;
    const openStores = async (): Promise<PgStores> => {
      const cfg = await resolveCfg();
      const stores = await openPgStores(cfg, {
        state: false,
        afterBeginWrite: inboxGate.hook,
        onPoolError: (e) => logError({ source: 'main', type: 'store-pool-error', level: 'warn', message: String(e) }),
        migrate: (pool) => migratePgStores(pool, { state: true, extraTracks: [IMPORT_PG_TRACK] }),
      });
      openedPort = portOf(cfg);
      return stores;
    };
    const closeStores = async (stores: PgStores): Promise<void> => {
      await stores.inbox.close();
      await stores.end();
    };
    /** Refuse new inbox writes, stop the timers that write, and wait for writes in flight. */
    const quiesceInbox = async (stores: PgStores): Promise<void> => {
      inboxGate.close('The inbox is moving to SQLite; try again in a moment.');
      stopInboxWriters();
      await inboxGate.drain(stores.inbox.kysely);
    };
    /** Start the inbox-backed services again, on the store the inbox now lives in. */
    const resumeInbox = async (on: 'postgres' | 'sqlite'): Promise<void> => {
      teardownInboxServices();
      if (on === 'sqlite') {
        const left = inboxStore;
        inboxStore = null;
        inboxOn = null;
        try {
          inboxStore = InboxStore.open(userData);
          inboxOn = 'sqlite';
        } catch (e) {
          logError({ source: 'main', type: 'inbox-open-failed', level: 'error', message: String(e) });
        }
        // The gate stays closed: a late write through the old services is refused.
        void left?.close().catch(() => undefined);
      } else {
        inboxGate.open();
      }
      if (!inboxStore) return;
      if (embed) startClaims(inboxStore, embed);
      if (jsonlWatcher) await startCaptureScheduler(jsonlWatcher);
      startInboxServices(inboxStore);
      if (mainWindow) startPresenceServices(mainWindow);
      broadcastCounts(inboxStore);
    };
    const sup = new StoreSupervisor<PgStores>({
      choice: storeChoiceOf(storeCfg) as 'managed' | 'external',
      open: openStores,
      prepare: (stores, onProgress) => firstSwitchCopy({ pool: stores.pool, userData, state: true, onProgress }),
      ready: async (stores) => {
        pgStores = stores;
        inboxStore = stores.inbox;
        inboxOn = 'postgres';
        if (embed) startClaims(stores.inbox, embed);
        // A history failure must not keep the inbox down: it is rethrown (logged) after.
        let historyFailed: unknown = null;
        if (jsonlWatcher && embed) {
          try {
            // After the copy: openDbPostgres rehydrates pendingClaudeIds from the copied rows.
            await openDbPostgres(stores.pool, { migrate: false });
            await startStateWrites();
            setReadSource(await openPgMcpReadSource(schemaOf(stores.pool), stores.poolConfig, (message) =>
              logError({ source: 'main', type: 'mcp-query-isolation', level: 'warn', message })));
            const manifests = (await listWorkspaceManifests()).filter((m) => m.kind !== 'remote');
            await startWatcher(jsonlWatcher, manifests);
            await startCaptureScheduler(jsonlWatcher);
            registerLocalDirs(jsonlWatcher, manifests);
            startEmbedBackfill(embed);
          } catch (e) {
            historyFailed = e;
          }
        }
        startInboxServices(stores.inbox);
        if (mainWindow) startPresenceServices(mainWindow);
        broadcastCounts(stores.inbox);
        if (historyFailed) throw historyFailed;
      },
      ping: (stores) => pingStore(stores.pool),
      repair: docker ? async () => {
        const cfg = await resolveCfg();
        if (openedPort !== null && portOf(cfg) !== openedPort) {
          throw new Error('the managed Postgres moved to another port; restart the app to reconnect');
        }
      } : undefined,
      recovered: () => {
        jsonlWatcher?.requeueAll();
        if (inboxStore) broadcastCounts(inboxStore);
      },
      close: closeStores,
      log: (type, message) => logError({ source: 'main', type, level: 'warn', message }),
    });
    supervisor = sup;
    setActiveStore(storeChoiceOf(storeCfg), () => sup.status(), pgCfg.kind !== 'managed' ? undefined : () => switchBackLive<PgStores>({
      inboxOn: () => inboxOn,
      exclusive: (fn) => sup.exclusive(fn),
      plan: () => switchBackPlan(userData),
      postgresInboxLive: () => existsSync(join(userData, INBOX_PG_MARKER)),
      open: openStores,
      close: closeStores,
      quiesce: quiesceInbox,
      copy: (stores, commit) => switchBackToSqlite({ pool: stores.pool, userData, commit, onProgress: () => undefined }),
      commit: () => setStoreChoice('sqlite'),
      resume: resumeInbox,
      stopBringUp: () => sup.stop(),
    }));
    sup.on('status', (s: StoreStatus) => broadcastStoreStatus(s, BrowserWindow.getAllWindows()));
  } else {
    setActiveStore('sqlite');
  }
  // Patch ipcMain.handle before ipc.ts registers anything, so every later-
  // registered handler runs inside a claude_fleet.ipc.<channel> span.
  // With recording off the tracer is a no-op — cost is one async frame/invoke.
  instrumentIpcHandle(ipcMain);
  perfSpan('claude_fleet.boot.register_ipc', () => registerIpc({ jsonlWatcher, peerStatusWatcher }));
  registerStoreIpc();
  if (sqlite && inboxStore) startInboxServices(inboxStore);
  registerPresenceIpc(ipcMain, { get: getKeepRunningInTray, set: setKeepRunningInTray });
  mainWindow = createWindow();
  startPresenceServices(mainWindow);
  void supervisor?.run();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      attachKeepRunning(mainWindow, () => presence?.hasTray() ?? false);
    }
  });
});

app.on('before-quit', async () => {
  markQuitting();
  supervisor?.stop();
  presence?.stop();
  presence = null;
  // Stop the notify/automation tick + debounce/input-wait timers before closing
  // inbox.db (#457), so nothing fires against a destroyed driver.
  notifySvc?.stop();
  notifySvc = null;
  setCaptureSettingsHandlers(null);
  setSearchHitHook(null);
  captureScheduler?.stop();
  captureScheduler = null;
  auto?.stop();
  auto = null;
  stopRemoteBackend();
  await jsonlWatcher?.stop();
  await peerStatusWatcher?.stop();
  stopMcpServer();
  await inboxStore?.close();
  inboxStore = null;
  await shutdownPerf();
  await closeDb();
  await pgStores?.end();
  pgStores = null;
  if (managedDocker) await stopManagedPostgres(managedDocker).catch(() => undefined);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
