import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  containerPathError,
  defaultContainerPath,
  normalizeContainerPath,
  type ExtraMount
} from '../preload/extraMounts.js';

export interface MountCtx {
  ownId: string;
  userData: string;
  fleetRoot: string;
  /** Realpaths; see dockerSocketDirs. */
  dockerSocketDirs: string[];
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
): Promise<string[]> {
  const candidates: string[] = [];
  if (platform !== 'win32') {
    const host = env.DOCKER_HOST;
    if (!host || host === 'unix://') candidates.push('/var/run');
    else if (host.startsWith('unix://')) candidates.push(dirname(host.slice('unix://'.length)));
  }
  // Docker Desktop's per-user socket lives in ~/.docker/run.
  candidates.push(join(home, '.docker'));
  const out: string[] = [];
  for (const c of candidates) {
    const real = await realpath(c).catch(() => null);
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
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
  if (ctx.dockerSocketDirs.some((d) => inside(real, d) || inside(d, real))) {
    return "that folder holds Docker's control socket and can't be mounted.";
  }
  return null;
}

// Shared by validateExtraMounts (save-time) and toDockerMounts (create-time
// revalidation, closing a symlink-retarget TOCTOU gap). Returns the resolved realpath.
const UNC_MESSAGE =
  "network and WSL paths (\\\\server\\… or \\\\wsl.localhost\\…) can't be mounted. Use a local drive path.";
const isUnc = (p: string): boolean => p.startsWith('\\\\') || p.startsWith('//');

async function checkHostPath(hostPath: string, ctx: MountCtx, userData: string, fleetRoot: string): Promise<string> {
  if (isUnc(hostPath)) throw new HostPathProblem('blocked', UNC_MESSAGE);
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
