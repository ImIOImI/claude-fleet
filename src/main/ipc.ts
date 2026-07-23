import { app, ipcMain, BrowserWindow, dialog, clipboard, Menu, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink, readdir } from 'node:fs/promises';
import { workspaceTranscriptPath, workspaceHistoryFile, workspaceHistoryDir } from './paths.js';
import {
  setWorkspaceDefault,
  setSessionOverride,
  learnMapping as learnMirrorMapping
} from './mirrorPolicy.js';
import { openHostPath } from './openHostPath.js';
import {
  getFleetRoot,
  setFleetRoot,
  fleetPrivateDir,
  fleetSharedDir,
  getHardwareAccelDisabled,
  setHardwareAccelDisabled,
  getAutoReloadLoadouts,
  setAutoReloadLoadouts,
  getUsageBudget,
  setUsageBudget,
  USAGE_BUDGET_WINDOW_HOURS,
  type UsageBudgetPreset,
  setFavorite,
  resolveWorkspaceConfig
} from './config.js';
import { buildLoadoutCatalog } from './loadoutCatalog.js';
import * as realDocker from './docker.js';
import * as realLocal from './local.js';
import * as mockDocker from './mock.js';
import type { Backend } from './backend.js';
import { resolveKind } from './backendRouter.js';
import { assertControl, buildRoster, ROSTER_TITLE_MAX, type RosterStatus, type RosterEntry } from './control.js';
import { ActivityDetector } from './activityDetector.js';
import { wouldExceed, recordPost, COMMITTEE_CAPS } from './committeeRuns.js';
import {
  ensureWorkspaceSocket,
  removeWorkspaceSocket,
  setCommitteeHandlers,
  setReadScopeResolver,
  setInputWaitHandler,
  setSessionMappingHandler,
  setUsageRecorder,
  setConfigResolver,
  currentMcpStatus
} from './mcpServer.js';
import * as vault from './vault.js';
import * as fs from './fs.js';
import * as imageLibrary from './imageLibrary.js';
import * as files from './files.js';
import * as loadouts from './loadouts.js';
import * as loadoutSources from './loadoutSources.js';
import { ensureAndInstall } from './loadoutInstall.js';
import { loadoutDir } from './paths.js';
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
  type AuthMode,
  type WorkspaceMirror,
  type WorkspaceKind,
  FACTORY_MIRROR
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
  lookupVerifiedBrokerSession,
  listSessions,
  renameSession,
  deleteSession,
  tokensSpentSince,
  recordUsageEvent,
} from './db.js';
import { logError, getLogPath } from './errorLog.js';
import { broadcastObservabilitySummary } from './observabilityBroadcast.js';
import { broadcastInputWait } from './inputWaitBroadcast.js';
import { consumeForWorkspace, pendingSnapshotForWorkspace, recordPendingAttach } from './pendingAttaches.js';
import { PortForwardManager } from './portforward.js';
import { brokerEndpoint } from './docker.js';
import { BrokerClient } from './broker.js';
import { MCP_TCP_PORT } from './mcpSocket.js';
import { injectAndSubmit } from './ptyInput.js';

export const MOCK_MODE = process.env.CLAUDE_FLEET_MOCK === '1';

const isWindows = process.platform === 'win32';
// Infra ports we must never offer as dev-server previews.
// 7070: the broker's own loopback-TCP listener on Windows (see docker.ts
//   BROKER_TCP_PORT) — this is the load-bearing exclusion; it appears in
//   the container's LISTEN table only on Windows.
// MCP_TCP_PORT (7071): defensive belt-and-suspenders. The container reaches
//   the host MCP server via an OUTBOUND connection → ESTABLISHED, which the
//   /proc/net/tcp scanner already filters out, so 7071 never appears in the
//   LISTEN scan. Kept here in case that assumption ever changes.
const INFRA_PORTS = isWindows ? [7070, MCP_TCP_PORT] : [];

/** Tell every window a forwardable dev-server port appeared (toast cue). */
function broadcastPortDetected(workspaceId: string, port: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('ports:detected', { workspaceId, port });
    } catch {
      /* frame disposed mid-send */
    }
  }
}

// Real-backend only: in mock mode there is no broker to poll, so detection is
// driven by the e2e test-only handler below and `ports:open` returns a stub.
const portForward: PortForwardManager | null = MOCK_MODE
  ? null
  : new PortForwardManager({
      resolveEndpoint: brokerEndpoint,
      makeClient: (ep) => new BrokerClient(ep),
      onDetected: broadcastPortDetected,
      excludePorts: () => INFRA_PORTS
    });

// Per-workspace backend dispatch (#16). A workspace's `kind` decides whether
// it's a Docker container or a host process; the two backends share the
// `Backend` contract. In mock mode everything routes to the mock backend.
const dockerBackend: Backend = MOCK_MODE ? mockDocker : realDocker;
const localBackend: Backend = MOCK_MODE ? mockDocker : realLocal;

function backendForKind(kind: WorkspaceKind): Backend {
  if (MOCK_MODE) return mockDocker;
  return kind === 'local' ? localBackend : dockerBackend;
}

async function backendFor(idOrContainerId: string): Promise<Backend> {
  if (MOCK_MODE) return mockDocker;
  return backendForKind(await resolveKind(idOrContainerId));
}

const ptySessions = new Map<string, PtyHandle>();
// ptyHandleId → owning workspace id. Lets committee `post` (#120) reuse a live
// renderer attachment instead of opening a competing one (the broker is
// one-writer-per-session, so a second attach to an already-viewed expert is
// rejected `already attached`). Populated/cleared alongside ptySessions.
const handleWorkspaceId = new Map<string, string>();
// Host-side busy/idle per workspace (#121), computed in main from the broker
// output stream (not lifted from the renderer). `since` is the host-clock ms at
// the last busy↔idle flip — used to detect a stalled (busy-too-long) expert.
const committeeBusy = new Map<string, { busy: boolean; since: number }>();

// Dedupe set so the per-tab summary lookup (polled on every observability push)
// records each unresolved (workspace:tab:outcome) only once per run.
const mappingUnresolvedSeen = new Set<string>();

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
  workspaceSubdir: string;
  kind?: 'container' | 'local';
  /** Local workspaces only (#16): the user-chosen host directory to run in. */
  workspaceRoot?: string;
  image?: string;
  authMode: AuthMode;
  env: WorkspaceEnv;
  resources?: WorkspaceResources;
  mirror?: WorkspaceMirror;
}

