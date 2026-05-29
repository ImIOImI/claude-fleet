// Docker-backed workspace operations.
//
// This module talks to dockerode and exposes operations the IPC layer
// translates into `workspace:*` channels. The exported types use
// workspace-level vocabulary because that's what the rest of the app
// sees; the internal `dockerode` calls still operate on the Docker
// notion of a container (label `com.claude-fleet.managed`, etc.). When
// a non-Docker backend lands, it can implement the same surface.

import Docker from 'dockerode';
import { mkdir, rm, stat } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import {
  assertValidWorkspaceName,
  workspaceBrokerDir,
  workspaceBrokerSocket,
  workspaceClaudeDir,
  workspaceStateDir
} from './paths.js';
import type { Workspace } from './workspaces.js';
import { BrokerClient, brokerPtyStream } from './broker.js';

export const FLEET_LABEL = 'com.claude-fleet.managed';
export const RUNNER_IMAGE = 'ghcr.io/imioimi/claude-fleet/runner:latest';

const docker = new Docker();

export interface CreateWorkspaceInput {
  name: string;
  workspaceRoot: string;
  workspaceSubdir: string;
  profile: string;
  env: Record<string, string>;
  /** Image reference to launch. Defaults to the bundled runner image. */
  image?: string;
  cpus?: number;
  memoryMb?: number;
}

export interface ImageInspectResult {
  ref: string;
  digest?: string;
  labels: Record<string, string>;
}

/**
 * Pull (if needed) and inspect an image, returning its digest + labels.
 * Used by the image library to record metadata about images workspaces
 * are actually created against.
 */
export async function inspectImage(ref: string): Promise<ImageInspectResult> {
  const info = await docker.getImage(ref).inspect();
  const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
  // RepoDigests look like ['ghcr.io/foo/bar@sha256:abc…']; we just want
  // the trailing digest part for display.
  const repoDigest = info.RepoDigests?.[0];
  const digest = repoDigest?.split('@')[1];
  return { ref, digest, labels };
}

export interface PullProgress {
  message: string;
}

/**
 * Pull the runner image, with offline fallback. Always asks the registry
 * — `:latest` tags get silent improvements (broker landing, claude
 * version bumps) and the previous "skip if any copy exists locally"
 * meant users stayed pinned to whatever they first pulled forever. Now
 * we let Docker compare layer digests and re-download only changed
 * layers (no-op when already current).
 *
 * When the registry is unreachable but we have a local copy, surface a
 * one-line warning and proceed with the local image. Anything else
 * (auth failures, 5xx) bubbles. If no local copy exists either, the
 * caller can't proceed and the error propagates.
 */
export async function ensureImage(
  onProgress: (p: PullProgress) => void
): Promise<void> {
  const localExists = await docker
    .getImage(RUNNER_IMAGE)
    .inspect()
    .then(() => true)
    .catch((err: unknown) => {
      if ((err as { statusCode?: number }).statusCode === 404) return false;
      throw err;
    });

  onProgress({
    message: localExists ? `Checking ${RUNNER_IMAGE} for updates…` : `Pulling ${RUNNER_IMAGE}…`
  });

  try {
    const stream = (await docker.pull(RUNNER_IMAGE)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (event: Record<string, unknown>) => {
          // Per-layer progress events carry `status` ('Pulling fs layer',
          // 'Downloading', 'Pull complete', etc.). The summary event at the
          // tail says 'Status: Image is up to date for …' or 'Status:
          // Downloaded newer image for …'. Forward both — the UI shows the
          // latest message.
          const status = typeof event.status === 'string' ? event.status : '';
          const id = typeof event.id === 'string' ? ` ${event.id}` : '';
          if (status) onProgress({ message: `${status}${id}` });
        }
      );
    });
  } catch (err) {
    if (localExists) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress({
        message: `Registry check failed (${msg}); using cached ${RUNNER_IMAGE}.`
      });
      return;
    }
    throw err;
  }
}

export async function ping(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Live workspaces — workspaces whose Docker container currently exists
 * (running or stopped). Does not include "deleted" workspaces (those with
 * a state dir on disk but no live container); the IPC layer joins these
 * in via the workspace manifests.
 */
export async function listLiveWorkspaces(): Promise<Workspace[]> {
  const raw = await docker.listContainers({
    all: true,
    filters: { label: [FLEET_LABEL] }
  });
  return raw.map((c) => {
    const name = c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12);
    // Docker state strings: 'created' | 'running' | 'paused' | 'restarting'
    // | 'removing' | 'exited' | 'dead'. We collapse everything that isn't
    // running or paused into 'stopped' for the renderer.
    let state: Workspace['state'];
    if (c.State === 'running') state = 'running';
    else if (c.State === 'paused') state = 'paused';
    else state = 'stopped';
    return {
      name,
      workspaceRoot: c.Labels['com.claude-fleet.workspace-root'] ?? '',
      workspaceSubdir: c.Labels['com.claude-fleet.subdir'] ?? '',
      profile: c.Labels['com.claude-fleet.profile'] ?? '',
      kind: 'container',
      image: c.Image,
      createdAt: c.Created * 1000,
      lastUsedAt: c.Created * 1000,
      state,
      containerId: c.Id,
      status: c.Status
    };
  });
}

