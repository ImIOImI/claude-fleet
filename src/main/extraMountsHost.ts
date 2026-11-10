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

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
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
    const real = await realDir(m.hostPath);
    if (!real) throw new Error(`${label}: ${m.hostPath} doesn't exist or isn't a folder.`);
    if (inside(real, userData) || inside(userData, real)) {
      throw new Error(`${label}: that folder holds the app's private data and can't be mounted.`);
    }
    if (inside(real, fleetRoot)) {
      const first = relative(fleetRoot, real).split(sep)[0] ?? '';
      if (ULID_RE.test(first) && first !== ctx.ownId) {
        throw new Error(`${label}: that folder is another workspace's private folder.`);
      }
    } else if (inside(fleetRoot, real)) {
      // Mounting an ancestor of the fleet root would expose every workspace's private folder.
      throw new Error(`${label}: that folder contains other workspaces' private folders.`);
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
  mounts: ExtraMount[] | undefined
): Promise<Array<{ Type: 'bind'; Source: string; Target: string; ReadOnly: boolean }>> {
  const out: Array<{ Type: 'bind'; Source: string; Target: string; ReadOnly: boolean }> = [];
  for (const m of mounts ?? []) {
    if (!(await realDir(m.hostPath))) throw new Error(`extra mount ${m.hostPath} no longer exists`);
    out.push({ Type: 'bind', Source: m.hostPath, Target: m.containerPath, ReadOnly: m.readOnly });
  }
  return out;
}
