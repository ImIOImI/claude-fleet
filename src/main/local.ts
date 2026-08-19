// Local (non-container) workspace backend (#16): runs `claude` as a host child
// process (node-pty) against a user-chosen host directory — no Docker layer.
//
// Unlike the container backend, there's no broker process tree to outlive the
// app: a local `claude` is a child of the Electron main process and dies when
// the app quits. Process liveness is in-memory (the `started` set below), but
// the workspace's *warm state* is persisted to `<stateDir>/<id>/local-live.json`
// and rehydrated at startup, so a running local workspace keeps its chip in
// the warm strip across an app restart instead of demoting to 'stopped'.
// Across a workspace switch the process survives via the in-process session
// manager (`localSessions.ts`); across an app restart it does not — each tab's
// conversation is restored on its first attach via `claude --resume <uuid>`
// off the verified broker→claude mapping (see attachPty). See SPEC §6/§10.
//
// Pause is not supported for *native/custom* local workspaces — there is no
// container to freeze and SIGSTOP/SIGCONT semantics don't map cleanly onto a
// host process with in-flight network connections. The Pause button is hidden
// in the UI for those. wsl-launcher workspaces pause via `kill -STOP` on the
// in-distro pid (see pauseWorkspace).

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type * as NodePty from 'node-pty';
import type { Backend } from './backend.js';
import { findClaude, CLAUDE_NOT_FOUND_MESSAGE, cachedNullableResolver } from './claudeResolve.js';
import {
  mcpSocketDir,
  mcpWorkspaceSocketPath,
  mcpWorkspaceTokenPath,
  MCP_TCP_PORT
} from './mcpSocket.js';
import {
  ensureLocalBridgeScript,
  localMcpServerEntry,
  wslMcpServerEntry,
  type McpTransport
} from './mcpLocalBridge.js';
import {
  wrapSpawnForLauncher,
  wslPidFile,
  windowsPathToWslPath,
  type WorkspaceLauncher
} from './localLauncher.js';
import { checkWslClaudeFreshness, type ClaudeUpdate } from './wslClaudeFreshness.js';
import {
  readWorkspaceManifest,
  listWorkspaceManifests,
  FACTORY_MIRROR,
  type Workspace,
  type WorkspaceSpec,
  type WorkspaceState
} from './workspaces.js';
import type {
  CreateWorkspaceInput,
  ImageInspectResult,
  PullProgress,
  PtyHandle,
  RemoveWorkspaceOpts
} from './docker.js';
import { randomUUID } from 'node:crypto';
import {
  lookupResumableBrokerSession,
  recordBrokerSessionMapping,
  recordUsageEvent
} from './db.js';
import { logError } from './errorLog.js';
import { learnMapping as learnMirrorMapping } from './mirrorPolicy.js';
import { workspaceStateDir, assertValidWorkspaceId } from './paths.js';
import { resolveEnv } from './vault.js';
import { endpointEnv } from './endpoints.js';
import {
  attachLocalSession,
  hasLiveSession,
  killWorkspaceSessions,
  type SpawnPty
} from './localSessions.js';
import { createConptySettler } from './conptySettle.js';

// Lazy require so the native node-pty addon only loads when a local session is
// actually spawned (and never under vitest, which can't load the Electron ABI).
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// In-memory liveness, seeded from the persisted warm state on the first
// listLiveWorkspaces() of a run (see rehydrateLiveState) so an app restart
// doesn't demote running local workspaces to 'stopped'.
const started = new Set<string>();

// wsl-launcher workspaces CAN pause (kill -STOP inside the distro, #253);
// native/custom local ones still can't. In-memory like `started`.
const paused = new Set<string>();

// ── Warm-state persistence ─────────────────────────────────────────────────
//
// `<stateDir>/<id>/local-live.json` = `{ "state": "running" | "paused" }`;
// absent ⇒ stopped. Written on every state transition, removed on stop, and
// read back once per app run. Runtime state deliberately lives NEXT TO the
// manifest rather than in it — workspace.json is the user's spec, and its
// strict-allowlist parser would silently drop unknown fields on round-trip.

function liveStatePath(id: string): string {
  return join(workspaceStateDir(id), 'local-live.json');
}

