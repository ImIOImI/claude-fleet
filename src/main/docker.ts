// Docker-backed workspace operations.
//
// This module talks to dockerode and exposes operations the IPC layer
// translates into `workspace:*` channels. The exported types use
// workspace-level vocabulary because that's what the rest of the app
// sees; the internal `dockerode` calls still operate on the Docker
// notion of a container. When a non-Docker backend lands (the planned
// 'local' kind), it can implement the same surface.
//
// Identity is a ULID stored in the `com.claude-fleet.id` label. Container
// names are derived as `cf-<id>` so they're unique on the host even when
// the user renames the workspace's label. Lookup is always by label.

import Docker from 'dockerode';
import { mkdir, rm, stat } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import {
  assertValidWorkspaceId,
  workspaceBrokerDir,
  workspaceBrokerSocket,
  workspaceClaudeDir,
  workspaceStateDir
} from './paths.js';
import type { Workspace, WorkspaceEnv, WorkspaceResources } from './workspaces.js';
import { BrokerClient, brokerPtyStream } from './broker.js';
import { recordPendingAttach } from './pendingAttaches.js';
import { resolveEnv } from './vault.js';

export const FLEET_LABEL = 'com.claude-fleet.managed';
export const ID_LABEL = 'com.claude-fleet.id';
export const NAME_LABEL = 'com.claude-fleet.name';
export const SUBDIR_LABEL = 'com.claude-fleet.subdir';
export const WORKSPACE_ROOT_LABEL = 'com.claude-fleet.workspace-root';
export const RUNNER_IMAGE = 'ghcr.io/imioimi/claude-fleet/runner:latest';

const docker = new Docker();

function containerNameFor(id: string): string {
  return `cf-${id}`;
}

export interface CreateWorkspaceInput {
  id: string;
  name: string;
  workspaceRoot: string;
  workspaceSubdir: string;
  /** Plain env vars only — secret values are looked up from the vault. */
  env: WorkspaceEnv;
  /** Image reference to launch. Defaults to the bundled runner image. */
  image?: string;
  resources?: WorkspaceResources;
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
 * version bumps).
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
 * Resolve a workspace's container by its ULID. Returns the dockerode
 * container info object, or undefined if not present.
 */
async function findContainerById(
  id: string
): Promise<Docker.ContainerInfo | undefined> {
  const raw = await docker.listContainers({
    all: true,
    filters: { label: [`${ID_LABEL}=${id}`] }
  });
  return raw[0];
}

/**
 * Live workspaces — those whose Docker container currently exists
 * (running or stopped). Does not include "deleted" workspaces (manifest
 * but no container); the IPC layer joins those in via workspace
 * manifests.
 *
 * Note: only minimal fields are populated here. The IPC layer overlays
 * the on-disk manifest (description, labels, color, env, etc.) on top.
 */
