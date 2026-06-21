// Local (non-container) workspace backend (#16): runs `claude` as a host child
// process (node-pty) against a user-chosen host directory — no Docker layer.
//
// Unlike the container backend, there's no broker process tree to outlive the
// app: a local `claude` is a child of the Electron main process and dies when
// the app quits. So liveness is in-memory only (the `started`/`paused` sets
// below). Across a workspace switch the process survives via the in-process
// session manager (`localSessions.ts`); across an app restart it does not, and
// is restored on the next attach via `claude --resume <uuid>` off the on-disk
// JSONL. See SPEC §6/§10.

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import type * as NodePty from 'node-pty';
import type { Backend } from './backend.js';
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
import { workspaceStateDir, assertValidWorkspaceId } from './paths.js';
import { resolveEnv } from './vault.js';
import {
  attachLocalSession,
  killWorkspaceSessions,
  signalWorkspaceSessions,
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
const paused = new Set<string>();

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

/**
 * Resolve the `claude` binary. An explicit `CLAUDE_FLEET_LOCAL_CLAUDE_BIN`
 * override wins (for a non-PATH install, or to point tests at a stand-in);
 * otherwise look it up on the host PATH (POSIX `command -v`).
 */
async function findClaude(): Promise<string | null> {
  const override = process.env.CLAUDE_FLEET_LOCAL_CLAUDE_BIN?.trim();
  if (override) return override;
  try {
    const { stdout } = await execFileAsync('sh', ['-c', 'command -v claude']);
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
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
 */
async function buildEnv(id: string, ws: { env: Workspace['env'] }): Promise<NodeJS.ProcessEnv> {
  const resolved = await resolveEnv(id, ws.env.plain, ws.env.secretKeys);
  return {
    ...process.env,
    ...resolved,
    TERM: 'xterm-256color'
  };
}

// ── Backend surface ────────────────────────────────────────────────────────

export async function ping(): Promise<boolean> {
  return (await findClaude()) !== null;
}

export async function ensureImage(_onProgress: (p: PullProgress) => void): Promise<void> {
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
    const state: WorkspaceState = paused.has(m.id)
      ? 'paused'
      : started.has(m.id)
        ? 'running'
        : 'stopped';
    result.push({
      ...m,
      state,
      // Only warm (running/paused) workspaces get a containerId surrogate so
      // the renderer mounts their pane; stopped ones live in the Saved modal.
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
  paused.delete(spec.id);
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
  if (paused.delete(id)) signalWorkspaceSessions(id, 'SIGCONT');
  return id; // the containerId surrogate the renderer attaches against
}

export async function pauseWorkspace(containerId: string): Promise<void> {
  signalWorkspaceSessions(containerId, 'SIGSTOP');
  if (started.has(containerId)) paused.add(containerId);
}

export async function stopWorkspace(containerId: string): Promise<void> {
  killWorkspaceSessions(containerId);
  started.delete(containerId);
  paused.delete(containerId);
}

export async function removeWorkspace(
  containerId: string,
  opts: RemoveWorkspaceOpts = {}
): Promise<void> {
  const id = opts.id ?? containerId;
  killWorkspaceSessions(id);
  started.delete(id);
  paused.delete(id);
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
  const claudeBin = await findClaude();
  if (!claudeBin) {
    throw new Error(
      "`claude` isn't installed on this host (not found on PATH). Install Claude Code " +
        '(npm i -g @anthropic-ai/claude-code) to use a local workspace, or use a Container workspace.'
    );
  }
  const env = await buildEnv(id, m);
  // Attaching implies the workspace is up.
  started.add(id);
  paused.delete(id);
  return attachLocalSession({
    workspaceId: id,
    sessionId,
    cols,
    rows,
    cwd: m.workspaceRoot,
    env,
    file: claudeBin,
    resumeOf,
    spawn: defaultSpawn
  });
}

export async function getBrokerLogs(_containerId: string, _tailLines?: number): Promise<string> {
  // No broker; per-session stderr capture is a future nicety.
  return '';
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
  getBrokerLogs
};
void _assertBackend;
