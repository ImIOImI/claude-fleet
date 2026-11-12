import { app, BrowserWindow, dialog, shell, ipcMain } from 'electron';
import { join } from 'node:path';
import { registerIpc, invalidateWorkspaceList, replayInputWait, setFederatedEmbedder, stopRemoteBackend } from './ipc.js';
import { openDb, openDbPostgres, closeDb, deleteEmbeddingsForOtherModels, sessionsWithPendingTurns, recordErrors, stateKysely, onStateOpenStats, stateLeftoverDrain, setStateWarnSink, sessionCaptureSignals, isAutomationSession } from './db.js';
import { initPerf, shutdownPerf, perfSpan, perfSpanAsync, perfRecordSpan, perfNoteSqlSync, getEffectivePerf, recordBootProfile } from './perf.js';
import { setSqliteQueryObserver } from './store/kysely.js';
import { installWalCheckpointer } from './state/walCheckpointer.js';
import { startBootProfile } from './bootProfile.js';
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
import { encodeClaudeProjectDir, workspaceClaudeSessionsDir, hostLocalSessionsDir, workspaceStateDir } from './paths.js';
import { existsSync } from 'node:fs';
import { startRetention } from './state/retention.js';
import { clearStaleVacuumLock, prepareVacuum, spawnVacuumHelper, vacuumHelperActive, waitForVacuumHelper } from './state/vacuumHelper.js';
import { installMainProcessHandlers, getLogPath, setErrorSink, logError, batchedErrorSink, flushErrorLogSync } from './errorLog.js';
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
import { inboxOnPostgresNotice, switchBackLive } from './store/storeSwitch.js';
import { ServiceSteps } from './store/serviceSteps.js';
import { withinMs } from './withinMs.js';
import { InboxWriteGate } from './store/inboxWriteGate.js';
import { inboxOnPostgres } from './store/sqliteFiles.js';
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
import { runEmbedBackfill, storeIdentity, EMBED_BACKFILL_DELAY_MS } from './embedBackfill.js';
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
// The Postgres inbox's and history's afterBeginWrite: closed while the switch back copies.
const inboxGate = new InboxWriteGate();
const historyGate = new InboxWriteGate();
installWalCheckpointer();
setStateWarnSink((message, extra) => logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message, extra }));
// before-quit holds the quit at most this long (#485).
const QUIT_BOUND_MS = 10_000;
/** The db.open row is recorded at the first write, or this long after the open without one. */
const DB_OPEN_ROW_FALLBACK_MS = 10_000;
// A wedged store must not hold back closeDb and the Postgres shutdown.
const ERROR_ROWS_QUIT_MS = 500;
let shuttingDown = false;
let retention: ReturnType<typeof startRetention> | null = null;
// Undoes what the inbox-backed services registered, so they can start again on the other store.
const inboxTeardown: Array<() => void> = [];
let keepRunningAttached = false;
let presence: ReturnType<typeof startPresence> | null = null;
// Notification + automation timers (#457): stopped in before-quit, ahead of inboxStore.close().
let notifySvc: ReturnType<typeof registerNotifyIpc> | null = null;
let auto: ReturnType<typeof registerAutomationIpc> | null = null;
const errorRows = batchedErrorSink(recordErrors);

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
      flushErrorLogSync();
      app.exit(1);
      return;
    }
  }
  if (isMock) storeCfg = { kind: 'sqlite' };
  setActiveStoreConfig(storeCfg);
  const sqlite = storeCfg.kind === 'sqlite';

  // A SQLite start whose inbox lives in Postgres ("Continue without settings",
  // a hand-edited config.json) keeps the inbox closed rather than starting an empty one.
  const inboxElsewhere = sqlite ? inboxOnPostgresNotice(userData) : null;
  if (sqlite && !inboxElsewhere) {
    // Authoritative inbox (#407): opens in mock AND real mode. state.db is a
    // droppable cache gated on the JSONL watcher; the inbox is neither.
    try {
      inboxStore = InboxStore.open(userData);
    } catch (e) {
      logError({ source: 'main', type: 'inbox-open-failed', level: 'error', message: String(e) });
    }
  }

  // startStateWrites re-runs on a store restart; the boot profile is per launch.
  let bootProfileStarted = false;
  /** The error sink, the app-start row and perf telemetry: all write state.db. */
  const startStateWrites = async (): Promise<void> => {
    // Every logError row also lands in the errors table, batched; a rejected
    // write is swallowed so a wedged DB never breaks crash logging.
    setErrorSink(errorRows.sink);
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
    setSqliteQueryObserver((_sql, ms) => perfNoteSqlSync(ms));
    initPerf(
      perfStore,
      resolvePerfConfig(
        { perfTelemetry: await getPerfTelemetry(), perfOtlp: await getPerfOtlp() },
        process.env
      )
    );
    if (!bootProfileStarted && getEffectivePerf()?.recording) {
      bootProfileStarted = true;
      startBootProfile({
        outDir: join(userData, 'perf'),
        onResult: recordBootProfile,
        onError: (e) => logError({ source: 'main', level: 'warn', type: 'boot-profile', message: String(e) })
      });
    }
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
    const runs = captureRuns;
    const claims = claimService;
    void perfSpanAsync('claude_fleet.boot.capture_fail_running', () => runs.failRunning(Date.now(), 'interrupted by app restart')).catch((e) =>
      logError({ source: 'main', level: 'warn', type: 'capture-fail-running', message: String(e) }));
    // Delayed: on the in-process fallback, embedding loads the model on main.
    const claimsTimer = setTimeout(() => {
      if (shuttingDown) return;
      void perfSpanAsync('claude_fleet.boot.claims_backfill', () => claims.backfillVectors()).catch((e) =>
        logError({ source: 'main', level: 'warn', type: 'claims-backfill', message: String(e) }));
    }, EMBED_BACKFILL_DELAY_MS);
    claimsTimer.unref?.();
    inboxTeardown.push(() => clearTimeout(claimsTimer));
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
        loadCaptureForks(await perfSpanAsync('claude_fleet.boot.capture_fork_seed', () => runs.forkSessionIds()));
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
   *  model change. Starts after boot settles and yields between sessions so it
   *  never holds the main loop (#464); embedding runs in the sidecar. */
  const startEmbedBackfill = (embedFn: EmbedFn, storeId: string): void => {
    const timer = setTimeout(() => {
      void perfSpanAsync('claude_fleet.boot.embed_backfill', () => runEmbedBackfill({
        markerPath: join(userData, 'models', '.embed-model-id'),
        storeId,
        modelId: EMBED_MODEL_ID,
        deleteStale: () => deleteEmbeddingsForOtherModels(EMBED_MODEL_ID),
        listPendingSessionIds: () => sessionsWithPendingTurns(EMBED_MODEL_ID),
        indexTurns: (id) => indexSessionTurns(id, embedFn),
        indexSummaries: () => indexSessionSummaries(embedFn),
        onError: (step, e) => logError({ source: 'main', level: 'warn', type: 'index-backfill', message: `${step}: ${String(e)}` }),
      })).catch((e) => logError({ source: 'main', level: 'warn', type: 'index-backfill', message: String(e) }));
    }, EMBED_BACKFILL_DELAY_MS);
    timer.unref?.();
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

  /** Retention pass over state.db (SPEC §7 *Retention*); once per process. */
  const startStateRetention = (): void => {
    if (isMock) return;
    retention ??= startRetention({
      orphanSweep: storeCfg.kind !== 'postgres',
      walCheckpoints: storeCfg.kind === 'sqlite',
      listManifestIds: async () => (await listWorkspaceManifests()).map((m) => m.id),
      stateDirExists: (id) => existsSync(workspaceStateDir(id)),
    });
  };

  let embed: EmbedFn | null = null;
  // A one-time VACUUM from the last quit may still hold state.db's write lock:
  // the window and IPC come up now, the SQLite history services once it ends
  // (WAL readers, e.g. the MCP read source, aren't blocked by it).
  const historyAfterVacuum = sqlite && !!jsonlWatcher && vacuumHelperActive(userData);
  if (sqlite && !historyAfterVacuum) clearStaleVacuumLock(userData);
  let sqliteManifests: WorkspaceSpec[] = [];
  // Watcher-triggered indexing waits this long after ingest starts; the
  // deferred backfill covers what lands before (#464).
  let indexOpensAt = Date.now() + EMBED_BACKFILL_DELAY_MS;
  const sqliteStoreId = storeIdentity({ kind: 'sqlite', path: join(userData, 'state.db') });
  const startSqliteHistory = async (): Promise<void> => {
    openDb(userData);
    await startStateWrites();
    // Recorded only now that perf is up, each with its own measured times.
    onStateOpenStats((s) => perfRecordSpan('claude_fleet.db.open', s.openedAt, s.openedAt + s.openMs, {
      wal_bytes: s.walBytes, wal_frames: s.walFrames, handed_off: s.handedOff, worker_ready: s.workerReady ?? -1,
      first_write_ms: s.firstWriteMs ?? -1, first_write_after_ms: s.firstWriteAt === null ? -1 : s.firstWriteAt - s.openedAt,
      cache_kib: s.cacheKib, mmap_size: s.mmapBytes,
    }), DB_OPEN_ROW_FALLBACK_MS);
    void stateLeftoverDrain()?.then((r) => perfRecordSpan('claude_fleet.db.wal_drain', r.startedAt, r.startedAt + r.ms, {
      ok: r.ok, rounds: r.rounds, wal_log: r.log ?? -1, wal_ckpt: r.checkpointed ?? -1, wal_busy: r.busy ?? -1, ...(r.error ? { error: r.error } : {}),
    }));
    startStateRetention();
  };
  const startSqliteIngest = async (watcher: JsonlWatcher, embedFn: EmbedFn): Promise<void> => {
    indexOpensAt = Date.now() + EMBED_BACKFILL_DELAY_MS;
    await startWatcher(watcher, sqliteManifests);
    await startCaptureScheduler(watcher);
    registerLocalDirs(watcher, sqliteManifests);
    startEmbedBackfill(embedFn, sqliteStoreId);
  };
  if (jsonlWatcher) {
    if (sqlite && !historyAfterVacuum) await startSqliteHistory();
    // Read-only MCP server over <userData>/mcp.sock so in-container claude can
    // read history (sessions/events/cost): its own read-only state.db
    // connection on SQLite; on Postgres the history tools wait for setReadSource.
    perfSpan('claude_fleet.boot.mcp_server', () => startMcpServer(userData, sqlite ? {} : { readSource: null }));
    // Local embedder for semantic transcript search (native onnxruntime-node, on-host).
    const embedFn = makeEmbedder(join(userData, 'models'));
    embed = embedFn;
    setQueryEmbedder(embedFn);
    setFederatedEmbedder(embedFn);

    if (sqlite && inboxStore) startClaims(inboxStore, embedFn);

    // Index new turns/summaries as they land. Fire-and-forget: indexing must
    // never block ingest, and a failure degrades search silently (logged).
    // Boot ingest is left to the deferred backfill, so the first embed (and on
    // the fallback path, the in-process model load) stays out of startup.
    jsonlWatcher.on('ingest', ({ sessionId }) => {
      if (Date.now() < indexOpensAt) return;
      indexSessionTurns(sessionId, embedFn).catch((e) =>
        logError({ source: 'main', level: 'warn', type: 'transcript-index', message: String(e) }));
    });
    jsonlWatcher.on('ingest', () => {
      if (Date.now() < indexOpensAt) return;
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
    sqliteManifests = manifests;
    if (sqlite && !historyAfterVacuum) {
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
    if (sqlite && !historyAfterVacuum) startEmbedBackfill(embedFn, sqliteStoreId);
  }

  if (!sqlite) {
    const pgCfg = storeCfg as PostgresStoreConfig | ManagedStoreConfig;
    const docker = pgCfg.kind === 'managed' ? dockerodeManagedDocker() : null;
    managedDocker = docker;
    const resolveCfg = (progress?: (message: string) => void): Promise<PostgresStoreConfig> =>
      pgCfg.kind === 'managed'
        ? ensureManagedPostgres({
          docker: docker!,
          password: {
            get: () => getSecret(MANAGED_STORE_SCOPE, MANAGED_STORE_PASSWORD_KEY),
            set: (v) => setSecret(MANAGED_STORE_SCOPE, MANAGED_STORE_PASSWORD_KEY, v),
          },
          onProgress: progress,
        }, pgCfg.poolMax)
        : Promise.resolve(pgCfg);
    let openedPort: number | null = null;
    const openStores = async (progress?: (message: string) => void): Promise<PgStores> => {
      const cfg = await resolveCfg(progress);
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
    let manifests: WorkspaceSpec[] = [];
    // Inbox steps first, so a history failure leaves the inbox up; each is retried until it succeeds.
    const services = new ServiceSteps<PgStores>([
      { name: 'claims', group: 'inbox', run: (s) => { if (embed) startClaims(s.inbox, embed); } },
      { name: 'inbox-services', group: 'inbox', run: (s) => startInboxServices(s.inbox) },
      { name: 'presence', group: 'inbox', run: () => { if (mainWindow) startPresenceServices(mainWindow); } },
      { name: 'inbox-counts', group: 'inbox', run: (s) => broadcastCounts(s.inbox) },
      // After the copy: openDbPostgres rehydrates pendingClaudeIds from the copied rows.
      { name: 'state-db', group: 'history', run: (s) => openDbPostgres(s.pool, { migrate: false, afterBeginWrite: historyGate.hook }) },
      { name: 'state-writes', group: 'history', run: () => startStateWrites() },
      {
        name: 'read-source', group: 'history', run: async (s) => setReadSource(await openPgMcpReadSource(schemaOf(s.pool), s.poolConfig, (message) =>
          logError({ source: 'main', type: 'mcp-query-isolation', level: 'warn', message }))),
      },
      {
        name: 'watcher', group: 'history', run: async () => {
          if (!jsonlWatcher) return;
          manifests = (await listWorkspaceManifests()).filter((m) => m.kind !== 'remote');
          await startWatcher(jsonlWatcher, manifests);
        },
      },
      { name: 'local-dirs', group: 'history', run: () => { if (jsonlWatcher) registerLocalDirs(jsonlWatcher, manifests); } },
      {
        name: 'embed-backfill', group: 'history', run: (s) => {
          const c = s.poolConfig;
          if (embed) startEmbedBackfill(embed, storeIdentity({ kind: 'postgres', host: c.host, port: c.port, database: c.database, connectionString: c.connectionString, schema: c.schema }));
        },
      },
      { name: 'retention', group: 'history', after: ['watcher'], run: () => startStateRetention() },
      { name: 'capture-scheduler', group: 'inbox', after: ['claims', 'watcher'], run: () => (jsonlWatcher ? startCaptureScheduler(jsonlWatcher) : undefined) },
    ]);
    /** Refuse new inbox and history writes, stop the timers that write, and wait for writes in flight. */
    const quiesceStores = async (stores: PgStores): Promise<void> => {
      inboxGate.close('The inbox is moving to SQLite; try again in a moment.');
      historyGate.close('History is moving to SQLite; try again in a moment.');
      stopInboxWriters();
      await retention?.stop();
      retention = null;
      await inboxGate.drain(stores.inbox.kysely);
      let state: ReturnType<typeof stateKysely> | null = null;
      try {
        state = stateKysely();
      } catch {
        // history never opened: nothing to drain
      }
      if (state) await historyGate.drain(state);
    };
    /** A failed switch back: the same writers start again on Postgres. Not
     *  re-registered: that would recover() and cut short the runs in progress. */
    const resumeWriters = async (): Promise<void> => {
      if (shuttingDown) return;
      inboxGate.open();
      historyGate.open();
      startStateRetention();
      notifySvc?.resume();
      auto?.resume();
      captureScheduler?.resume();
      await supervisor?.restartServices();
      replayInputWait();
      jsonlWatcher?.requeueAll();
    };
    const sup = new StoreSupervisor<PgStores>({
      choice: storeChoiceOf(storeCfg) as 'managed' | 'external',
      open: openStores,
      prepare: (stores, onProgress) => firstSwitchCopy({ pool: stores.pool, userData, state: true, onProgress }),
      ready: async (stores) => {
        pgStores = stores;
        inboxStore = stores.inbox;
        await services.run(stores);
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
      exclusive: (fn) => sup.exclusive(fn),
      plan: () => switchBackPlan(userData),
      postgresInboxLive: () => inboxOnPostgres(userData),
      open: () => openStores(),
      close: closeStores,
      quiesce: quiesceStores,
      automationRunning: () => auto?.automations.hasActiveRuns() ?? false,
      copy: (stores, commit) => switchBackToSqlite({ pool: stores.pool, userData, commit, onProgress: () => undefined }),
      commit: () => setStoreChoice('sqlite'),
      resume: resumeWriters,
      stopBringUp: () => sup.stop(),
      // History must not reach Postgres after the user-state merge back: restart on SQLite now.
      relaunch: () => {
        if (shuttingDown) return;
        app.relaunch();
        app.quit();
      },
    }));
    sup.on('status', (s: StoreStatus) => broadcastStoreStatus(s, BrowserWindow.getAllWindows()));
  } else {
    if (inboxElsewhere) logError({ source: 'main', type: 'inbox-on-postgres', level: 'warn', message: inboxElsewhere });
    setActiveStore('sqlite', inboxElsewhere
      ? () => ({ choice: 'sqlite', phase: 'ready', detail: inboxElsewhere, progress: null, notice: inboxElsewhere })
      : undefined);
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
  if (historyAfterVacuum && jsonlWatcher && embed) {
    const watcher = jsonlWatcher;
    const embedFn = embed;
    void (async () => {
      const waited = await waitForVacuumHelper(userData, { shouldStop: () => shuttingDown });
      logError({ source: 'main', level: waited === 'lingering' ? 'warn' : 'info', type: 'vacuum-wait', message: `vacuum helper: ${waited}` });
      // A quit during the wait has closed (or is closing) the store.
      if (shuttingDown) return;
      // It may still hold the write lock: every write would block main for busy_timeout, then fail.
      if (waited === 'lingering') {
        logError({ source: 'main', level: 'warn', type: 'history-start', message: 'vacuum helper still running; history unavailable this session' });
        return;
      }
      await startSqliteHistory();
      if (shuttingDown) return;
      await startSqliteIngest(watcher, embedFn);
    })().catch((e) => logError({ source: 'main', type: 'history-start', level: 'error', message: String(e) }));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      attachKeepRunning(mainWindow, () => presence?.hasTray() ?? false);
    }
  });
});

// Electron doesn't await before-quit (#485): hold the quit, shut down within
// QUIT_BOUND_MS, then exit. A second quit while that runs passes through.
app.on('before-quit', (e) => {
  if (shuttingDown) return;
  shuttingDown = true;
  e.preventDefault();
  markQuitting();
  supervisor?.stop();
  let vacuumAfterQuit = false;
  let stateClosed = false;
  void withinMs((async () => {
    // Let a bring-up step or a switch back in flight finish first.
    if (supervisor) await withinMs(supervisor.exclusive(async () => undefined), QUIT_BOUND_MS / 2);
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
    await retention?.stop();
    retention = null;
    await jsonlWatcher?.stop();
    await peerStatusWatcher?.stop();
    stopMcpServer();
    await inboxStore?.close();
    inboxStore = null;
    await shutdownPerf();
    await withinMs(errorRows.flush(), ERROR_ROWS_QUIT_MS);
    vacuumAfterQuit = await prepareVacuum(app.getPath('userData')).catch(() => false);
    await closeDb();
    stateClosed = true;
    await pgStores?.end();
    pgStores = null;
    if (managedDocker) await stopManagedPostgres(managedDocker);
  })().catch((err) => logError({ source: 'main', type: 'quit-shutdown', level: 'warn', message: String(err) })), QUIT_BOUND_MS)
    .then(() => {
      if (vacuumAfterQuit && stateClosed) spawnVacuumHelper(app.getPath('userData'));
      flushErrorLogSync();
      app.exit(0);
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