/**
 * Merge the live-workspace list (from the backend) with on-disk manifests
 * (from workspaces.ts) into a single Workspace[]. Live entries take
 * precedence for state/status; manifests provide the user-facing fields
 * (description/labels/color/env/etc.) that don't live on the container.
 */
async function listAllWorkspaces(): Promise<Workspace[]> {
  const [dockerLive, localLive, manifests] = await Promise.all([
    dockerBackend.listLiveWorkspaces(),
    localBackend.listLiveWorkspaces(),
    listWorkspaceManifests()
  ]);
  // Dedup by id: real backends return disjoint sets (a workspace is on exactly
  // one), so this is a no-op there; in mock mode both `dockerBackend` and
  // `localBackend` are the same mock module, so this collapses the duplicate.
  const liveById = new Map<string, Workspace>();
  for (const w of [...dockerLive, ...localLive]) if (!liveById.has(w.id)) liveById.set(w.id, w);
  const live = [...liveById.values()];
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
      // Container: workspaceRoot is always the canonical private folder derived
      // from the fleet root + id — never trust stale labels/manifests (a
      // container created before the fleet-root migration still carries the old
      // path). Local: the user picked an existing host dir, so honor the
      // manifest's workspaceRoot (#16).
      workspaceRoot:
        w.kind === 'local'
          ? m?.workspaceRoot ?? w.workspaceRoot
          : await fleetPrivateDir(w.id),
      workspaceSubdir: w.workspaceSubdir || m?.workspaceSubdir || '',
      authMode: m?.authMode ?? w.authMode,
      env: m?.env ?? w.env,
      resources: m?.resources,
      mirror: m?.mirror ?? FACTORY_MIRROR,
      // Installed loadouts live only on the manifest (#16-followup) — carry
      // them onto the merged workspace so the Library can show installed state.
      installedLoadouts: m?.installedLoadouts ?? [],
      // Committee grants/opt-in live only on the manifest (#118) — carry them
      // through so chips show the manager/wifi glyphs and the grant matrix
      // reflects current state.
      control: m?.control,
      accessibility: m?.accessibility,
      createdAt: m?.createdAt ?? w.createdAt,
      lastUsedAt: m?.lastUsedAt ?? w.lastUsedAt
    });
    manifestById.delete(w.id);
  }

  // Manifests with no live container → deleted (recoverable from spec)
  for (const m of manifestById.values()) {
    result.push({ ...m, workspaceRoot: await fleetPrivateDir(m.id), state: 'deleted' });
  }

  return result;
}

// ── Cross-workspace committee control (#119) ───────────────────────────────
// The single place pause/unpause effects are performed, shared by the MCP
// tools (caller id from the per-workspace socket) and the committee IPC
// channels (caller id supplied by the host UI — the human operator, who is the
// ultimate authority and can already edit manifests directly). Both go through
// `assertControl` first, so authorization is identical on either path.

/** Pause a reachable, granted expert. Resolves its live containerId from the
 *  merged list (pauseWorkspace is keyed by containerId, not workspace id). */
async function committeePause(callerId: string, targetId: string): Promise<{ id: string; paused: true }> {
  await assertControl(callerId, targetId, 'pause');
  const target = (await listAllWorkspaces()).find((w) => w.id === targetId);
  if (!target?.containerId) {
    throw new Error(`target ${targetId} has no live container to pause`);
  }
  await backendForKind(target.kind).pauseWorkspace(target.containerId);
  return { id: targetId, paused: true };
}

/** Unpause (or cold-start) a granted expert, returning only once its broker is
 *  servicing RPCs again so a later `post` (#120) can't land in a frozen broker. */
async function committeeUnpause(callerId: string, targetId: string): Promise<{ id: string; running: true }> {
  await assertControl(callerId, targetId, 'pause');
  const kind = await resolveKind(targetId);
  const containerId = await backendForKind(kind).startWorkspace(targetId);
  if (!containerId) {
    throw new Error(`target ${targetId} has no container to unpause (it may need recreation)`);
  }
  // Real docker only — mock/local have no in-container broker to wait on.
  if (!MOCK_MODE && kind === 'container') {
    await realDocker.waitForBrokerReady(targetId);
  }
  return { id: targetId, running: true };
}

/** Find a live renderer PtyHandle for a workspace, if one is attached. */
function liveHandleForWorkspace(workspaceId: string): PtyHandle | null {
  for (const [handleId, wsId] of handleWorkspaceId) {
    if (wsId === workspaceId) {
      const h = ptySessions.get(handleId);
      if (h) return h;
    }
  }
  return null;
}

/**
 * Inject a message into a granted, reachable expert's live session (#120) —
 * the same fire-and-forget path as a human keystroke.
 *
 * The broker is **one-writer-per-session**, and the renderer always-mounts +
 * auto-attaches every running workspace — so for an expert visible in this app
 * the renderer already holds the writer, and a competing attach is rejected
 * `already attached` (verified against a real container). So we **reuse the
 * live renderer attachment** when present (writing to its stream === sending
 * INPUT on the host channel; the human watching that tab sees the injection).
 * Only a truly headless expert (no renderer attached) falls back to the
 * backend's transient attach.
 */
/** Target workspace ids a manager currently holds any grant over. */
async function managerGrantedTargets(managerId: string): Promise<string[]> {
  const m = await readWorkspaceManifest(managerId);
  return (m?.control?.canControl ?? []).map((g) => g.id);
}

/**
 * Workspaces `callerId` may READ under scoped reads (#122): always its own, plus
 * any target it holds a `read` grant over that also passes `assertControl`
 * (i.e. the target opted in + accepts this caller). Injected into the MCP server
 * so the read tools can filter; kept here because it needs the control graph.
 */
async function allowedReadWorkspaces(callerId: string): Promise<string[]> {
  const ids = new Set<string>([callerId]); // a workspace can always read itself
  const caller = await readWorkspaceManifest(callerId);
  for (const g of caller?.control?.canControl ?? []) {
    if (!g.verbs.includes('read')) continue;
    const checkStart = Date.now();
    try {
      await assertControl(callerId, g.id, 'read');
      ids.add(g.id);
    } catch {
      /* grant present but target not currently reachable/accepting — exclude */
    } finally {
      // Per-grant timing: the MCP first-call hang presents as callTool stuck
      // in resolve-allowed; this pins the stall to a specific grant target.
      const checkMs = Date.now() - checkStart;
      if (checkMs >= 1_000) {
        logError({
          source: 'main',
          type: 'grant-check-slow',
          level: 'warn',
          message: `assertControl(${callerId} → ${g.id}, read) took ${checkMs}ms during MCP scope resolution`,
          workspaceId: callerId,
          extra: { targetId: g.id, checkMs }
        });
      }
    }
  }
  return [...ids];
}

