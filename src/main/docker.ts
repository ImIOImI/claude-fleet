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
  workspaceClaudeDir,
  workspaceStateDir
} from './paths.js';
import type { Workspace } from './workspaces.js';

export const FLEET_LABEL = 'com.claude-fleet.managed';
export const RUNNER_IMAGE = 'ghcr.io/imioimi/claude-fleet/runner:latest';

const docker = new Docker();

export interface CreateWorkspaceInput {
  name: string;
  workspaceRoot: string;
  workspaceSubdir: string;
  profile: string;
  env: Record<string, string>;
  cpus?: number;
  memoryMb?: number;
}

export interface PullProgress {
  message: string;
}

export async function ensureImage(
  onProgress: (p: PullProgress) => void
): Promise<void> {
  try {
    await docker.getImage(RUNNER_IMAGE).inspect();
    return;
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }

  onProgress({ message: `Pulling ${RUNNER_IMAGE}…` });
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
    const state: Workspace['state'] = c.State === 'running' ? 'running' : 'stopped';
    return {
      name,
      workspaceRoot: c.Labels['com.claude-fleet.workspace-root'] ?? '',
      workspaceSubdir: c.Labels['com.claude-fleet.subdir'] ?? '',
      profile: c.Labels['com.claude-fleet.profile'] ?? '',
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

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  const envArr = ['HOME=/home/fleet', ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`)];
  const hostCfg: Docker.HostConfig = {
    Binds: [
      `${spec.workspaceRoot}:/workspace:rw`,
      `${claudeDir}:/home/fleet/.claude:rw`
    ],
    AutoRemove: false
  };
  if (spec.cpus) hostCfg.NanoCpus = Math.round(spec.cpus * 1e9);
  if (spec.memoryMb) hostCfg.Memory = spec.memoryMb * 1024 * 1024;

  const created = await docker.createContainer({
    name: spec.name,
    Image: RUNNER_IMAGE,
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
    createdAt,
    lastUsedAt: createdAt,
    state: 'running',
    containerId: info.Id,
    status: info.State.Status
  };
}

/**
 * Start the (live) workspace by name. Returns the container id if it exists
 * (whether it was already running or had to be started), or null if no live
 * container has that name and the caller should recreate from the spec.
 */
export async function startWorkspace(name: string): Promise<string | null> {
  assertValidWorkspaceName(name);
  const raw = await docker.listContainers({
    all: true,
    filters: { label: [FLEET_LABEL], name: [`^/${name}$`] }
  });
  const found = raw[0];
  if (!found) return null;

  if (found.State !== 'running') {
    const c = docker.getContainer(found.Id);
    try {
      await c.start();
    } catch (err: unknown) {
      // 304 = already started — race with another caller
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }
  return found.Id;
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

export async function attachPty(
  containerId: string,
  cols: number,
  rows: number
): Promise<PtyHandle> {
  const c = docker.getContainer(containerId);
  const exec = await c.exec({
    Cmd: ['claude'],
    Tty: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Env: [`COLUMNS=${cols}`, `LINES=${rows}`, 'TERM=xterm-256color']
  });
  const stream = (await exec.start({ Tty: true, hijack: true, stdin: true })) as Duplex;
  await exec.resize({ w: cols, h: rows });
  return {
    stream,
    resize: (c2, r2) => exec.resize({ w: c2, h: r2 }),
    detach: () => stream.destroy()
  };
}
