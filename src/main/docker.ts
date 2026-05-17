import Docker from 'dockerode';
import { mkdir, rm } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import {
  assertValidContainerName,
  containerClaudeDir,
  containerStateDir
} from './paths.js';

export const FLEET_LABEL = 'com.claude-fleet.managed';
export const RUNNER_IMAGE = 'ghcr.io/imioimi/claude-fleet/runner:latest';

const docker = new Docker();

export interface FleetContainer {
  id: string;
  name: string;
  state: string;
  status: string;
  workspaceSubdir: string;
  profile: string;
  createdAt: number;
}

export interface CreateContainerSpec {
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

export async function listContainers(): Promise<FleetContainer[]> {
  const raw = await docker.listContainers({
    all: true,
    filters: { label: [FLEET_LABEL] }
  });
  return raw.map((c) => ({
    id: c.Id,
    name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
    state: c.State,
    status: c.Status,
    workspaceSubdir: c.Labels['com.claude-fleet.subdir'] ?? '',
    profile: c.Labels['com.claude-fleet.profile'] ?? '',
    createdAt: c.Created * 1000
  }));
}

export async function createContainer(spec: CreateContainerSpec): Promise<FleetContainer> {
  assertValidContainerName(spec.name);
  const claudeDir = containerClaudeDir(spec.name);
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
      'com.claude-fleet.profile': spec.profile
    },
    HostConfig: hostCfg
  });

  await created.start();
  const info = await created.inspect();
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ''),
    state: info.State.Status,
    status: info.State.Status,
    workspaceSubdir: spec.workspaceSubdir,
    profile: spec.profile,
    createdAt: Date.parse(info.Created)
  };
}

export async function stopContainer(id: string): Promise<void> {
  const c = docker.getContainer(id);
  try {
    await c.stop({ t: 5 });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 304 && status !== 404) throw err;
  }
}

export interface RemoveContainerOpts {
  deleteState?: boolean;
}

export async function removeContainer(
  id: string,
  opts: RemoveContainerOpts = {}
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
    await rm(containerStateDir(name), { recursive: true, force: true });
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