export async function createWorkspace(spec: CreateWorkspaceInput): Promise<Workspace> {
  assertValidWorkspaceName(spec.name);

  const wsStat = await stat(spec.workspaceRoot).catch(() => null);
  if (!wsStat?.isDirectory()) {
    throw new Error(`Workspace root "${spec.workspaceRoot}" is not an existing directory`);
  }

  const claudeDir = workspaceClaudeDir(spec.name);
  await mkdir(claudeDir, { recursive: true });
  const brokerDir = workspaceBrokerDir(spec.name);
  await mkdir(brokerDir, { recursive: true });

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  const image = spec.image ?? RUNNER_IMAGE;
  const envArr = ['HOME=/home/fleet', ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`)];
  const hostCfg: Docker.HostConfig = {
    Binds: [
      `${spec.workspaceRoot}:/workspace:rw`,
      `${claudeDir}:/home/fleet/.claude:rw`,
      // The in-container broker creates its socket here. Bind-mounting
      // the *directory* (not the file) lets the broker create the
      // socket node on its own — Docker can't bind-mount a file that
      // doesn't exist yet on the host side.
      `${brokerDir}:/run/broker:rw`
    ],
    AutoRemove: false
  };
  if (spec.cpus) hostCfg.NanoCpus = Math.round(spec.cpus * 1e9);
  if (spec.memoryMb) hostCfg.Memory = spec.memoryMb * 1024 * 1024;

  const created = await docker.createContainer({
    name: spec.name,
    Image: image,
    User: `${uid}:${gid}`,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    WorkingDir: `/workspace/${spec.workspaceSubdir}`.replace(/\/$/, '') || '/workspace',
    Env: envArr,
    Labels: {
      [FLEET_LABEL]: 'true',
      'com.claude-fleet.subdir': spec.workspaceSubdir,
      'com.claude-fleet.profile': spec.profile,
      // Stamp the host workspace root on the container so listLiveWorkspaces
      // can return it without a separate manifest read.
      'com.claude-fleet.workspace-root': spec.workspaceRoot
    },
    HostConfig: hostCfg
  });

  await created.start();
  const info = await created.inspect();
  const createdAt = Date.parse(info.Created);
  return {
    name: info.Name.replace(/^\//, ''),
    workspaceRoot: spec.workspaceRoot,
    workspaceSubdir: spec.workspaceSubdir,
    profile: spec.profile,
    kind: 'container',
    image,
    createdAt,
    lastUsedAt: createdAt,
    state: 'running',
    containerId: info.Id,
    status: info.State.Status
  };
}

/**
 * Start the (live) workspace by name. Returns the container id if it exists
 * (whether it was already running, paused, or stopped), or null if no live
 * container has that name and the caller should recreate from the spec.
 * Paused containers are unpaused; stopped containers are started.
 */
export async function startWorkspace(name: string): Promise<string | null> {
  assertValidWorkspaceName(name);
  const raw = await docker.listContainers({
    all: true,
    filters: { label: [FLEET_LABEL], name: [`^/${name}$`] }
  });
  const found = raw[0];
  if (!found) return null;

  const c = docker.getContainer(found.Id);
  if (found.State === 'paused') {
    try {
      await c.unpause();
    } catch (err: unknown) {
      // 409 = container is not paused (race with another caller)
      if ((err as { statusCode?: number }).statusCode !== 409) throw err;
    }
  } else if (found.State !== 'running') {
    try {
      await c.start();
    } catch (err: unknown) {
      // 304 = already started — race with another caller
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }
  return found.Id;
}

/**
 * Pause a running container via `docker pause` (cgroups freezer). All
 * processes in the container are suspended; container state remains
 * "live" and recoverable via startWorkspace (which will unpause).
 */
export async function pauseWorkspace(id: string): Promise<void> {
  const c = docker.getContainer(id);
  try {
    await c.pause();
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    // 409 = already paused; 404 = container gone — both are no-ops from
    // the user's POV. Anything else is a real error.
    if (status !== 409 && status !== 404) throw err;
  }
}

export async function stopWorkspace(id: string): Promise<void> {
  const c = docker.getContainer(id);
  try {
    await c.stop({ t: 5 });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 304 && status !== 404) throw err;
  }
}

export interface RemoveWorkspaceOpts {
  deleteState?: boolean;
}

export async function removeWorkspace(
  id: string,
  opts: RemoveWorkspaceOpts = {}
): Promise<void> {
  const c = docker.getContainer(id);

  let name: string | undefined;
  if (opts.deleteState) {
    try {
      const info = await c.inspect();
      name = info.Name.replace(/^\//, '');
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  try {
    await c.remove({ force: true });
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }

  if (opts.deleteState && name) {
    await rm(workspaceStateDir(name), { recursive: true, force: true });
  }
}

export interface PtyHandle {
  stream: Duplex;
  resize: (cols: number, rows: number) => Promise<void>;
  detach: () => void;
}

// Channel id used on every host→broker connection. We open one
// connection per terminal session, so a single channel per connection
// is enough. (The broker's protocol supports per-connection
// multiplexing if we ever want to share connections later.)
const HOST_CHANNEL = 1;

/**
 * Open a terminal session against the in-container broker.
 *
 * `sessionId` is the host-side, stable session id (from sessions.json).
 * The broker keys its session map by the same string, so a re-attach
 * after an app restart finds the live claude PTY by id.
 *
 * The flow:
 *   1. Resolve the workspace's broker socket from the container's name.
 *   2. Open the socket.
 *   3. Wrap the channel in a Duplex (brokerPtyStream) so HISTORY/OUTPUT
 *      listeners are wired BEFORE the broker has a chance to send any.
 *   4. ATTACH. If the broker says "no such session" we CREATE then ATTACH —
 *      covers both fresh-session and re-attach cases.
 */
export async function attachPty(
  containerId: string,
  sessionId: string,
  cols: number,
  rows: number
): Promise<PtyHandle> {
  // Find the workspace name so we know which socket to connect to.
  // Container names always start with "/"; strip that.
  const c = docker.getContainer(containerId);
  const info = await c.inspect();
  const workspaceName = info.Name.replace(/^\//, '');

  const sockPath = workspaceBrokerSocket(workspaceName);
  const client = new BrokerClient(sockPath);
  try {
    await client.ready();
  } catch (err) {
    client.close();
    throw new Error(
      `broker socket not reachable at ${sockPath}: ${(err as Error).message}. ` +
        `Is the runner image new enough to include the broker?`
    );
  }

  // CRITICAL: wire the stream BEFORE sending ATTACH.
  //
  // The broker replies to a successful ATTACH with two frames back-to-
  // back on the same socket chunk: ATTACHED, then HISTORY (the ring
  // buffer for the session, up to ~64 KiB of prior PTY output). The
  // frame reader's `for (const frame of consume())` dispatches them in
  // order — ATTACHED resolves `attachSession`'s waiter, HISTORY fires
  // `client.emit('history', …)`. If `brokerPtyStream` hasn't wired its
  // `onHistory` listener yet, that emit hits zero listeners and the
  // body is silently dropped.
  //
  // Symptom: re-attaching to an existing session whose claude is
  // currently idle at a prompt looks like a "blank terminal" — the
  // ring buffer content that would have repainted the prompt is gone,
  // and no live OUTPUT is coming because claude is waiting on input.
  //
  // Wiring `brokerPtyStream` here means the Duplex is ready to receive
  // events for HOST_CHANNEL before any of them are emitted. Pushed
  // data sits in the Duplex's internal buffer until ipc.ts wires its
  // `'data'` listener; that's fine, Node streams handle this case.
  const stream = brokerPtyStream(client, HOST_CHANNEL);

  // Try ATTACH first — if the session is alive (we're re-attaching),
  // that's all we need. If it's missing, CREATE then ATTACH.
  let attachResp = await client.attachSession(sessionId, HOST_CHANNEL);
  if (!attachResp.ok && /no such session/i.test(attachResp.error ?? '')) {
    const createResp = await client.createSession(sessionId, cols, rows);
    if (!createResp.ok) {
      stream.destroy();
      client.close();
      throw new Error(`broker CREATE failed: ${createResp.error}`);
    }
    attachResp = await client.attachSession(sessionId, HOST_CHANNEL);
  }
  if (!attachResp.ok) {
    stream.destroy();
    client.close();
    throw new Error(`broker ATTACH failed: ${attachResp.error}`);
  }

  return {
    stream,
    resize: async (newCols, newRows) => {
      client.sendResize(HOST_CHANNEL, newCols, newRows);
    },
    detach: () => {
      // Detach the channel cleanly so the session stays alive on the
      // broker for a future re-attach; then close the socket.
      // (Fire and forget — if the broker is unreachable there's
      // nothing to do but tear down.)
      void client.detachChannel(HOST_CHANNEL).catch(() => undefined);
      stream.destroy();
      client.close();
    }
  };
}

/**
 * Read the last `tailLines` of the container's stdout/stderr. Used as
 * diagnostic context when attachPty fails — the broker logs every
 * accepted connection, dispatch error, and session lifecycle event, so
 * when "ATTACHED timed out" fires on the host we want to see what the
 * broker was actually doing. The runner image runs the broker as PID 1
 * (per docker/Dockerfile), so its stdout/stderr IS the container's.
 *
 * Returns the empty string if anything goes wrong — this is a
 * best-effort diagnostic; we never want it to mask the underlying
 * attach error or throw a different one.
 *
 * The container's `Tty: true` (per `createContainer` above) means the
 * logs API returns plain bytes (no docker-multiplex 8-byte headers),
 * so we can decode and split lines directly.
 */
export async function getBrokerLogs(
  containerId: string,
  tailLines = 100
): Promise<string> {
  try {
    const c = docker.getContainer(containerId);
    const buf = await c.logs({
      stdout: true,
      stderr: true,
      tail: tailLines,
      timestamps: true,
      follow: false,
    });
    return buf.toString('utf8');
  } catch {
    return '';
  }
}