/** Host-initiated force-pause of a set of experts (bypasses assertControl — the
 *  host is enforcing a budget, not a manager acting). Best-effort per target. */
async function forcePauseExperts(ids: string[]): Promise<void> {
  const all = await listAllWorkspaces();
  await Promise.all(
    ids.map(async (id) => {
      const t = all.find((w) => w.id === id);
      if (t?.containerId) await backendForKind(t.kind).pauseWorkspace(t.containerId).catch(() => undefined);
    })
  );
}

async function committeePost(
  callerId: string,
  targetId: string,
  msg: string
): Promise<{ id: string; via: 'attached' | 'headless'; brokerSessionId?: string }> {
  await assertControl(callerId, targetId, 'post');

  // Per-expert turn timeout (#121): refuse to pile onto a stuck expert (busy
  // far longer than a turn should take) instead of letting it hang the loop.
  const b = committeeBusy.get(targetId);
  if (b?.busy && Date.now() - b.since > COMMITTEE_CAPS.turnTimeoutMs) {
    throw new Error(
      `expert ${targetId} appears stuck (busy ${Math.round((Date.now() - b.since) / 1000)}s); ` +
        `pause/unpause it before posting`
    );
  }

  // Host-enforced runaway guard (#121): if this post would breach the run's
  // post cap, force-pause every expert this manager controls and refuse — a
  // looping manager can't talk past this. There is no dollar cost cap; committee
  // experts run without a spend ceiling.
  const verdict = wouldExceed(callerId);
  if (verdict.exceeded) {
    await forcePauseExperts(await managerGrantedTargets(callerId));
    throw new Error(`committee run halted: ${verdict.reason}. All experts paused.`);
  }
  recordPost(callerId);

  const live = liveHandleForWorkspace(targetId);
  if (live) {
    await injectAndSubmit((chunk) => live.stream.write(chunk), msg);
    broadcastCommitteeInbound(targetId, msg);
    return { id: targetId, via: 'attached' };
  }
  const kind = await resolveKind(targetId);
  const { brokerSessionId } = await backendForKind(kind).committeePost(targetId, msg);
  broadcastCommitteeInbound(targetId, msg);
  return { id: targetId, via: 'headless', brokerSessionId };
}

/** Tell the renderer a committee message was injected into `workspaceId` so the
 *  expert's tab can show a `[committee]` toast (#123) — the awareness cue, since
 *  the injected text otherwise appears in a watched tab unlabeled. */
function broadcastCommitteeInbound(workspaceId: string, message: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('committee:inbound', { workspaceId, message });
    } catch {
      /* frame disposed mid-send */
    }
  }
}

/** One committee `collect` turn — a user/assistant transcript line, decoded. */
interface CollectTurn {
  id: number;
  ts: number | null;
  role: string;
  text: string;
}

/** Pull the human-readable text out of one claude JSONL line. */
function extractTurnText(rawJsonl: string): string {
  try {
    const o = JSON.parse(rawJsonl) as { message?: { content?: unknown } };
    const content = o.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((b) => {
          if (typeof b === 'string') return b;
          const block = b as { type?: string; text?: string; name?: string };
          if (block.type === 'text') return block.text ?? '';
          if (block.type === 'tool_use') return `[tool_use: ${block.name ?? '?'}]`;
          if (block.type === 'tool_result') return '[tool_result]';
          return '';
        })
        .join('')
        .trim();
    }
  } catch {
    /* malformed line — no text */
  }
  return '';
}

/**
 * Read new transcript turns from a granted expert (#120), cursored by the
 * autoincrement `events.id` (NOT `ts` — `ts` is nullable and is claude's clock;
 * skew/null would scramble a time window). Resolves the expert's most-recently-
 * active session from the DB (v1 single-tab experts ⇒ that's the live one);
 * never reaches the broker, so it works whether or not anyone is attached.
 */
async function committeeCollect(
  callerId: string,
  targetId: string,
  since: number
): Promise<{ id: string; sessionId: string | null; cursor: number; turns: CollectTurn[] }> {
  await assertControl(callerId, targetId, 'read');
  const sessionId = listSessions(targetId)[0]?.id ?? null;
  if (!sessionId) return { id: targetId, sessionId: null, cursor: since, turns: [] };
  const events = eventsForSession(sessionId, since, 500);
  const cursor = events.length ? events[events.length - 1].id : since;
  const turns = events
    .filter((e) => e.type === 'assistant' || e.type === 'user')
    .map((e) => ({ id: e.id, ts: e.ts, role: e.type, text: extractTurnText(e.rawJsonl) }))
    .filter((t) => t.text.length > 0);
  return { id: targetId, sessionId, cursor, turns };
}

/**
 * Liveness for an expert (#121): `busy` is host-computed from the broker output
 * stream (renderer-independent); `stalled` = busy past the turn timeout (the
 * "it's wedged" signal); `lastActiveAt` is best-effort from the DB (null when the
 * DB isn't open). Shared by committee_status and committee_roster.
 */
function liveStatusFields(targetId: string, paused: boolean): RosterStatus {
  const b = committeeBusy.get(targetId);
  const busy = b?.busy ?? false;
  const stalled = busy && b ? Date.now() - b.since > COMMITTEE_CAPS.turnTimeoutMs : false;
  let lastActiveAt: number | null = null;
  try {
    lastActiveAt = listSessions(targetId)[0]?.lastActiveAt ?? null;
  } catch {
    /* DB not open (mock) — leave null */
  }
  return { paused, busy, stalled, lastActiveAt };
}

/**
 * An expert's metadata + liveness for a manager holding a `read` grant. The
 * descriptive fields (name/description/labels/roleHint/loadout titles) are data
 * for the manager to read, never instructions; titles are capped (untrusted OCI
 * text).
 */
async function committeeStatus(
  callerId: string,
  targetId: string
): Promise<
  RosterStatus & {
    id: string;
    name: string;
    description?: string;
    labels: string[];
    roleHint?: string;
    installedLoadouts: { id: string; title: string }[];
  }
