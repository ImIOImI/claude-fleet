// Local (non-container) workspace backend (#16): runs `claude` as a host child
// process (node-pty) against a user-chosen host directory — no Docker layer.
//
// Unlike the container backend, there's no broker process tree to outlive the
// app: a local `claude` is a child of the Electron main process and dies when
// the app quits. So liveness is in-memory only (the `started` set below).
// Across a workspace switch the process survives via the in-process session
// manager (`localSessions.ts`); across an app restart it does not, and is
// restored on the next attach via `claude --resume <uuid>` off the on-disk
// JSONL. See SPEC §6/§10.
//
// Pause is not supported for local workspaces — there is no container to
// freeze and SIGSTOP/SIGCONT semantics don't map cleanly onto a host process
// with in-flight network connections. The Pause button is hidden in the UI for
// local workspaces.

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type * as NodePty from 'node-pty';
import type { Backend } from './backend.js';
import { findClaude, CLAUDE_NOT_FOUND_MESSAGE } from './claudeResolve.js';
import { mcpSocketDir, mcpWorkspaceSocketPath } from './mcpSocket.js';
import { ensureLocalBridgeScript, localMcpServerEntry } from './mcpLocalBridge.js';
import {
  readWorkspaceManifest,
  listWorkspaceManifests,
  FACTORY_MIRROR,
  type Workspace,
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
import { recordBrokerSessionMapping, recordUsageEvent } from './db.js';
import { logError } from './errorLog.js';
import { learnMapping as learnMirrorMapping } from './mirrorPolicy.js';
import { workspaceStateDir, assertValidWorkspaceId } from './paths.js';
import { resolveEnv } from './vault.js';
import { endpointEnv } from './endpoints.js';
import {
  attachLocalSession,
  killWorkspaceSessions,
  type SpawnPty
} from './localSessions.js';

// Lazy require so the native node-pty addon only loads when a local session is
// actually spawned (and never under vitest, which can't load the Electron ABI).
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// In-memory liveness. Empty at app start ⇒ all local workspaces report
// 'stopped' until the user starts/attaches one (their processes died with the
// previous app run).
const started = new Set<string>();

/** node-pty-backed spawn factory passed to the session manager. */
const defaultSpawn: SpawnPty = ({ file, args, cwd, cols, rows, env }) => {
  const pty = require('node-pty') as typeof NodePty;
  const p = pty.spawn(file, args, { name: 'xterm-256color', cwd, cols, rows, env });
  return {
    get pid() {
      return p.pid;
    },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: (sig) => p.kill(sig),
    onData: (cb) => {
      p.onData(cb);
    },
    onExit: (cb) => {
      p.onExit(() => cb());
    }
  };
};

/** Resolve the host `claude` binary (see claudeResolve.ts for the strategy). */
function resolveClaude(): Promise<string | null> {
  return findClaude((file, args) => execFileAsync(file, args), homedir());
}

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
  const result: Workspace[] = [];
  for (const m of manifests) {
    if (m.kind !== 'local') continue;
    const state: WorkspaceState = started.has(m.id) ? 'running' : 'stopped';
    result.push({
      ...m,
      state,
      // Only running workspaces get a containerId surrogate so the renderer
      // mounts their pane; stopped ones live in the Saved modal.
      containerId: state === 'running' ? m.id : undefined
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
  return id; // the containerId surrogate the renderer attaches against
}

export async function pauseWorkspace(_containerId: string): Promise<void> {
  throw new Error('pause is not supported for local workspaces');
}

export async function stopWorkspace(containerId: string): Promise<void> {
  killWorkspaceSessions(containerId);
  started.delete(containerId);
}

export async function removeWorkspace(
  containerId: string,
  opts: RemoveWorkspaceOpts = {}
): Promise<void> {
  const id = opts.id ?? containerId;
  killWorkspaceSessions(id);
  started.delete(id);
  if (opts.deleteState && id) {
    await rm(workspaceStateDir(id), { recursive: true, force: true });
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
  // resolveClaude honors CLAUDE_FLEET_LOCAL_CLAUDE_BIN as its first resolution
  // step (see claudeResolve.ts), so an e2e test's stub interpreter is picked up
  // here without a separate override branch.
  const claudeBin = await resolveClaude();
  if (!claudeBin) throw new Error(CLAUDE_NOT_FOUND_MESSAGE);
  // e2e tests point CLAUDE_FLEET_LOCAL_CLAUDE_BIN at an interpreter (node) and
  // pass the stub script path here (NUL-separated), prepended before claude's
  // own flags so the spawn becomes `node <stub> [--mcp-config …] [--session-id …]`.
  const rawExtra = process.env.CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS;
  const extraArgs = rawExtra ? rawExtra.split('\0').filter(Boolean) : undefined;
  const env = await buildEnv(id, m);
  const mcpConfigPath = await ensureMcpConfig(id);
  // Attaching implies the workspace is up.
  started.add(id);
  return attachLocalSession({
    workspaceId: id,
    sessionId,
    cols,
    rows,
    cwd: m.workspaceRoot,
    env,
    file: claudeBin,
    resumeOf,
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
          message: `paired ${claudeSessionId} with broker ${sessionId} at local spawn (${resumeOf ? 'resume' : 'session-id'})`,
          workspaceId: id,
          extra: { claudeSessionId, brokerSessionId: sessionId, how: resumeOf ? 'resume' : 'session-id' }
        });
      }
      learnMirrorMapping(id, sessionId, claudeSessionId);
      if (resumeOf) recordUsageEvent({ workspaceId: id, sessionId: resumeOf, kind: 'resumed' });
    },
    extraArgs,
    mcpConfigPath,
    spawn: defaultSpawn
  });
}

/**
 * Wire the read-only fleet MCP server (#12) for a local workspace via a
 * session-scoped `--mcp-config` file (auto-trusted, no approval gate, and never
 * touches the user's real ~/.claude.json). Points claude at our Electron-as-node
 * bridge. Skipped (returns undefined) if the MCP server socket isn't present.
 */
async function ensureMcpConfig(id: string): Promise<string | undefined> {
  const userData = app.getPath('userData');
  // Per-workspace socket (#117). The listener is brought up at workspace:create
  // / startup; if it isn't present yet, skip wiring MCP for this attach.
  const socketPath = mcpWorkspaceSocketPath(userData, id);
  if (!(await stat(socketPath).catch(() => null))) return undefined;
  // The bridge script is shared (host-only, never bind-mounted) — it lives in
  // the parent mcp dir and is referenced by absolute host path.
  const bridgePath = await ensureLocalBridgeScript(mcpSocketDir(userData));
  const config = {
    mcpServers: {
      'claude-fleet-state': localMcpServerEntry(process.execPath, bridgePath, socketPath)
    }
  };
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
