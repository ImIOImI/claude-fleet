// Knowledge capture (#483 §5a): make transcriptRetentionDays effective as
// Claude Code's cleanupPeriodDays, so search-hit capture can still fork
// sessions older than Claude's 30-day default. The app only ever RAISES
// retention, never lowers it:
//   container: the host side of the bind-mounted ~/.claude/settings.json,
//              never lowering a higher value already there
//   local/WSL: a per-workspace file passed as --settings on the app's own
//              launches, only when the workspace value beats the user's own
//              effective cleanupPeriodDays (local launches share the user's
//              real ~/.claude/projects, and --settings overrides theirs)
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomicWrite.js';
import { linuxPathToUnc, type WorkspaceLauncher } from '../localLauncher.js';
import { workspaceClaudeDir, workspaceStateDir } from '../paths.js';

export const LOCAL_RETENTION_SETTINGS_FILE = 'claude-retention.settings.json';
/** Claude Code's cleanupPeriodDays when the user hasn't set one. */
export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;

function cleanupDaysOf(o: Record<string, unknown>): number | null {
  const v = o.cleanupPeriodDays;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Merge cleanupPeriodDays into a Claude settings.json body. Returns the new
 *  text, or null when nothing changes, the file already holds a higher value
 *  (never lowered), or the file isn't a JSON object (a malformed user file is
 *  left alone, never clobbered). */
export function mergeCleanupPeriod(existing: string | null, days: number): string | null {
  if (existing === null || existing.trim() === '') return JSON.stringify({ cleanupPeriodDays: days }, null, 2) + '\n';
  let parsed: unknown;
  try { parsed = JSON.parse(existing); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const cur = cleanupDaysOf(o);
  if (cur !== null && cur >= days) return null;
  return JSON.stringify({ ...o, cleanupPeriodDays: days }, null, 2) + '\n';
}

/** The user's effective cleanupPeriodDays from their settings.json body;
 *  absent, unreadable or malformed ⇒ Claude's default (30). */
export function userCleanupDays(text: string | null): number {
  if (text === null) return CLAUDE_DEFAULT_CLEANUP_DAYS;
  try {
    const o = JSON.parse(text) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return CLAUDE_DEFAULT_CLEANUP_DAYS;
    return cleanupDaysOf(o as Record<string, unknown>) ?? CLAUDE_DEFAULT_CLEANUP_DAYS;
  } catch {
    return CLAUDE_DEFAULT_CLEANUP_DAYS;
  }
}

/** Host-readable path of the user settings file a local launch's claude reads:
 *  native ⇒ $CLAUDE_CONFIG_DIR or ~/.claude; WSL ⇒ the distro user's
 *  ~/.claude over \\wsl.localhost. Null for launchers we can't see into. */
export function userClaudeSettingsPath(launcher: WorkspaceLauncher): string | null {
  if (launcher.mode === 'native') return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  if (launcher.mode === 'wsl') return linuxPathToUnc(launcher.distro, `${launcher.home}/.claude/settings.json`);
  return null;
}

export async function ensureContainerRetention(id: string, days: number): Promise<boolean> {
  const dir = workspaceClaudeDir(id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const next = mergeCleanupPeriod(await readFile(file, 'utf8').catch(() => null), days);
  if (next === null) return false;
  await writeFileAtomic(file, next);
  return true;
}

const readText = (p: string): Promise<string | null> => readFile(p, 'utf8').catch(() => null);

/** The --settings file for a local/WSL launch, or undefined when the user's
 *  own retention is already at least `days` (then no --settings is passed, so
 *  theirs applies untouched). */
export async function ensureLocalRetentionSettings(
  id: string, days: number, launcher: WorkspaceLauncher, readUserSettings: (path: string) => Promise<string | null> = readText
): Promise<string | undefined> {
  const userPath = userClaudeSettingsPath(launcher);
  const userDays = userCleanupDays(userPath ? await readUserSettings(userPath) : null);
  if (userDays >= days) return undefined;
  const dir = workspaceStateDir(id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, LOCAL_RETENTION_SETTINGS_FILE);
  await writeFileAtomic(file, JSON.stringify({ cleanupPeriodDays: days }) + '\n');
  return file;
}