> {
  await assertControl(callerId, targetId, 'read');
  const ws = (await listAllWorkspaces()).find((w) => w.id === targetId);
  return {
    id: targetId,
    name: ws?.name ?? targetId,
    description: ws?.description,
    labels: ws?.labels ?? [],
    roleHint: ws?.accessibility?.roleHint,
    installedLoadouts: (ws?.installedLoadouts ?? []).map((l) => ({
      id: l.id,
      title: l.title.slice(0, ROSTER_TITLE_MAX)
    })),
    ...liveStatusFields(targetId, ws?.state === 'paused')
  };
}

/**
 * Discovery: every expert that has opted in to this manager (reachable AND names
 * it in `acceptFrom`), with metadata + liveness + whether the manager holds a
 * grant. Reads the merged workspace list fresh (no cached authority), so opt-out
 * / acceptFrom edits take effect on the next call. Gate logic lives in
 * `control.ts:decideRoster`; this only supplies I/O (the candidate list + live
 * status). Requires no grant — that's the deliberate discovery widening.
 */
async function committeeRoster(callerId: string): Promise<RosterEntry[]> {
  const all = await listAllWorkspaces();
  const caller = all.find((w) => w.id === callerId) ?? null;
  const stateById = new Map(all.map((w) => [w.id, w.state]));
  return buildRoster(caller, callerId, all, (id) => liveStatusFields(id, stateById.get(id) === 'paused'));
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
      const queued = pendingSnapshotForWorkspace(workspaceId);
      const brokerSessionId = consumeForWorkspace(workspaceId);
      if (!brokerSessionId) {
        logError({
          source: 'main',
          type: 'new-session-dropped',
          level: 'info',
          message: `new-session for ${claudeSessionId} had no pending attach to pair with`,
          workspaceId,
          extra: { claudeSessionId }
        });
        return;
      }
      const previous = learnBrokerSessionMapping(workspaceId, brokerSessionId, claudeSessionId);
      // Every learn leaves a trace; the two warn cases are the #195 evidence
      // trail — a FIFO consume that had to guess between tabs, and a mapping
      // silently flipping to a different claude session.
      if (queued.length > 1) {
        logError({
          source: 'main',
          type: 'mapping-ambiguous-consume',
          level: 'warn',
          message: `paired ${claudeSessionId} with broker ${brokerSessionId} by FIFO with ${queued.length} tabs pending — pairing is a guess`,
          workspaceId,
          extra: { claudeSessionId, consumed: brokerSessionId, queued }
        });
      } else {
        logError({
          source: 'main',
          type: 'mapping-learned',
          level: 'info',
          message: `paired ${claudeSessionId} with broker ${brokerSessionId}`,
          workspaceId,
          extra: { claudeSessionId, consumed: brokerSessionId }
        });
      }
      if (previous && previous !== claudeSessionId) {
        logError({
          source: 'main',
          type: 'mapping-remapped',
          level: 'warn',
          message: `broker ${brokerSessionId} remapped ${previous} → ${claudeSessionId}; a tab Refresh will now resume a different conversation`,
          workspaceId,
          extra: { brokerSessionId, from: previous, to: claudeSessionId }
        });
      }
      // Propagate any pending per-session mirror override onto the claude id.
      learnMirrorMapping(workspaceId, brokerSessionId, claudeSessionId);
    });
  }

  // Docker-daemon reachability (drives the #23 indicator) and image pulls are
  // Docker-specific; local workspaces need neither.
  ipcMain.handle('workspace:ping', () => dockerBackend.ping());
  ipcMain.handle('workspace:ensureImage', async (event, channelId: string, image?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    await dockerBackend.ensureImage((p) => {
      win?.webContents.send(`workspace:ensureImage:progress:${channelId}`, p);
    }, image);
  });

  ipcMain.handle('workspace:list', async () => {
    const all = await listAllWorkspaces();
    // Keep the watcher's per-workspace mirror default fresh (cheap; runs on
    // the renderer's 5s poll, so manifest edits propagate without a restart).
    for (const w of all) setWorkspaceDefault(w.id, w.mirror.default);
    // Keep a port-detection monitor running for each live container workspace.
    // Reconciling here (the renderer polls workspace:list) covers start, pause,
    // stop, remove, and app launch without per-action hooks.
    portForward?.reconcile(
      all.filter((w) => w.state === 'running' && w.kind !== 'local').map((w) => w.id)
    );
    return all;
  });

  ipcMain.handle(
    'workspace:create',
    async (_e, input: WorkspaceCreatePayload) => {
      const kind: WorkspaceKind = input.kind ?? 'container';
      // Local workspaces run `claude` in a user-chosen host directory; validate
      // it here (the renderer also checks) so a bad path fails fast and clearly.
      if (kind === 'local') {
        const root = input.workspaceRoot?.trim();
        if (!root) {
          throw new Error('Pick a working directory for the local workspace.');
        }
        if (!(await fs.isDirectory(root))) {
          throw new Error(`Working directory does not exist: ${root}`);
        }
      }
      // Name-uniqueness is checked here (and not in the renderer alone) so
      // a stale list doesn't allow duplicates through.
      const existing = await findWorkspaceByName(input.name);
      if (existing && existing.id !== input.id) {
        throw new Error(`A workspace named "${input.name}" already exists.`);
      }

      // Bring up this workspace's per-id MCP listener (#117) before the backend
      // creates it: a local workspace's createWorkspace wires its --mcp-config
      // off the live socket, and a container's reconnecting socat bridge wants
      // the socket present as soon as it starts.
      ensureWorkspaceSocket(input.id);

      const ws = await backendForKind(kind).createWorkspace({
        id: input.id,
        name: input.name,
        workspaceSubdir: input.workspaceSubdir,
        env: input.env,
        image: input.image,
        resources: input.resources,
        authMode: input.authMode,
        kind,
        workspaceRoot: input.workspaceRoot
      });

      const spec: WorkspaceSpec = {
        id: input.id,
        name: input.name,
        description: input.description,
        labels: input.labels ?? [],
        color: input.color,
        // Container: the backend derived the private folder from the fleet root.
        // Local: it's the user-chosen host dir the backend echoed back.
        workspaceRoot: ws.workspaceRoot,
        workspaceSubdir: input.workspaceSubdir,
        kind,
        image: ws.image,
        authMode: input.authMode,
        env: input.env,
        resources: input.resources,
        mirror: input.mirror ?? FACTORY_MIRROR,
        createdAt: ws.createdAt,
        lastUsedAt: ws.lastUsedAt
      };
      await writeWorkspaceManifest(spec);
      setWorkspaceDefault(spec.id, spec.mirror.default);
      jsonlWatcher?.registerWorkspace(input.id);

      // Auto-record the image into the library so the next create's
      // picker shows it (and any labels it was built with). Best-effort:
      // a failed inspect (image just pulled but inspect bombs) shouldn't
      // fail the workspace create.
      if (ws.image) {
        try {
          const inspected = await dockerBackend.inspectImage(ws.image);
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

  // ── Sessions table (#3) ──────────────────────────────────────────────
  // Global, container-filterable list of past claude sessions. Eligibility
  // (hiding sessions whose workspace was deleted) is enforced here because
  // the DB layer doesn't know about on-disk manifests. Each row is overlaid
  // with its workspace's display name / color / state so the renderer can
  // group and label without a second round-trip.
  ipcMain.handle('sessions:list', async (_e, workspaceId?: string) => {
    const all = await listAllWorkspaces();
    const byId = new Map(all.map((w) => [w.id, w]));
    const rows = listSessions(workspaceId);
    return rows.flatMap((r) => {
      const w = byId.get(r.workspaceId);
      // Eligibility: show a session iff its workspace still exists (manifest
      // present). A truly-deleted workspace (manifest removed) drops out of
      // listAllWorkspaces entirely, so `!w` filters it. A closed-but-kept
      // workspace keeps its manifest and shows here with state 'deleted'
      // (no live container) — still browsable/renamable/deletable, and
      // resume attempts to bring its container up (gracefully no-ops if it
      // can't be recreated).
      if (!w) return [];
      return [
        {
          ...r,
          workspaceName: w.name,
          workspaceColorHue: w.color?.hue ?? null,
          workspaceState: w.state,
        }
      ];
    });
  });

  ipcMain.handle('sessions:rename', (_e, sessionId: string, name: string) => {
    renameSession(sessionId, name);
  });

  // Remove a session from the cache AND delete its on-disk transcript.
  // The watcher's 'unlink' handler clears its in-memory offset state but
  // does NOT drop DB rows, so deleteSession() does that explicitly. Unlink
  // is best-effort: a missing file (already gone) is fine.
  ipcMain.handle('sessions:delete', async (_e, workspaceId: string, sessionId: string) => {
    deleteSession(sessionId);
    try {
      await unlink(workspaceTranscriptPath(workspaceId, sessionId));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logError({
          source: 'main',
          type: 'session-delete-unlink-failed',
          message: `failed to unlink transcript for ${sessionId}: ${(err as Error).message}`,
          extra: { workspaceId, sessionId }
        });
      }
    }
  });

  /**
   * Resume a past session: ensure its workspace's container is up (startWorkspace
   * unpauses a paused container, starts a stopped one, and is a no-op for a
   * running one), then hand the renderer the containerId so it can open a tab
   * that attaches with `--resume <sessionId>`. Returns null when the container
   * is gone (deleted workspace) and can't be brought up here — the renderer
   * surfaces that as a non-fatal "couldn't resume" notice.
   */
  ipcMain.handle(
    'sessions:resume',
    async (_e, workspaceId: string): Promise<{ containerId: string } | null> => {
      const containerId = await (await backendFor(workspaceId)).startWorkspace(workspaceId);
      if (!containerId) return null;
      await touchWorkspaceUsed(workspaceId);
      return { containerId };
    }
  );

  /**
   * Start an existing (live, possibly stopped) workspace by id. Returns
   * the workspace if a container with that id exists; null otherwise,
   * signalling the renderer to recreate from the saved manifest using the
   * normal create flow (which resolves vault credentials).
   */
  ipcMain.handle('workspace:start', async (_e, id: string): Promise<Workspace | null> => {
    const containerId = await (await backendFor(id)).startWorkspace(id);
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

  /**
   * Update a workspace's manifest in place without touching the container.
   * Used by the Saved-tab Resume flow to apply edited fields (description,
   * labels, env, etc.) before calling `workspace:start`. Container-level
   * edits (env values, image) won't take effect until the container is
   * restarted — see the Phase 2 *restart-to-apply* banner.
   */
  ipcMain.handle(
    'workspace:writeManifest',
    async (_e, spec: Omit<WorkspaceSpec, 'workspaceRoot'> & { workspaceRoot?: string }) => {
      // Name-uniqueness across the fleet (own row excluded).
      const clash = await findWorkspaceByName(spec.name);
      if (clash && clash.id !== spec.id) {
        throw new Error(`A workspace named "${spec.name}" already exists.`);
      }
      const existing = await readWorkspaceManifest(spec.id);
      // Container: workspaceRoot is derived — the canonical private folder under
      // the fleet root. Local (#16): it's the user-chosen host dir, supplied by
      // the renderer; fall back to the existing manifest's value if absent.
      let workspaceRoot: string;
      if (spec.kind === 'local') {
        workspaceRoot = spec.workspaceRoot?.trim() || existing?.workspaceRoot || '';
      } else {
        workspaceRoot = await fleetPrivateDir(spec.id);
      }
      // Merge OVER the existing manifest so fields the renderer doesn't manage
      // survive an edit. The edit form sends every form field (those win) but
      // omits `control` (committee grants, edited in the Committee rail #118)
      // and `installedLoadouts` (written by the loadouts engine #16); without
      // this merge a plain edit would silently wipe both. A key present in the
      // incoming spec — even set to undefined, e.g. clearing `accessibility` by
      // toggling reachability off — is authoritative and overrides existing.
      await writeWorkspaceManifest({ ...(existing ?? {}), ...spec, workspaceRoot });
    // Reflect a mirror-default edit in the watcher immediately (don't wait for
    // the next list poll).
    setWorkspaceDefault(spec.id, spec.mirror?.default ?? FACTORY_MIRROR.default);
  });

  // Per-workspace set of claude session UUIDs currently blocked on an
  // AskUserQuestion prompt (driven by the runner hook via the signal_input_wait
  // MCP tool). Pushed to renderers on every change; chips render it as "needs input".
  const inputWaitByWorkspace = new Map<string, Set<string>>();
  function pushInputWait(workspaceId: string): void {
    const set = inputWaitByWorkspace.get(workspaceId) ?? new Set<string>();
    broadcastInputWait(
      { workspaceId, waitingSessionIds: [...set] },
      BrowserWindow.getAllWindows()
    );
  }

  // Clear any "waiting on input" marks for the workspace backing this container
  // and push the cleared state, so a stopped/removed workspace's chip doesn't
  // stay violet. Best-effort: a container with no resolvable workspace is a no-op.
  async function clearInputWaitForContainer(containerId: string): Promise<void> {
    const all = await listAllWorkspaces().catch(() => []);
    const ws = all.find((w) => w.containerId === containerId);
    if (!ws) return;
    if (inputWaitByWorkspace.delete(ws.id)) pushInputWait(ws.id);
  }

  ipcMain.handle('workspace:stop', async (_e, containerId: string) => {
    await clearInputWaitForContainer(containerId);
    return (await backendFor(containerId)).stopWorkspace(containerId);
  });
  ipcMain.handle('workspace:pause', async (_e, containerId: string) => {
    await clearInputWaitForContainer(containerId);
    return (await backendFor(containerId)).pauseWorkspace(containerId);
  });
  // Committee pause/unpause (#119). `callerId` is the workspace acting as
  // manager; assertControl gates the effect. Exposed for the committee console
  // (#123); the manager's Claude reaches the same effects via the MCP tools.
  ipcMain.handle('committee:pause', (_e, callerId: string, targetId: string) =>
    committeePause(callerId, targetId)
  );
  ipcMain.handle('committee:unpause', (_e, callerId: string, targetId: string) =>
    committeeUnpause(callerId, targetId)
  );
  ipcMain.handle('committee:post', (_e, callerId: string, targetId: string, msg: string) =>
    committeePost(callerId, targetId, msg)
  );
  ipcMain.handle('committee:collect', (_e, callerId: string, targetId: string, since?: number) =>
    committeeCollect(callerId, targetId, since ?? 0)
  );
  ipcMain.handle('committee:status', (_e, callerId: string, targetId: string) =>
    committeeStatus(callerId, targetId)
  );
  ipcMain.handle('committee:roster', (_e, callerId: string) => committeeRoster(callerId));
  // Let the MCP committee_* tools reach the same effects (caller id from the
  // per-workspace socket instead of an IPC arg).
  setCommitteeHandlers({
    pause: committeePause,
    unpause: committeeUnpause,
    post: committeePost,
    collect: committeeCollect,
    status: committeeStatus,
    roster: committeeRoster
  });
  // Scoped reads (#122): teach the MCP read tools the caller's allowed set.
  setReadScopeResolver(allowedReadWorkspaces);
  setInputWaitHandler((callerId, sessionId, waiting) => {
    let set = inputWaitByWorkspace.get(callerId);
    if (!set) { set = new Set(); inputWaitByWorkspace.set(callerId, set); }
    if (waiting) set.add(sessionId); else set.delete(sessionId);
    pushInputWait(callerId);
  });
  setSessionMappingHandler((callerId, brokerSessionId, claudeSessionId) => {
    const previous = learnBrokerSessionMapping(callerId, brokerSessionId, claudeSessionId);
    if (previous && previous !== claudeSessionId) {
      logError({
        source: 'main', type: 'mapping-remapped', level: 'warn',
        message: `broker ${brokerSessionId} remapped ${previous} → ${claudeSessionId} via SessionStart hook (drift corrected)`,
        workspaceId: callerId,
        extra: { brokerSessionId, from: previous, to: claudeSessionId, how: 'session-start-hook' }
      });
    }
  });
  setUsageRecorder((e) => recordUsageEvent(e));
  setConfigResolver(async (callerId) => {
    const m = await readWorkspaceManifest(callerId);
    return resolveWorkspaceConfig(callerId, m?.env?.plain ?? {}, app.getVersion(), m?.image);
  });

  ipcMain.handle('workspace:remove', async (_e, containerId: string, opts?: RemoveWorkspaceOpts) => {
    // Clear input-wait state before removal — after removal the workspace is
    // gone from listAllWorkspaces() and clearInputWaitForContainer can't resolve it.
    await clearInputWaitForContainer(containerId);
    // A saved (no-live) workspace passes its ULID in opts.id; prefer it so the
    // kind resolves even when there's no live containerId.
    const result = await (await backendFor(opts?.id ?? containerId)).removeWorkspace(containerId, opts);
    // Tear down the per-id MCP listener + socket dir (#117). Keyed by workspace
    // id, which lives in opts.id (containerId is the Docker id). Best-effort.
    if (opts?.id) removeWorkspaceSocket(opts.id);
    return result;
  });

  ipcMain.handle('app:mockMode', () => MOCK_MODE);

  ipcMain.handle(
    'ports:open',
    async (_e, workspaceId: string, containerPort: number): Promise<{ hostPort: number }> => {
      if (!portForward) {
        // Mock mode: no real broker; hand back a deterministic stub host port
        // so the e2e can assert the round-trip without a container.
        return { hostPort: 65000 };
      }
      const { hostPort } = await portForward.openPort(workspaceId, containerPort);
      void shell.openExternal(`http://127.0.0.1:${hostPort}`);
      return { hostPort };
    }
  );

  ipcMain.handle('fs:isDirectory', (_e, path: string) => fs.isDirectory(path));
  ipcMain.handle('fs:mkdirp', (_e, path: string) => fs.mkdirp(path));

  // Reveal a host path in the OS file manager (Finder/Explorer/etc.). Returns
  // '' on success, or an error string. Under WSL `shell.openPath` can't reach a
  // GUI file manager (no xdg-open / no Linux file manager), so route through
  // explorer.exe instead. Neither path rejects — callers get a string.
  ipcMain.handle('fs:openPath', async (_e, path: string) => {
    if (typeof path !== 'string' || path.length === 0) return 'No path provided';
    return openHostPath(path);
  });

  // ── Loadout library (#16-followup) ───────────────────────────────────────
  ipcMain.handle('loadouts:list', () => loadouts.listLoadouts());
  ipcMain.handle('loadouts:get', (_e, id: string) => loadouts.getLoadout(id));
  ipcMain.handle('loadouts:install', (_e, workspaceId: string, loadoutId: string, opts?: { source?: string; version?: string; force?: boolean }) =>
    ensureAndInstall(workspaceId, loadoutId, opts ?? {})
  );
  ipcMain.handle('loadouts:uninstall', (_e, workspaceId: string, loadoutId: string) =>
    loadouts.uninstallLoadout(workspaceId, loadoutId)
  );
  // Reveal a loadout's source folder in the OS file manager (review-modal action).
  ipcMain.handle('loadouts:openFolder', async (_e, id: string) => {
    const dir = loadoutDir(id);
    return openHostPath(dir);
  });
  ipcMain.handle('loadouts:catalog', (_e, workspaceId?: string) => buildLoadoutCatalog(workspaceId));
  ipcMain.handle('loadouts:setFavorite', (_e, id: string, on: boolean) => setFavorite(id, on));
  ipcMain.handle('loadouts:listSources', () => loadoutSources.listSources());
  ipcMain.handle('loadouts:addSource', (_e, base: string) => loadoutSources.addSource(base));
  ipcMain.handle('loadouts:removeSource', (_e, base: string) => loadoutSources.removeSource(base));
  ipcMain.handle('loadouts:refreshSource', (_e, base: string) => loadoutSources.browseSource(base, { refresh: true }));

  // App-level settings. The fleet root is the single host dir holding every
  // workspace's private folder (<root>/<id>) plus the shared folder
  // (<root>/shared). `sharedDir` is returned alongside so the renderer can
  // surface a "Shared" link without recomputing the join.
  ipcMain.handle('config:get', async () => ({
    fleetRoot: await getFleetRoot(),
    sharedDir: await fleetSharedDir(),
    disableHardwareAcceleration: await getHardwareAccelDisabled(),
    autoReloadLoadouts: await getAutoReloadLoadouts(),
    usageBudget: await getUsageBudget()
  }));
  ipcMain.handle('config:setAutoReloadLoadouts', async (_e, enabled: boolean) => {
    await setAutoReloadLoadouts(!!enabled);
    return { autoReloadLoadouts: await getAutoReloadLoadouts() };
  });
  ipcMain.handle(
    'config:setUsageBudget',
    async (_e, preset: UsageBudgetPreset, customTokens: number) => {
      await setUsageBudget(preset, Number(customTokens));
      return { usageBudget: await getUsageBudget() };
    }
  );
  // Plan-usage bar numerator: total tokens spent across the fleet in the
  // trailing rolling window. The allowance (denominator) lives in config.
  ipcMain.handle('usage:rollingSpend', () => {
    const windowMs = USAGE_BUDGET_WINDOW_HOURS * 60 * 60 * 1000;
    return {
      spentTokens: tokensSpentSince(Date.now() - windowMs),
      windowHours: USAGE_BUDGET_WINDOW_HOURS
    };
  });
  ipcMain.handle('config:setFleetRoot', async (_e, path: string) => {
    await setFleetRoot(path);
    return { fleetRoot: await getFleetRoot(), sharedDir: await fleetSharedDir() };
  });
  ipcMain.handle('config:setHardwareAccelDisabled', async (_e, disabled: boolean) => {
    await setHardwareAccelDisabled(!!disabled);
    return { disableHardwareAcceleration: await getHardwareAccelDisabled() };
  });

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
  // Image on the clipboard, as PNG bytes — drives Ctrl+V image ingestion
  // (the renderer can't read clipboard image bytes directly under
  // contextIsolation). Null when the clipboard holds no image.
  ipcMain.handle('clipboard:readImage', () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    return { bytes: new Uint8Array(img.toPNG()), mime: 'image/png' };
  });

  // Drag-and-drop ingestion. Routed to the selected workspace by the
  // renderer; each saves into `<fleetRoot>/<id>/_dropped/` and returns the
  // container-visible path (`/workspace/_dropped/<name>`). Not backend-gated
  // — these touch only the host filesystem (+ a fetch for URL drops), so the
  // real module works in mock mode too. Errors (over-limit, unreachable URL)
  // propagate to the renderer, which toasts them.
  ipcMain.handle('files:dropOsFiles', (_e, workspaceId: string, sourcePaths: string[]) =>
    files.dropOsFiles(workspaceId, sourcePaths)
  );
  ipcMain.handle('files:dropBytes', (_e, workspaceId: string, payload: files.DropBytesPayload) =>
    files.dropBytes(workspaceId, payload)
  );
  ipcMain.handle('files:dropUrl', (_e, workspaceId: string, url: string) =>
    files.dropUrl(workspaceId, url)
  );
  ipcMain.handle('files:dropText', (_e, workspaceId: string, payload: files.DropTextPayload) =>
    files.dropText(workspaceId, payload)
  );

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
    async (
      event,
      containerId: string,
      brokerSessionId: string,
      cols: number,
      rows: number,
      resumeOf?: string
    ) => {
      // Internal handle id, used by the renderer to address subsequent
      // input/resize/detach calls. Distinct from brokerSessionId (which
      // is the workspace-persistent id the broker keys its session map
      // by). The renderer doesn't need to learn the broker id.
      const ptyHandleId = randomUUID();
      const b = await backendFor(containerId);
      let handle: PtyHandle;
      try {
        handle = await b.attachPty(containerId, brokerSessionId, cols, rows, resumeOf);
      } catch (err) {
        // Capture the broker's recent stdout/stderr so the user has
        // something to diagnose with. The classic symptom we're chasing
        // is "broker: ATTACHED timed out" after a pause/resume — the
        // broker is alive but slow to dispatch the response. Without
        // these logs we have no visibility into what the broker is
        // doing on the other side of the socket. Best-effort: if the
        // logs call itself fails (container gone, dockerode flaked),
        // getBrokerLogs returns '' and we just rethrow the original.
        const brokerLog = await b.getBrokerLogs(containerId, 100);
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
      // Remember which workspace this handle belongs to so committee `post`
      // (#120) can reuse it. containerId is the Docker id (or, for local, the
      // ULID); match it back to the workspace's ULID via the merged list.
      const owner = (await listAllWorkspaces()).find(
        (w) => w.containerId === containerId || w.id === containerId
      );
      if (owner) handleWorkspaceId.set(ptyHandleId, owner.id);
      // Diagnostic: ptySessions.size should oscillate around the count of
      // currently-mounted TerminalSession components. Unbounded growth =
      // detach isn't running (renderer cleanup race) or isn't reaching
      // here (channel mismatch). Surfaced via error.log so we can
      // correlate against attach failures across long sessions.
      logError({
        source: 'main',
        // Success, not a failure: recordError persists `level ?? 'error'`, so an
        // unspecified level would store this as `error` and the create modal, which
        // styles entries by level, would flash it red (#210). Pin it to `info`.
        level: 'info',
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
      // Host-side busy detection (#121): scan the SAME broker output stream in
      // main, so the committee's "is this expert done?" signal never depends on
      // renderer React state. Reuses the (pure) ActivityDetector.
      const detector = new ActivityDetector();
      handle.stream.on('data', (chunk: Buffer) => {
        win?.webContents.send(`pty:data:${ptyHandleId}`, chunk);
        if (owner && detector.push(chunk.toString('utf8'))) {
          committeeBusy.set(owner.id, { busy: detector.isBusy, since: Date.now() });
        }
      });
      handle.stream.on('end', () => {
        win?.webContents.send(`pty:end:${ptyHandleId}`);
        ptySessions.delete(ptyHandleId);
        handleWorkspaceId.delete(ptyHandleId);
        if (owner) committeeBusy.delete(owner.id);
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
    const detachedWs = handleWorkspaceId.get(sessionId);
    if (detachedWs) committeeBusy.delete(detachedWs);
    handleWorkspaceId.delete(sessionId);
    logError({
      source: 'main',
      type: 'pty-detach',
      message: present
        ? `pty:detach OK (live=${ptySessions.size})`
        : `pty:detach for unknown handle (live=${ptySessions.size})`,
      extra: { ptyHandleId: sessionId, hadHandle: present, live: ptySessions.size }
    });
  });

  // Terminate the broker session behind a handle (kills claude, drops the
  // session). The loadout reload calls this, then re-attaches the same broker
  // session id with `--resume` so the tab resumes the conversation under the
  // freshly-installed config. Returns whether a live handle was found. (#16)
  ipcMain.handle('pty:closeSession', async (_e, ptyHandleId: string) => {
    const handle = ptySessions.get(ptyHandleId);
    if (!handle) return false;
    await handle.close();
    ptySessions.delete(ptyHandleId);
    handleWorkspaceId.delete(ptyHandleId);
    logError({
      source: 'main',
      type: 'pty-close',
      message: `pty:closeSession OK (live=${ptySessions.size})`,
      extra: { ptyHandleId, live: ptySessions.size }
    });
    return true;
  });

  // Durable transcript mirror (#10). The renderer holds broker session ids;
  // mirror files are named by claude session id, so the transcript handlers
  // resolve broker→claude via the `broker_sessions` mapping internally.
  // Resolve a renderer broker session id to its claude session id. Tolerant
  // of a dormant DB (mock mode, where the watcher/DB never opened): returns
  // null instead of throwing, so the mirror handlers degrade to no-ops.
  const claudeIdFor = (workspaceId: string, brokerSessionId: string): string | null => {
    try {
      return lookupBrokerSession(workspaceId, brokerSessionId) ?? null;
    } catch {
      return null;
    }
  };
  ipcMain.handle(
    'mirror:setOverride',
    (_e, workspaceId: string, brokerSessionId: string, setting: 'on' | 'off') => {
      setSessionOverride(workspaceId, brokerSessionId, setting === 'off' ? 'off' : 'on');
      // If the broker→claude mapping is already known (a live flip mid-session),
      // propagate the new override onto the claude key immediately; otherwise
      // the watcher's new-session hook will do it once the mapping lands.
      const claudeId = claudeIdFor(workspaceId, brokerSessionId);
      if (claudeId) learnMirrorMapping(workspaceId, brokerSessionId, claudeId);
    }
  );
  // Does this tab have a mirror on disk? False when the broker→claude mapping
  // isn't learned yet (brand-new tab, no activity) — there's nothing to clean
  // up in that case, so the close-time modal is correctly skipped.
  ipcMain.handle(
    'transcript:hasForBrokerSession',
    (_e, workspaceId: string, brokerSessionId: string) => {
      const claudeId = claudeIdFor(workspaceId, brokerSessionId);
      return claudeId ? existsSync(workspaceHistoryFile(workspaceId, claudeId)) : false;
    }
  );
  ipcMain.handle(
    'transcript:deleteForBrokerSession',
    async (_e, workspaceId: string, brokerSessionId: string) => {
      const claudeId = claudeIdFor(workspaceId, brokerSessionId);
      if (!claudeId) return;
      await unlink(workspaceHistoryFile(workspaceId, claudeId)).catch(() => {});
    }
  );
  // Claude session ids that have a mirror file — for the sessions table's
  // orphaned-mirror cleanup affordance (keyed by claude id, as that table is).
  ipcMain.handle('transcript:list', async (_e, workspaceId: string) => {
    try {
      const files = await readdir(workspaceHistoryDir(workspaceId));
      return files.filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
    } catch {
      return [];
    }
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
  // Resume-grade tab→conversation resolution (#195 follow-up). Returns the
  // claude session UUID for a tab only when the mapping is verified (learned
  // deterministically at spawn). Legacy FIFO-guessed rows return null — the
  // renderer then surfaces "refresh skipped" instead of resuming a guess.
  ipcMain.handle(
    'sessions:resolveResumeTarget',
    (_e, workspaceId: string, brokerSessionId: string) =>
      lookupVerifiedBrokerSession(workspaceId, brokerSessionId)
  );

  ipcMain.handle(
    'observability:summaryForBrokerSession',
    (_e, workspaceId: string, brokerSessionId: string) => {
      const summary = summaryForBrokerSession(workspaceId, brokerSessionId);
      if (!summary) {
        // Blank-rail root signal: no-mapping = why the per-tab summary is null;
        // mapped-no-session = stale mapping. Deduped per (workspace:tab:outcome).
        const claudeId = lookupBrokerSession(workspaceId, brokerSessionId);
        const outcome = claudeId ? 'mapped-no-session' : 'no-mapping';
        const key = `${workspaceId}:${brokerSessionId}:${outcome}`;
        if (!mappingUnresolvedSeen.has(key)) {
          mappingUnresolvedSeen.add(key);
          logError({
            source: 'main',
            type: outcome === 'no-mapping' ? 'mapping-unresolved' : 'mapping-stale-session',
            level: 'warn',
            message: `per-tab summary ${outcome} for broker ${brokerSessionId}`,
            workspaceId,
            extra: { brokerSessionId, claudeSessionId: claudeId, outcome }
          });
        }
      }
      return summary;
    }
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
  // Open error.log in the OS default app — the MCP-unreachable toast's "Open
  // log" action (#159 follow-up). WSL can't reach a Windows shell.openPath, so
  // route through the same explorer.exe fallback the folder-open handlers use.
  ipcMain.handle('app:openErrorLog', () => {
    const p = getLogPath();
    return openHostPath(p);
  });
  // Current host MCP listener health — a window mounting mid-outage reads this
  // to render the sticky "MCP unreachable" toast (live changes arrive on the
  // mcp:status broadcast). See mcpStatusBroadcast.ts.
  ipcMain.handle('mcp:status:get', () => currentMcpStatus());

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
    ipcMain.handle('__test:emitDetectedPort', (_e, workspaceId: string, port: number) => {
      broadcastPortDetected(workspaceId, port);
    });
  }
}
