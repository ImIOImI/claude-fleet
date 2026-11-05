// Knowledge capture (#483 §5a): make transcriptRetentionDays effective as
// Claude Code's cleanupPeriodDays, so search-hit capture can still fork
// sessions older than Claude's 30-day default.
//   container: the host side of the bind-mounted ~/.claude/settings.json
//   local/WSL: a per-workspace file passed as --settings on the app's own launches
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomicWrite.js';
import { workspaceClaudeDir, workspaceStateDir } from '../paths.js';

export const LOCAL_RETENTION_SETTINGS_FILE = 'claude-retention.settings.json';

/** Merge cleanupPeriodDays into a Claude settings.json body. Returns the new
 *  text, or null when nothing changes or the file isn't a JSON object (a
 *  malformed user file is left alone, never clobbered). */
export function mergeCleanupPeriod(existing: string | null, days: number): string | null {
  if (existing === null || existing.trim() === '') return JSON.stringify({ cleanupPeriodDays: days }, null, 2) + '\n';
  let parsed: unknown;
  try { parsed = JSON.parse(existing); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o.cleanupPeriodDays === days) return null;
  return JSON.stringify({ ...o, cleanupPeriodDays: days }, null, 2) + '\n';
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

export async function ensureLocalRetentionSettings(id: string, days: number): Promise<string> {
  const dir = workspaceStateDir(id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, LOCAL_RETENTION_SETTINGS_FILE);
  await writeFile(file, JSON.stringify({ cleanupPeriodDays: days }) + '\n', 'utf8');
  return file;
}
