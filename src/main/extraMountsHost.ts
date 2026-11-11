import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  containerPathError,
  defaultContainerPath,
  normalizeContainerPath,
  type ExtraMount
} from '../preload/extraMounts.js';
import { uncToLinuxPath } from './localLauncher.js';

export interface MountCtx {
  ownId: string;
  userData: string;
  fleetRoot: string;
  docker: DockerDirs;
  platform?: NodeJS.Platform;
  /** Canonical in-distro path of an existing directory, else null. Defaults to wslRealDir. */
  wslRealDir?: (distro: string, linuxPath: string) => Promise<string | null>;
}

/** Realpaths; see dockerSocketDirs. */
export interface DockerDirs {
  /** Refused when equal to or containing a host folder; folders inside stay mountable. */
  socketDirs: string[];
  /** ~/.docker: refused when equal, inside, or containing. */
  dockerConfigDirs: string[];
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  // Only '..' or a '..'+sep prefix means outside; a name like '..x' is a real child.
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

async function realDir(p: string): Promise<string | null> {
  try {
    const real = await realpath(p);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// Mirrors docker-modem's socket resolution (dockerode is built with no options).
export async function dockerSocketDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): Promise<DockerDirs> {
  const socketDirs: string[] = [];
  const add = (list: string[], p: string | null): void => {
    if (p && !list.includes(p)) list.push(p);
  };
  if (platform !== 'win32') {
    const host = env.DOCKER_HOST;
    let sock: string | null = null;
    if (!host || host === 'unix://') sock = '/var/run/docker.sock';
    else if (host.startsWith('unix://')) sock = host.slice('unix://'.length);
    if (sock) {
      add(socketDirs, await realpath(dirname(sock)).catch(() => null));
      // The socket may be a symlink elsewhere (WSL Docker Desktop: /mnt/wsl/docker-desktop/…).
      add(socketDirs, await realpath(sock).then((r) => dirname(r), () => null));
    }
  }
  // Docker Desktop's per-user socket lives in ~/.docker/run.
  const dockerConfigDirs: string[] = [];
  add(dockerConfigDirs, await realpath(join(home, '.docker')).catch(() => null));
  return { socketDirs, dockerConfigDirs };
}

async function realOrSelf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

type HostPathIssue = 'not-absolute' | 'not-found' | 'blocked';

class HostPathProblem extends Error {
  issue: HostPathIssue;
  constructor(issue: HostPathIssue, message: string) {
    super(message);
    this.issue = issue;
  }
}

function containmentMessage(real: string, ctx: MountCtx, userData: string, fleetRoot: string): string | null {
  if (inside(real, userData) || inside(userData, real)) {
    return "that folder holds the app's private data and can't be mounted.";
  }
  if (inside(real, fleetRoot)) {
    const first = relative(fleetRoot, real).split(sep)[0] ?? '';
    if (first.toLowerCase() === 'shared' || first.toLowerCase() === ctx.ownId.toLowerCase()) return null;
    if (ULID_RE.test(first)) return "that folder is another workspace's private folder.";
    return "that folder is inside the fleet folder; only the shared folder and this workspace's own folder can be mounted.";
  }
  if (inside(fleetRoot, real)) {
    // Mounting an ancestor of the fleet root would expose every workspace's private folder.
    return "that folder contains other workspaces' private folders.";
  }
  if (
    ctx.docker.socketDirs.some((d) => inside(d, real)) ||
    ctx.docker.dockerConfigDirs.some((d) => inside(real, d) || inside(d, real))
  ) {
    return "that folder holds Docker's control socket and can't be mounted.";
  }
  return null;
}

const UNC_MESSAGE =
  "network paths (\\\\server\\share) can't be mounted. Use a local drive or a WSL path (\\\\wsl$\\<distro>\\…).";
const isUnc = (p: string): boolean => p.startsWith('\\\\') || p.startsWith('//');

const WSL_DISTRO_RE = /^[A-Za-z0-9._-]+$/;
const run = promisify(execFile);

// Resolved inside the distro: Windows realpath over 9P doesn't follow Linux symlinks.
export async function wslRealDir(distro: string, linuxPath: string): Promise<string | null> {
  const opts = { windowsHide: true, timeout: 15_000 };
  try {
    const { stdout } = await run('wsl.exe', ['-d', distro, '--exec', 'realpath', '-e', '--', linuxPath], opts);
    const real = stdout.trim();
    if (!real.startsWith('/')) return null;
    await run('wsl.exe', ['-d', distro, '--exec', 'test', '-d', real], opts);
    return real;
  } catch {
    return null;
  }
}

const posixInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);
const WSL_SYSTEM = ['/proc', '/sys', '/dev', '/run', '/var/run'];
const WSL_GUARDED = [...WSL_SYSTEM, '/mnt', '/home', '/root'];

function wslContainmentMessage(real: string): string | null {
  // drvfs Windows drives and Docker Desktop's /mnt/wsl integration.
  if (posixInside(real, '/mnt')) {
    return "that's a Windows drive or Docker Desktop folder inside WSL. Use the C:\\… path instead.";
  }
  if (WSL_SYSTEM.some((d) => posixInside(real, d))) return "that's a system folder and can't be mounted.";
  if (real === '/root' || /^\/home\/[^/]+$/.test(real)) {
    return "that's a whole home folder (it holds .claude and .docker). Mount a folder inside it.";
  }
  if (WSL_GUARDED.some((g) => posixInside(g, real))) return "that folder contains system or Docker folders and can't be mounted.";
  if (real.split('/').includes('.docker')) return "that folder holds Docker's settings and can't be mounted.";
  return null;
}

// Returns the Docker bind Source: \\wsl$\<distro>\… (the only form verified with Docker Desktop).
async function checkWslPath(hostPath: string, wsl: { distro: string; path: string }, ctx: MountCtx): Promise<string> {
  if (!WSL_DISTRO_RE.test(wsl.distro)) {
    throw new HostPathProblem('blocked', `"${wsl.distro}" isn't a WSL distro name that can be mounted.`);
  }
  const resolved = await (ctx.wslRealDir ?? wslRealDir)(wsl.distro, posix.normalize(wsl.path));
  if (!resolved) throw new HostPathProblem('not-found', `${hostPath} doesn't exist or isn't a folder.`);
  const real = posix.normalize(resolved);
  const blocked = wslContainmentMessage(real);
  if (blocked) throw new HostPathProblem('blocked', blocked);
  return `\\\\wsl$\\${wsl.distro}${real.replace(/\//g, '\\')}`;
}

// Shared by validateExtraMounts (save-time) and toDockerMounts (create-time
// revalidation, closing a symlink-retarget TOCTOU gap). Returns the Docker bind Source.
async function checkHostPath(hostPath: string, ctx: MountCtx, userData: string, fleetRoot: string): Promise<string> {
  if (isUnc(hostPath)) {
    const wsl = (ctx.platform ?? process.platform) === 'win32' ? uncToLinuxPath(hostPath) : null;
    if (!wsl) throw new HostPathProblem('blocked', UNC_MESSAGE);
    return checkWslPath(hostPath, wsl, ctx);
  }
  if (!isAbsolute(hostPath)) throw new HostPathProblem('not-absolute', `${hostPath} must be a full path.`);
  const real = await realDir(hostPath);
  if (!real) throw new HostPathProblem('not-found', `${hostPath} doesn't exist or isn't a folder.`);
  if (isUnc(real)) throw new HostPathProblem('blocked', UNC_MESSAGE);
  const blocked = containmentMessage(real, ctx, userData, fleetRoot);
  if (blocked) throw new HostPathProblem('blocked', blocked);
  return real;
}

export async function validateExtraMounts(
  mounts: ExtraMount[] | undefined,
  ctx: MountCtx
): Promise<ExtraMount[] | undefined> {
  if (!mounts?.length) return undefined;
  const userData = await realOrSelf(ctx.userData);
  const fleetRoot = await realOrSelf(ctx.fleetRoot);
  for (const [i, m] of mounts.entries()) {
    try {
      await checkHostPath(m.hostPath, ctx, userData, fleetRoot);
    } catch (e) {
      if (e instanceof HostPathProblem) throw new Error(`Mount ${i + 1}: ${e.message}`);
      throw e;
    }
  }
  return checkContainerPaths(mounts);
}

// Pure rules only; returns mounts with normalized/defaulted container paths.
function checkContainerPaths(mounts: ExtraMount[]): ExtraMount[] {
  const out: ExtraMount[] = [];
  for (const [i, m] of mounts.entries()) {
    const containerPath = normalizeContainerPath(m.containerPath.trim() || defaultContainerPath(m.hostPath));
    const err = containerPathError(containerPath, m.hostPath);
    if (err) throw new Error(`Mount ${i + 1}: ${err}`);
    out.push({ hostPath: m.hostPath, containerPath, readOnly: m.readOnly === true });
  }
  const seen = new Set<string>();
  for (const [i, m] of out.entries()) {
    if (seen.has(m.containerPath)) throw new Error(`Mount ${i + 1}: ${m.containerPath} is already used by another mount.`);
    seen.add(m.containerPath);
  }
  return out;
}

function sameMounts(a: ExtraMount[] | undefined, b: ExtraMount[] | undefined): boolean {
  if (!a?.length || !b?.length) return !a?.length && !b?.length;
  return (
    a.length === b.length &&
    a.every(
      (m, i) => m.hostPath === b[i]!.hostPath && m.containerPath === b[i]!.containerPath && m.readOnly === b[i]!.readOnly
    )
  );
}

// Unchanged mounts skip host (filesystem) checks — toDockerMounts re-checks at create —
// so an unrelated edit doesn't fail while a mount's folder is temporarily missing.
export async function mountsForWrite(
  incoming: ExtraMount[] | undefined,
  existing: ExtraMount[] | undefined,
  ctx: MountCtx
): Promise<ExtraMount[] | undefined> {
  if (sameMounts(incoming, existing)) return existing?.length ? checkContainerPaths(existing) : undefined;
  return validateExtraMounts(incoming, ctx);
}

export async function toDockerMounts(
  mounts: ExtraMount[] | undefined,
  ctx: MountCtx
): Promise<Array<{ Type: 'bind'; Source: string; Target: string; ReadOnly: boolean }>> {
  const out: Array<{ Type: 'bind'; Source: string; Target: string; ReadOnly: boolean }> = [];
  if (!mounts?.length) return out;
  const userData = await realOrSelf(ctx.userData);
  const fleetRoot = await realOrSelf(ctx.fleetRoot);
  for (const m of mounts) {
    let real: string;
    try {
      real = await checkHostPath(m.hostPath, ctx, userData, fleetRoot);
    } catch (e) {
      if (e instanceof HostPathProblem) {
        throw new Error(
          e.issue === 'blocked'
            ? `extra mount ${m.hostPath} now points somewhere that can't be mounted`
            : `extra mount ${m.hostPath} no longer exists`
        );
      }
      throw e;
    }
    out.push({ Type: 'bind', Source: real, Target: m.containerPath, ReadOnly: m.readOnly === true });
  }
  return out;
}
