import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
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
  return null;
}

// Shared by validateExtraMounts (save-time) and toDockerMounts (create-time
// revalidation, closing a symlink-retarget TOCTOU gap). Returns the resolved realpath.
async function checkHostPath(hostPath: string, ctx: MountCtx, userData: string, fleetRoot: string): Promise<string> {
  if (!isAbsolute(hostPath)) throw new HostPathProblem('not-absolute', `${hostPath} must be a full path.`);
  const real = await realDir(hostPath);
  if (!real) throw new HostPathProblem('not-found', `${hostPath} doesn't exist or isn't a folder.`);
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
  const out: ExtraMount[] = [];
  for (const [i, m] of mounts.entries()) {
    const label = `Mount ${i + 1}`;
    try {
      await checkHostPath(m.hostPath, ctx, userData, fleetRoot);
    } catch (e) {
      if (e instanceof HostPathProblem) throw new Error(`${label}: ${e.message}`);
      throw e;
    }
    const containerPath = normalizeContainerPath(m.containerPath.trim() || defaultContainerPath(m.hostPath));
    const err = containerPathError(containerPath, m.hostPath);
    if (err) throw new Error(`${label}: ${err}`);
    out.push({ hostPath: m.hostPath, containerPath, readOnly: m.readOnly === true });
  }
  const seen = new Set<string>();
  for (const [i, m] of out.entries()) {
    if (seen.has(m.containerPath)) throw new Error(`Mount ${i + 1}: ${m.containerPath} is already used by another mount.`);
    seen.add(m.containerPath);
  }
  return out;
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