/** Best-effort: chip warmth is a nicety, never worth failing a transition. */
async function persistLiveState(id: string): Promise<void> {
  try {
    if (!started.has(id)) {
      await rm(liveStatePath(id), { force: true });
      return;
    }
    const state = paused.has(id) ? 'paused' : 'running';
    await mkdir(workspaceStateDir(id), { recursive: true });
    await writeFile(liveStatePath(id), JSON.stringify({ state }) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

let rehydrated = false;

/** Seed `started`/`paused` from the persisted warm state, once per app run.
 *  Only ever ADDS ids at process start (both sets are empty before the first
 *  list), so it can't clobber transitions that raced ahead of the first call. */
async function rehydrateLiveState(manifests: WorkspaceSpec[]): Promise<void> {
  if (rehydrated) return;
  rehydrated = true;
  await Promise.all(
    manifests
      .filter((m) => m.kind === 'local')
      .map(async (m) => {
        try {
          const raw = await readFile(liveStatePath(m.id), 'utf8');
          const state = (JSON.parse(raw) as { state?: unknown }).state;
          if (state === 'running') {
            started.add(m.id);
          } else if (state === 'paused') {
            started.add(m.id);
            paused.add(m.id);
          }
        } catch {
          /* absent or malformed ⇒ stopped */
        }
      })
  );
}

/** Test-only: simulate an app restart (in-memory warm state dies, disk survives). */
export function _resetForTest(): void {
  started.clear();
  paused.clear();
  rehydrated = false;
}

/** node-pty-backed spawn factory passed to the session manager. */
const defaultSpawn: SpawnPty = ({ file, args, cwd, cols, rows, env }) => {
  const pty = require('node-pty') as typeof NodePty;
  let p: NodePty.IPty;
  try {
    p = pty.spawn(file, args, {
      name: 'xterm-256color',
      cwd,
      cols,
      rows,
      env,
      // Opt-in escape hatch (#268 fallback #2): node-pty 1.1.0 bundles a newer
      // conpty.dll + OpenConsole.exe (already asarUnpacked with the rest of
      // node-pty) that fixes many ConPTY reflow/reprint bugs. Off by default —
      // it swaps the OS console host for every Windows local session and has
      // had no Windows soak time here; flip it via a user env var without a
      // rebuild if the re-settle below doesn't hold.
      ...(process.platform === 'win32' && process.env.CLAUDE_FLEET_CONPTY_DLL === '1'
        ? { useConptyDll: true }
        : {})
    });
  } catch (err) {
    // Stale resolution (binary moved/uninstalled since we cached it): force
    // the next resolveClaude() to re-probe instead of failing forever.
    claudeResolver.invalidate();
    throw err;
  }

  // Track liveness so the ConPTY settle below (and any late resize) never
  // calls into an exited pty — node-pty on Node 22 throws "Cannot resize a
  // pty that has already exited" as an *uncaught* error, which would crash
  // the main process (see localSessions.resize, which guards the same way).
  let exited = false;
  const safeResize = (c: number, r: number): void => {
    if (exited) return;
    try {
      p.resize(c, r);
    } catch {
      /* raced with exit */
    }
  };

  // ConPTY overlap fix (#268, reworked): ConPTY keeps its own pseudoconsole
  // buffer and reprints/reflows it to the frontend on updates — an ongoing
  // condition, so the original one-shot post-spawn jitter (#269) did not hold
  // in the field, and its closure-captured spawn cols could clobber a
  // renderer fit landing inside the 250 ms window, pinning ConPTY at a stale
  // width. Now every resize (and the spawn itself) schedules a debounced
  // settle that jitters the winsize at the pty's CURRENT size, forcing
  // ConPTY to re-emit a clean frame — the programmatic equivalent of the
  // manual window resize that heals the corruption. POSIX PTYs (macOS/Linux,
  // and the container backend's Linux PTY) don't need this, so Windows-only.
  // Last size pushed to the pty, seeded from the spawn size (#268).
  let lastCols = cols;
  let lastRows = rows;
  const settler =
    process.platform === 'win32'
      ? createConptySettler({
          resize: safeResize,
          getSize: () => ({ cols: p.cols, rows: p.rows }),
          onSettle: ({ cols: c, rows: r }) => {
            // One line per settle: the field-visible record of what size
            // ConPTY was reconciled to. A settle size that differs from the
            // spawn size means a post-spawn resize landed — the case the
            // one-shot fix silently reverted.
            logError({
              source: 'main',
              type: 'conpty-settle',
              level: 'info',
              message: `conpty settled at ${c}x${r} (pid ${p.pid}, spawned ${cols}x${rows})`,
              extra: { pid: p.pid, cols: c, rows: r, spawnCols: cols, spawnRows: rows }
            });
          }
        })
      : null;
  p.onExit(() => {
    exited = true;
    settler?.dispose();
  });
  settler?.schedule();

  return {
    get pid() {
      return p.pid;
    },
    write: (d) => p.write(d),
    // Change-aware (#268). A resize to the size the pty already has is not
    // free on Windows: it arms the ConPTY settler, whose job is to jitter the
    // winsize so ConPTY re-emits a full frame — so a no-op resize cost three
    // ConPTY resizes and a redraw of whatever stale content sat in its buffer.
    // Measured on a live install, 11% of settles were triggered with nothing
    // having changed. The renderer guards this too; this is the authoritative
    // one, covering every caller.
    //
    // Note the settler's own jitter calls `safeResize` DIRECTLY, not through
    // here, so a genuine size change still gets its intended re-emit.
    resize: (c, r) => {
      if (c === lastCols && r === lastRows) return;
      lastCols = c;
      lastRows = r;
      safeResize(c, r);
      settler?.schedule();
    },
    kill: (sig) => p.kill(sig),
    onData: (cb) => {
      p.onData(cb);
    },
    onExit: (cb) => {
      p.onExit(() => cb());
    }
  };
};

/** Resolve the host `claude` binary (see claudeResolve.ts for the strategy).
 *  Cached: the lookup spawns where.exe/login-shell probes, so it should run
 *  once per install state, not once per session spawn. NOTE (2026-08-11
 *  review): workspace:ping routes to dockerode, and local ping() currently
 *  has no callers — this cache does NOT explain the per-minute idle stall,
 *  which remains under investigation. Null re-probes after 5 min; a spawn
 *  failure invalidates so a moved binary is re-resolved. */
const claudeResolver = cachedNullableResolver(
  () => findClaude((file, args) => execFileAsync(file, args), homedir()),
  { nullTtlMs: 5 * 60_000 }
);
function resolveClaude(): Promise<string | null> {
  return claudeResolver.get();
}

/** Best-effort signal to every live in-distro claude of a wsl workspace via
 *  its session pidfiles (written by the -lic bootstrap; see localLauncher). */
async function signalWslSessions(
  launcher: Extract<WorkspaceLauncher, { mode: 'wsl' }>,
  workspaceId: string,
  signal: 'STOP' | 'CONT' | 'TERM'
): Promise<void> {
  const glob = wslPidFile(workspaceId, '*');
  // Guard against pid reuse: before signaling, confirm the process running
  // at the saved pid is actually claude (cmdline contains 'claude'). If not,
  // the pidfile is stale — remove it rather than signaling an unrelated
  // process. This is the paranoid-safe path; a missing /proc/<pid>/cmdline
  // (process already gone) is treated as stale too.
  const script = [
    `for f in ${glob}; do`,
    `  [ -f "$f" ] || continue`,
    `  p=$(cat "$f")`,
    `  if grep -q claude "/proc/$p/cmdline" 2>/dev/null; then`,
    `    kill -${signal} "$p" 2>/dev/null`,
    `  else`,
    `    rm -f "$f"`,
    `  fi`,
    `done; true`
  ].join('\n');
  await execFileAsync('wsl.exe', ['-d', launcher.distro, '--exec', 'sh', '-c', script]).catch(() => {});
}

// Env markers claude sets on the subprocesses it spawns to flag a nested/child
// context. A fleet-launched claude is a genuine top-level session, so these are
// scrubbed from the inherited host env before spawn (see buildEnv, #285).
const CLAUDE_CHILD_SESSION_MARKERS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE'] as const;

/**
 * Build the spawn env. A *local* workspace IS the user's host claude, so it
 * inherits the real host environment — crucially `HOME`, so claude uses the
 * existing host login, already-approved managed settings (the OTEL gate), and
 * its real install under `~/.local/bin`. We deliberately do NOT isolate `HOME`:
 * an isolated home re-triggered the managed-settings approval gate on every
 * workspace and made claude warn that `$HOME/.local/bin/claude` was missing.
 * The workspace's resolved env (e.g. a per-workspace `ANTHROPIC_API_KEY`) is
 * layered on top.
 *
 * exported for tests
 */
export async function buildEnv(
  id: string,
  ws: { env: Workspace['env']; authMode?: Workspace['authMode']; endpointId?: string }
): Promise<NodeJS.ProcessEnv> {
  const backendVars = ws.authMode === 'endpoint' ? await endpointEnv(ws.endpointId) : {};
  const resolved = await resolveEnv(id, ws.env.plain, ws.env.secretKeys);
  const base: NodeJS.ProcessEnv = { ...process.env };
  // Endpoint workspaces must not inherit the host's real Anthropic key (dev
  // fallback mode) into a process whose base URL is a third-party endpoint.
  if (ws.authMode === 'endpoint') delete base.ANTHROPIC_API_KEY;
  // A fleet-spawned local claude is a fresh TOP-LEVEL session, not a child of
  // whatever launched fleet. If fleet was itself started from inside a claude
  // session (e.g. a `claude` Bash tool ran `npm run dev`), its env carries
  // claude's child-session markers; inherited unscrubbed, the spawned claude
  // sees CLAUDE_CODE_CHILD_SESSION and turns transcript saving OFF — no .jsonl
  // is written, the watcher ingests nothing, and the session shows $0.00 with
  // no busy attribution (#285). Scrub the markers so it saves its transcript.
  // (An explicit workspace env override re-appears below via `resolved`.)
  for (const marker of CLAUDE_CHILD_SESSION_MARKERS) delete base[marker];
  return { ...base, ...backendVars, ...resolved, TERM: 'xterm-256color' };
}

// ── Backend surface ────────────────────────────────────────────────────────

export async function ping(): Promise<boolean> {
  return (await resolveClaude()) !== null;
}

export async function ensureImage(
  _onProgress: (p: PullProgress) => void,
  _imageRef?: string
): Promise<void> {
  // No image for a host process.
}

export async function inspectImage(_ref: string): Promise<ImageInspectResult> {
  throw new Error('local workspaces have no image to inspect');
}

export async function listLiveWorkspaces(): Promise<Workspace[]> {
  const manifests = await listWorkspaceManifests();
  await rehydrateLiveState(manifests);
  const result: Workspace[] = [];
  for (const m of manifests) {
    if (m.kind !== 'local') continue;
    const state: WorkspaceState = paused.has(m.id)
      ? 'paused'
      : started.has(m.id)
        ? 'running'
        : 'stopped';
    result.push({
      ...m,
      state,
      // Only running workspaces get a containerId surrogate so the renderer
      // mounts their pane; stopped ones live in the Saved modal.
      containerId: state === 'stopped' ? undefined : m.id
    });
  }
  return result;
}

export async function createWorkspace(spec: CreateWorkspaceInput): Promise<Workspace> {
  assertValidWorkspaceId(spec.id);
  const workingDir = spec.workspaceRoot;
  if (!workingDir) {
    throw new Error('local workspace requires a working directory');
  }
  // Nothing to provision on disk: local claude uses the host's real ~/.claude
  // (login, settings, install) and runs in `workingDir`. The manifest is
  // written by the ipc create handler. Processes spawn lazily on first attach.
  started.add(spec.id);
  await persistLiveState(spec.id);
  const now = Date.now();
  return {
    id: spec.id,
    name: spec.name,
    labels: [],
    workspaceRoot: workingDir,
    workspaceSubdir: spec.workspaceSubdir,
    kind: 'local',
    authMode: spec.authMode,
    env: spec.env,
    resources: spec.resources,
    mirror: FACTORY_MIRROR,
    createdAt: now,
    lastUsedAt: now,
    state: 'running',
    containerId: spec.id
  };
}

export async function startWorkspace(id: string): Promise<string | null> {
  const m = await readWorkspaceManifest(id);
  if (!m || m.kind !== 'local') return null;
  started.add(id);
  if (paused.delete(id) && m.launcher?.mode === 'wsl') {
    await signalWslSessions(m.launcher, id, 'CONT');
  }
  await persistLiveState(id);
  return id; // the containerId surrogate the renderer attaches against
}

/**
 * Start-time staleness check for a wsl-launcher workspace (#336): did the
 * distro grow a claude newer than the manifest-pinned one? Null for non-wsl
 * workspaces and on any probe failure — callers treat null as "no cue".
 */
export async function checkClaudeFreshness(
  id: string
): Promise<(ClaudeUpdate & { distro: string }) | null> {
  const m = await readWorkspaceManifest(id);
  if (!m || m.kind !== 'local' || m.launcher?.mode !== 'wsl') return null;
  const update = await checkWslClaudeFreshness(m.launcher, {
    exec: async (file, args) => {
      const { stdout } = await execFileAsync(file, args);
      return { stdout: String(stdout) };
    }
  });
  return update ? { ...update, distro: m.launcher.distro } : null;
}

export async function pauseWorkspace(containerId: string): Promise<void> {
  const m = await readWorkspaceManifest(containerId);
  if (m?.launcher?.mode === 'wsl') {
    await signalWslSessions(m.launcher, containerId, 'STOP');
    if (started.has(containerId)) paused.add(containerId);
    await persistLiveState(containerId);
    return;
  }
  throw new Error('pause is not supported for local workspaces');
}

export async function stopWorkspace(containerId: string): Promise<void> {
  const m = await readWorkspaceManifest(containerId);
  killWorkspaceSessions(containerId);
  // conpty teardown isn't guaranteed to reap the Linux-side process (#253).
  if (m?.launcher?.mode === 'wsl') {
    await signalWslSessions(m.launcher, containerId, 'TERM');
    // Clean up stale pidfiles after TERM: a pid recycled by the OS before the
    // next launch could be signaled incorrectly (pid-reuse hazard). Best-effort;
    // the /tmp location is ephemeral and vanishes with the WSL VM anyway.
    const glob = wslPidFile(containerId, '*');
    const cleanScript = `rm -f ${glob}; true`;
    await execFileAsync('wsl.exe', ['-d', m.launcher.distro, '--exec', 'sh', '-c', cleanScript]).catch(() => {});
  }
  started.delete(containerId);
  paused.delete(containerId);
  await persistLiveState(containerId);
}

export async function removeWorkspace(
  containerId: string,
  opts: RemoveWorkspaceOpts = {}
): Promise<void> {
  const id = opts.id ?? containerId;
  killWorkspaceSessions(id);
  started.delete(id);
  paused.delete(id);
  await persistLiveState(id);
  if (opts.deleteState && id) {
    await rm(workspaceStateDir(id), { recursive: true, force: true });
  }
}

/**
 * Which claude session (if any) a local attach should `--resume`.
 * - An explicit target (Sessions-pane resume, tab Refresh) always wins.
 * - A tab with a live pty re-attaches; resume args would be ignored anyway.
 * - Otherwise the tab's process is gone — most commonly because the app
 *   restarted (a local claude dies with the Electron main process). Resume
 *   the tab's verified broker→claude mapping so the restored chip's tabs
 *   pick their conversations back up instead of spawning fresh ones.
 * - A throwing lookup (dormant DB in mock mode) degrades to a fresh spawn.
 *
 * Exported for tests.
 */
export function effectiveResumeOf(
  explicit: string | undefined,
  hasLivePty: boolean,
  lookupResumable: () => string | null
): string | undefined {
  if (explicit) return explicit;
  if (hasLivePty) return undefined;
  try {
    return lookupResumable() ?? undefined;
  } catch {
    return undefined;
  }
}

export async function attachPty(
  containerId: string,
  sessionId: string,
  cols: number,
  rows: number,
  resumeOf?: string
): Promise<PtyHandle> {
  const id = containerId;
  const m = await readWorkspaceManifest(id);
  if (!m) throw new Error(`no manifest for local workspace ${id}`);
  const launcher: WorkspaceLauncher = m.launcher ?? { mode: 'native' };
  // wsl mode uses the save-time-probed in-distro path (manifest cache) — the
  // host resolver is wrong there. wrapSpawnForLauncher substitutes it; the
  // host `file` below is ignored for wsl. If the cache went stale (distro
  // reinstalled), the shell prints exec's error into the pty; re-saving the
  // workspace re-probes.
  const claudeBin =
    launcher.mode === 'wsl' ? launcher.claudePath : await resolveClaude();
  if (!claudeBin) throw new Error(CLAUDE_NOT_FOUND_MESSAGE);
  // e2e tests point CLAUDE_FLEET_LOCAL_CLAUDE_BIN at an interpreter (node) and
  // pass the stub script path here (NUL-separated), prepended before claude's
  // own flags so the spawn becomes `node <stub> [--mcp-config …] [--session-id …]`.
  const rawExtra = process.env.CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS;
  const extraArgs = rawExtra ? rawExtra.split('\0').filter(Boolean) : undefined;
  const env = await buildEnv(id, m);
  const mcpConfigPath = await ensureMcpConfig(id, launcher);
  // claude reads --mcp-config INSIDE the distro for wsl mode.
  const mcpConfigArg =
    mcpConfigPath && launcher.mode === 'wsl'
      ? (windowsPathToWslPath(mcpConfigPath) ?? undefined)
      : mcpConfigPath;
  // Attaching implies the workspace is up.
  started.add(id);
  // If the workspace was paused, resume it now. For wsl-launcher workspaces
  // the in-distro claude is SIGSTOP'd and must receive SIGCONT — otherwise
  // the pty attaches but the process never makes progress.
  if (paused.delete(id) && launcher.mode === 'wsl') {
    await signalWslSessions(launcher, id, 'CONT');
  }
  await persistLiveState(id);
  // Cross-restart continuity: a restored tab whose process died with the
  // previous app run resumes its mapped conversation instead of spawning a
  // fresh one.
  const resume = effectiveResumeOf(resumeOf, hasLiveSession(id, sessionId), () =>
    lookupResumableBrokerSession(id, sessionId)
  );
  return attachLocalSession({
    workspaceId: id,
    sessionId,
    cols,
    rows,
    cwd: m.workspaceRoot,
    env,
    file: claudeBin,
    resumeOf: resume,
    // Host-assigned claude session id (#195): only consumed on a fresh spawn;
    // onFreshSpawn then records the tab→claude mapping deterministically.
    // Local workspaces previously never learned mappings at all (no broker,
    // no pending-attach path), so per-tab observability and Refresh-resume
    // silently degraded to workspace-level guesses.
    claudeSessionId: randomUUID(),
    onFreshSpawn: (claudeSessionId) => {
      const { mode, previous } = recordBrokerSessionMapping(id, sessionId, claudeSessionId);
      if (mode === 'deferred') {
        // Re-spawn of a tab that still holds a real conversation onto a fresh
        // (not-yet-written) id — parked until it produces a transcript so an
        // unused session can't black-hole the tab (#170).
        logError({
          source: 'main',
          type: 'mapping-deferred',
          level: 'info',
          message: `broker ${sessionId} parked → ${claudeSessionId} at local spawn (awaiting transcript; keeping ${previous})`,
          workspaceId: id,
          extra: { brokerSessionId: sessionId, pending: claudeSessionId, keeping: previous }
        });
      } else if (previous && previous !== claudeSessionId) {
        logError({
          source: 'main',
          type: 'mapping-remapped',
          level: 'warn',
          message: `broker ${sessionId} remapped ${previous} → ${claudeSessionId} at local spawn`,
          workspaceId: id,
          extra: { brokerSessionId: sessionId, from: previous, to: claudeSessionId }
        });
      } else if (!previous) {
        logError({
          source: 'main',
          type: 'mapping-learned',
          level: 'info',
          message: `paired ${claudeSessionId} with broker ${sessionId} at local spawn (${resume ? 'resume' : 'session-id'})`,
          workspaceId: id,
          extra: { claudeSessionId, brokerSessionId: sessionId, how: resume ? 'resume' : 'session-id' }
        });
      }
      learnMirrorMapping(id, sessionId, claudeSessionId);
      if (resume) recordUsageEvent({ workspaceId: id, sessionId: resume, kind: 'resumed' });
    },
    extraArgs,
    mcpConfigPath: mcpConfigArg,
    spawn: wrapSpawnForLauncher(launcher, defaultSpawn, {
      workspaceId: id,
      platform: process.platform,
      // wsl.exe needs a valid WINDOWS cwd; the Linux cwd goes via --cd.
      windowsCwd: homedir(),
      // All per-workspace env keys (plain + secret) must cross the WSL boundary
      // so that keys not matching ANTHROPIC_*/CLAUDE_* prefixes (e.g. a
      // per-workspace MYAPP_TOKEN) still reach the in-distro claude.
      passEnvKeys: [...Object.keys(m.env.plain), ...m.env.secretKeys]
    })
  });
}

/**
 * The transport a local workspace's bridge should use, plus the file whose
 * existence proves the server side is ready for it (#295).
 *
 * Unix hosts: a per-workspace listener at `<userData>/mcp/<id>/mcp.sock` — the
 * socket both addresses the server and *is* the caller identity (#117).
 * Windows hosts: `listen()` on a unix socket is impossible, so the server runs
 * one loopback-TCP listener for every workspace and identity rides on the
 * per-workspace token at `<userData>/mcp/<id>/token`. Gating on `mcp.sock`
 * there — which is never created — is what left Windows local workspaces with
 * no fleet MCP at all.
 *
 * Exported for tests.
 */
export function localMcpTransport(
  userData: string,
  id: string,
  platform: NodeJS.Platform = process.platform
): { transport: McpTransport; readyPath: string } {
  if (platform === 'win32') {
    const tokenPath = mcpWorkspaceTokenPath(userData, id);
    return {
      transport: { kind: 'tcp', host: '127.0.0.1', port: MCP_TCP_PORT, tokenPath },
      readyPath: tokenPath
    };
  }
  const socketPath = mcpWorkspaceSocketPath(userData, id);
  return { transport: { kind: 'unix', socketPath }, readyPath: socketPath };
}

/**
 * Wire the read-only fleet MCP server (#12) for a local workspace via a
 * session-scoped `--mcp-config` file (auto-trusted, no approval gate, and never
 * touches the user's real ~/.claude.json). Points claude at our Electron-as-node
 * bridge. Skipped (returns undefined) if the server side isn't up yet.
 *
 * Exported for tests.
 */
export async function ensureMcpConfig(
  id: string,
  launcher: WorkspaceLauncher
): Promise<string | undefined> {
  // Interop off ⇒ don't wire at all (#259). The wsl bridge reaches the host by
  // exec'ing the app's own .exe from inside the distro, which is precisely what
  // `wsl.conf [interop] enabled=false` forbids — so wiring it would only put a
  // permanently-failed `claude-fleet-state` in the user's `/mcp` list. The
  // design (local-launcher-wsl §C) always called for skipping here; the flag
  // just wasn't persisted to act on. Undefined (never probed) still wires.
  if (launcher.mode === 'wsl' && launcher.interopEnabled === false) return undefined;
  const userData = app.getPath('userData');
  // Per-workspace socket or token (#117/#295). Both are brought up by
  // `ensureWorkspaceSocket` at workspace:create / startup; if this workspace's
  // one isn't on disk yet, skip wiring MCP for this attach.
  const { transport, readyPath } = localMcpTransport(userData, id);
  if (!(await stat(readyPath).catch(() => null))) return undefined;
  // The bridge script is shared (host-only, never bind-mounted) — it lives in
  // the parent mcp dir and is referenced by absolute host path.
  const bridgePath = await ensureLocalBridgeScript(mcpSocketDir(userData));
  const entry =
    launcher.mode === 'wsl'
      ? wslMcpServerEntry(process.execPath, bridgePath, transport)
      : localMcpServerEntry(process.execPath, bridgePath, transport);
  // wsl + untranslatable exe path (e.g. the app installed on a UNC share, which
  // has no /mnt/<drive> form) ⇒ skip wiring; the session works without fleet
  // tools. Interop-off is handled up front, above.
  if (!entry) return undefined;
  const config = { mcpServers: { 'claude-fleet-state': entry } };
  const configPath = join(workspaceStateDir(id), 'mcp-config.json');
  await mkdir(workspaceStateDir(id), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

export async function getBrokerLogs(_containerId: string, _tailLines?: number): Promise<string> {
  // No broker; per-session stderr capture is a future nicety.
  return '';
}

export async function committeePost(_workspaceId: string, _text: string): Promise<{ brokerSessionId: string }> {
  // Committee control is container-only (assertControl already refuses local
  // targets); this exists only to satisfy the Backend contract.
  throw new Error('committee post is not supported for local workspaces');
}

// Compile-time assertion that this module satisfies the Backend contract.
const _assertBackend: Backend = {
  ping,
  ensureImage,
  listLiveWorkspaces,
  createWorkspace,
  inspectImage,
  startWorkspace,
  pauseWorkspace,
  stopWorkspace,
  removeWorkspace,
  attachPty,
  getBrokerLogs,
  committeePost
};
void _assertBackend;
