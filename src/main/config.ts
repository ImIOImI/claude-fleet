// App-level settings, persisted to <userData>/config.json. Currently just the
// "fleet root" — the single host directory that holds every workspace's
// private folder (<fleetRoot>/<id>) plus the cross-container shared folder
// (<fleetRoot>/shared). Replaces the old per-workspace "workspace root" the
// create form used to collect.

import { app } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assertValidWorkspaceId } from './paths.js';

interface AppConfig {
  fleetRoot?: string;
  /** When true, the app skips Chromium hardware acceleration at startup. */
  disableHardwareAcceleration?: boolean;
  /** When true (default), installing/updating a loadout into a running
   *  workspace auto-reloads its Claude session (`--resume`) to load the loadout
   *  — but only while Claude is idle; deferred until it stops working. (#16) */
  autoReloadLoadouts?: boolean;
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
      fleetRoot: typeof parsed.fleetRoot === 'string' && parsed.fleetRoot ? parsed.fleetRoot : undefined,
      disableHardwareAcceleration: parsed.disableHardwareAcceleration === true,
      // Persist as-is so an explicit `false` survives a reload; absent ⇒ default
      // on (see getAutoReloadLoadouts).
      autoReloadLoadouts:
        typeof parsed.autoReloadLoadouts === 'boolean' ? parsed.autoReloadLoadouts : undefined
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

/**
 * The fleet root. Precedence: `CLAUDE_FLEET_ROOT` env override (used by the
 * e2e suite to keep test runs out of the real `~/fleet`) → the persisted
 * config value → the `~/fleet` default. Always absolute.
 */
export async function getFleetRoot(): Promise<string> {
  const override = process.env.CLAUDE_FLEET_ROOT?.trim();
  if (override) return override;
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

/**
 * Whether to disable Chromium hardware acceleration, decided at startup.
 * Precedence: `CLAUDE_FLEET_DISABLE_HWA=1` env override (dev shortcut) → the
 * persisted setting → off. Read **synchronously** because
 * `app.disableHardwareAcceleration()` must be called before the `ready`
 * event, before the async config cache is warmed. `app.getPath('userData')`
 * is available this early.
 */
export function hardwareAccelDisabledAtStartup(): boolean {
  if (process.env.CLAUDE_FLEET_DISABLE_HWA === '1') return true;
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as AppConfig;
    return parsed.disableHardwareAcceleration === true;
  } catch {
    return false;
  }
}

/** The persisted hardware-acceleration setting (ignores the env override). */
export async function getHardwareAccelDisabled(): Promise<boolean> {
  const cfg = await read();
  return cfg.disableHardwareAcceleration === true;
}

/** Persist the hardware-acceleration setting. Takes effect on next launch. */
export async function setHardwareAccelDisabled(disabled: boolean): Promise<void> {
  const cfg = await read();
  await write({ ...cfg, disableHardwareAcceleration: disabled });
}

/** Auto-reload loadouts into a running workspace when Claude is idle. Default on. */
export async function getAutoReloadLoadouts(): Promise<boolean> {
  const cfg = await read();
  return cfg.autoReloadLoadouts !== false; // default true
}

export async function setAutoReloadLoadouts(enabled: boolean): Promise<void> {
  const cfg = await read();
  await write({ ...cfg, autoReloadLoadouts: enabled });
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
