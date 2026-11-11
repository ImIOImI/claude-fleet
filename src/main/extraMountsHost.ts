import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
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
  /** Defaults to wslRealDir. */
  wslRealDir?: (distro: string, linuxPath: string) => Promise<WslResolved | null>;
}

export interface WslMount {
  dir: string;
  fstype: string;
}

/** Canonical in-distro path of an existing directory plus the distro's mount table. */
export interface WslResolved {
  real: string;
  mounts: WslMount[];
}

/** Realpaths; see dockerSocketDirs. */
export interface DockerDirs {
  /** Refused when equal to or containing a host folder; folders inside stay mountable. */
  socketDirs: string[];
  /** ~/.docker: refused when equal, inside, or containing. */
  dockerConfigDirs: string[];
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

type PathOps = Pick<typeof posix, 'relative' | 'isAbsolute' | 'sep'>;
const hostOps: PathOps = { relative, isAbsolute, sep };

function inside(child: string, parent: string, ops: PathOps = hostOps): boolean {
  const rel = ops.relative(parent, child);
  if (rel === '') return true;
  if (ops.isAbsolute(rel)) return false;
  // Only '..' or a '..'+sep prefix means outside; a name like '..x' is a real child.
  return rel !== '..' && !rel.startsWith(`..${ops.sep}`);
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

// A null userData/fleetRoot lives where `real` can't reach (e.g. a different WSL distro).
function appDataMessage(
  real: string,
  ownId: string,
  userData: string | null,
  fleetRoot: string | null,
  ops: PathOps = hostOps
): string | null {
  if (userData !== null && (inside(real, userData, ops) || inside(userData, real, ops))) {
    return "that folder holds the app's private data and can't be mounted.";
  }
  if (fleetRoot === null) return null;
  if (inside(real, fleetRoot, ops)) {
    const first = ops.relative(fleetRoot, real).split(ops.sep)[0] ?? '';
    if (first.toLowerCase() === 'shared' || first.toLowerCase() === ownId.toLowerCase()) return null;
    if (ULID_RE.test(first)) return "that folder is another workspace's private folder.";
    return "that folder is inside the fleet folder; only the shared folder and this workspace's own folder can be mounted.";
  }
  if (inside(fleetRoot, real, ops)) {
    // Mounting an ancestor of the fleet root would expose every workspace's private folder.
    return "that folder contains other workspaces' private folders.";
  }
  return null;
}

function containmentMessage(real: string, ctx: MountCtx, userData: string, fleetRoot: string): string | null {
  const app = appDataMessage(real, ctx.ownId, userData, fleetRoot);
  if (app) return app;
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

const WSL_DISTRO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MOUNTS_MARKER = '\n--MOUNTS--\n';
// Fixed script; the path only ever arrives as $1. test -d follows symlinks like realpath does.
// No $(…) capture: it would strip trailing newlines from the printed path.
const WSL_RESOLVE_SCRIPT = [
  'test -d "$1" || exit 1',
  'realpath -e -- "$1" 2>/dev/null || { test -e "$1" && readlink -f -- "$1"; } || exit 1',
  "printf '%s\\n' '--MOUNTS--'",
  'cat /proc/self/mounts'
].join('\n');

export type ExecRunner = (file: string, args: string[]) => Promise<string>;

const runWsl: ExecRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

const decodeMountField = (f: string): string => f.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

// Resolved inside the distro: Windows realpath over 9P doesn't follow Linux symlinks.
export async function wslRealDir(distro: string, linuxPath: string, exec: ExecRunner = runWsl): Promise<WslResolved | null> {
  let out: string;
  try {
    out = await exec('wsl.exe', ['-d', distro, '--exec', 'sh', '-c', WSL_RESOLVE_SCRIPT, 'sh', linuxPath]);
  } catch {
    return null;
  }
  // Last marker: /proc/self/mounts escapes newlines, so it can't contain one; the path can.
  const at = out.lastIndexOf(MOUNTS_MARKER);
  if (at < 0) return null;
  const real = out.slice(0, at);
  if (!real.startsWith('/')) return null;
  const mounts: WslMount[] = [];
  for (const line of out.slice(at + MOUNTS_MARKER.length).split('\n')) {
    const [, dir, fstype] = line.split(' ');
    if (dir && fstype) mounts.push({ dir: decodeMountField(dir), fstype });
  }
  return { real, mounts };
}

const posixOps: PathOps = posix;
const posixInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);
const WSL_SYSTEM = ['/proc', '/sys', '/dev', '/run', '/var/run'];
const WSL_GUARDED = [...WSL_SYSTEM, '/mnt', '/home', '/root'];
const WINDOWS_FS = new Set(['9p', 'drvfs', 'v9fs', 'virtiofs']);
const isNetworkFs = (fstype: string): boolean => ['cifs', 'smb3', 'smbfs'].includes(fstype) || fstype.startsWith('nfs');
const WINDOWS_FS_MESSAGE = "that's a Windows drive or Docker Desktop folder inside WSL. Use the C:\\… path instead.";
// Windows re-parses the \\wsl$ Source: '\' splits segments, trailing dots/spaces are stripped.
const SAFE_SEGMENT = /^[A-Za-z0-9._@+ -]+$/;

function windowsSafeLinuxPath(real: string): boolean {
  if (real === '/') return true;
  return real
    .slice(1)
    .split('/')
    .every((seg) => SAFE_SEGMENT.test(seg) && seg !== '.' && seg !== '..' && !/[. ]$/.test(seg));
}

function wslContainmentMessage(real: string, mounts: WslMount[]): string | null {
  // Default drvfs automount root and Docker Desktop's /mnt/wsl integration.
  if (posixInside(real, '/mnt')) return WINDOWS_FS_MESSAGE;
  // wsl.conf automount root or fstab can put Windows filesystems anywhere.
  if (mounts.some((m) => WINDOWS_FS.has(m.fstype) && (posixInside(real, m.dir) || posixInside(m.dir, real)))) {
    return WINDOWS_FS_MESSAGE;
  }
  if (mounts.some((m) => isNetworkFs(m.fstype) && (posixInside(real, m.dir) || posixInside(m.dir, real)))) {
    return "that folder is on a network share inside WSL and can't be mounted.";
  }
  if (WSL_SYSTEM.some((d) => posixInside(real, d))) return "that's a system folder and can't be mounted.";
  if (real === '/root' || /^\/home\/[^/]+$/.test(real)) {
    return "that's a whole home folder (it holds .claude and .docker). Mount a folder inside it.";
  }
  if (WSL_GUARDED.some((g) => posixInside(g, real))) return "that folder contains system or Docker folders and can't be mounted.";
  if (real.split('/').includes('.docker')) return "that folder holds Docker's settings and can't be mounted.";
  return null;
}

type Resolver = NonNullable<MountCtx['wslRealDir']>;

// In-distro path of an app folder in the same distro; null when it lives elsewhere.
async function sameDistroPath(appPath: string, distro: string, resolve: Resolver): Promise<string | null> {
  const wsl = uncToLinuxPath(appPath);
  if (!wsl || wsl.distro.toLowerCase() !== distro.toLowerCase()) return null;
  const linux = posix.normalize(wsl.path);
  return (await resolve(wsl.distro, linux))?.real ?? linux;
}

// Returns the Docker bind Source: \\wsl$\<distro>\… (the only form verified with Docker Desktop).
async function checkWslPath(
  hostPath: string,
  wsl: { distro: string; path: string },
  ctx: MountCtx,
  userData: string,
  fleetRoot: string
): Promise<string> {
  if (!WSL_DISTRO_RE.test(wsl.distro)) {
    throw new HostPathProblem('blocked', `"${wsl.distro}" isn't a WSL distro name that can be mounted.`);
  }
  if (/^docker-desktop/i.test(wsl.distro)) {
    throw new HostPathProblem('blocked', "that's Docker Desktop's own WSL distro and can't be mounted.");
  }
  const resolve: Resolver = ctx.wslRealDir ?? ((d, p) => wslRealDir(d, p));
  const resolved = await resolve(wsl.distro, posix.normalize(wsl.path));
  if (!resolved) throw new HostPathProblem('not-found', `${hostPath} doesn't exist or isn't a folder.`);
  const { real, mounts } = resolved;
  if (!real.startsWith('/') || !windowsSafeLinuxPath(real)) {
    throw new HostPathProblem(
      'blocked',
      "that folder's path has characters Windows can't pass to Docker safely. Rename it or pick another folder."
    );
  }
  const blocked =
    wslContainmentMessage(real, mounts) ??
    appDataMessage(
      real,
      ctx.ownId,
      await sameDistroPath(userData, wsl.distro, resolve),
      await sameDistroPath(fleetRoot, wsl.distro, resolve),
      posixOps
    );
  if (blocked) throw new HostPathProblem('blocked', blocked);
  return `\\\\wsl$\\${wsl.distro}${real.replace(/\//g, '\\')}`;
}

// Shared by validateExtraMounts (save-time) and toDockerMounts (create-time
// revalidation, closing a symlink-retarget TOCTOU gap). Returns the Docker bind Source.
async function checkHostPath(hostPath: string, ctx: MountCtx, userData: string, fleetRoot: string): Promise<string> {
  if (isUnc(hostPath)) {
    const wsl = (ctx.platform ?? process.platform) === 'win32' ? uncToLinuxPath(hostPath) : null;
    if (!wsl) throw new HostPathProblem('blocked', UNC_MESSAGE);
    return checkWslPath(hostPath, wsl, ctx, userData, fleetRoot);
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