export async function listLiveWorkspaces(): Promise<Workspace[]> {
  const raw = await docker.listContainers({
    all: true,
    filters: { label: [FLEET_LABEL] }
  });
  return raw
    .map((c): Workspace | null => {
      const id = c.Labels[ID_LABEL];
      const name = c.Labels[NAME_LABEL] ?? c.Names[0]?.replace(/^\//, '') ?? '';
      // Containers without the id label are pre-migration; the migration
      // step removes them before this list is ever consulted.
      if (!id) return null;
      let state: Workspace['state'];
      if (c.State === 'running') state = 'running';
      else if (c.State === 'paused') state = 'paused';
      else state = 'stopped';
      return {
        id,
        name,
        labels: [],
        workspaceRoot: c.Labels[WORKSPACE_ROOT_LABEL] ?? '',
        workspaceSubdir: c.Labels[SUBDIR_LABEL] ?? '',
        kind: 'container',
        image: c.Image,
        authMode: 'oauth',
        env: { plain: {}, secretKeys: [] },
        createdAt: c.Created * 1000,
        lastUsedAt: c.Created * 1000,
        state,
        containerId: c.Id,
        status: c.Status
      };
    })
    .filter((w): w is Workspace => w !== null);
}

export async function createWorkspace(spec: CreateWorkspaceInput): Promise<Workspace> {
  assertValidWorkspaceId(spec.id);

  const wsStat = await stat(spec.workspaceRoot).catch(() => null);
  if (!wsStat?.isDirectory()) {
    throw new Error(`Workspace root "${spec.workspaceRoot}" is not an existing directory`);
  }

  const claudeDir = workspaceClaudeDir(spec.id);
  await mkdir(claudeDir, { recursive: true });
  const brokerDir = workspaceBrokerDir(spec.id);
  await mkdir(brokerDir, { recursive: true });

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  const image = spec.image ?? RUNNER_IMAGE;
  // Resolve secrets at create-time; the merged env goes straight to the
  // container's `Env` array. Missing secret keys resolve to empty string
  // so the container still starts (claude itself surfaces the failure
  // later via its own error path).
  const resolvedEnv = await resolveEnv(spec.id, spec.env.plain, spec.env.secretKeys);
  const envArr = ['HOME=/home/fleet', ...Object.entries(resolvedEnv).map(([k, v]) => `${k}=${v}`)];
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
  if (spec.resources?.cpus) hostCfg.NanoCpus = Math.round(spec.resources.cpus * 1e9);
  if (spec.resources?.memoryMb) hostCfg.Memory = spec.resources.memoryMb * 1024 * 1024;

  const created = await docker.createContainer({
    name: containerNameFor(spec.id),
    Image: image,
    User: `${uid}:${gid}`,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    WorkingDir: `/workspace/${spec.workspaceSubdir}`.replace(/\/$/, '') || '/workspace',
    Env: envArr,
    Labels: {
      [FLEET_LABEL]: 'true',
      [ID_LABEL]: spec.id,
      [NAME_LABEL]: spec.name,
      [SUBDIR_LABEL]: spec.workspaceSubdir,
      [WORKSPACE_ROOT_LABEL]: spec.workspaceRoot
    },
    HostConfig: hostCfg
  });

  await created.start();
  const info = await created.inspect();
  const createdAt = Date.parse(info.Created);
  return {
    id: spec.id,
    name: spec.name,
    labels: [],
    workspaceRoot: spec.workspaceRoot,
    workspaceSubdir: spec.workspaceSubdir,
    kind: 'container',
    image,
    authMode: 'oauth',
    env: spec.env,
    resources: spec.resources,
    createdAt,
    lastUsedAt: createdAt,
    state: 'running',
    containerId: info.Id,
    status: info.State.Status
  };
}

/**
 * Start the (live) workspace by id. Returns the container id if it exists
 * (whether it was already running, paused, or stopped), or null if no
 * container has that ULID label and the caller should recreate from the
 * spec. Paused containers are unpaused; stopped containers are started.
 */
export async function startWorkspace(id: string): Promise<string | null> {
  assertValidWorkspaceId(id);
  const found = await findContainerById(id);
  if (!found) return null;

  const c = docker.getContainer(found.Id);
  if (found.State === 'paused') {
    try {
      await c.unpause();
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 409) throw err;
    }
  } else if (found.State !== 'running') {
    try {
      await c.start();
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }
  return found.Id;
}

/**
 * Pause a running container. All processes are suspended (cgroups freezer);
 * the container state remains "live" and recoverable via startWorkspace.
 */
export async function pauseWorkspace(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  try {
    await c.pause();
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 409 && status !== 404) throw err;
  }
}

export async function stopWorkspace(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  try {
    await c.stop({ t: 5 });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 304 && status !== 404) throw err;
  }
}

export interface RemoveWorkspaceOpts {
  /** When true, also wipe the host-side state dir (manifest + .claude + broker). */
  deleteState?: boolean;
}

export async function removeWorkspace(
  containerId: string,
  opts: RemoveWorkspaceOpts = {}
): Promise<void> {
  const c = docker.getContainer(containerId);

  let id: string | undefined;
  if (opts.deleteState) {
    try {
      const info = await c.inspect();
      id = info.Config.Labels?.[ID_LABEL];
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  try {
    await c.remove({ force: true });
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }

  if (opts.deleteState && id) {
    await rm(workspaceStateDir(id), { recursive: true, force: true });
  }
}

export interface PtyHandle {
  stream: Duplex;
  resize: (cols: number, rows: number) => Promise<void>;
  detach: () => void;
}

const HOST_CHANNEL = 1;

/**
 * Open a terminal session against the in-container broker.
 *
 * Broker socket lives in the host state dir keyed by workspace id. We
 * resolve the id from the container's `com.claude-fleet.id` label.
 */
export async function attachPty(
  containerId: string,
  sessionId: string,
  cols: number,
  rows: number
): Promise<PtyHandle> {
  const c = docker.getContainer(containerId);
  const info = await c.inspect();
  const workspaceId = info.Config.Labels?.[ID_LABEL];
  if (!workspaceId) {
    throw new Error(`container ${containerId} is missing ${ID_LABEL} label`);
  }

  // Per-tab mapping: record this attach as "pending" so the JsonlWatcher's
  // new-session hook can pair the broker session id with the claude UUID
  // when a fresh claude is spawned.
  recordPendingAttach(workspaceId, sessionId);

  const sockPath = workspaceBrokerSocket(workspaceId);
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

  // CRITICAL: wire the stream BEFORE sending ATTACH so HISTORY frames
  // aren't dropped. See the long comment block on this function in
  // earlier iterations — kept terse here since the constraint hasn't
  // changed but the rest of the function got smaller.
  const stream = brokerPtyStream(client, HOST_CHANNEL);

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
      void client.detachChannel(HOST_CHANNEL).catch(() => undefined);
      stream.destroy();
      client.close();
    }
  };
}

/**
 * Read the last `tailLines` of the container's stdout/stderr. Used as
 * diagnostic context when attachPty fails. Returns empty string on any
 * error — never let this mask the underlying failure.
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
