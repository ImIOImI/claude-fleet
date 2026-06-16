// App-level settings, persisted to <userData>/config.json. Currently just the
// "fleet root" — the single host directory that holds every workspace's
// private folder (<fleetRoot>/<id>) plus the cross-container shared folder
// (<fleetRoot>/shared). Replaces the old per-workspace "workspace root" the
// create form used to collect.

import { app } from 'electron';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assertValidWorkspaceId } from './paths.js';

interface AppConfig {
  fleetRoot?: string;
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

/** Default fleet root: `~/fleet`. Portable, and matches existing setups. */
export function defaultFleetRoot(): string {
  return join(app.getPath('home'), 'fleet');
}

let cached: AppConfig | null = null;

async function read(): Promise<AppConfig> {
  if (cached) return cached;
  try {
    const raw = await readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as AppConfig;
    cached = {
      fleetRoot: typeof parsed.fleetRoot === 'string' && parsed.fleetRoot ? parsed.fleetRoot : undefined
    };
  } catch {
    cached = {};
  }
  return cached;
}

async function write(next: AppConfig): Promise<void> {
  cached = next;
  await writeFile(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/** The configured fleet root, or the default when unset. Always absolute. */
export async function getFleetRoot(): Promise<string> {
  const cfg = await read();
  return cfg.fleetRoot ?? defaultFleetRoot();
}

/** Persist a new fleet root. The directory is created if it doesn't exist. */
export async function setFleetRoot(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) throw new Error('Fleet root cannot be empty');
  await mkdir(trimmed, { recursive: true });
  const cfg = await read();
  await write({ ...cfg, fleetRoot: trimmed });
}

/** `<fleetRoot>/<id>` — a workspace's private folder, mounted at /workspace. */
export async function fleetPrivateDir(id: string): Promise<string> {
  assertValidWorkspaceId(id);
  return join(await getFleetRoot(), id);
}

/** `<fleetRoot>/shared` — mounted into every container at /shared (rw). */
export async function fleetSharedDir(): Promise<string> {
  return join(await getFleetRoot(), 'shared');
}

/** Test-only: drop the in-memory cache so a fresh read hits disk. */
export function _resetConfigCacheForTests(): void {
  cached = null;
}
