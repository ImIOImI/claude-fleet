// /workspace/.claude/fleet-loadouts.json: what the pinned-loadout sync installed, for an exact revert.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeLayerPath } from '../main/ociCore.js';
import { ID, SEMVER } from './loadoutPins.js';

export interface PinnedRecord {
  id: string;
  version: string;
  /** owner/repo the pin came from. */
  repo: string;
  commit: string;
  /** Workspace-relative paths applyLoadoutFiles wrote. */
  files: string[];
  claudeMd: boolean;
  settingsKeys: string[];
  mcpServers: string[];
  hooks: { event: string; entry: unknown }[];
  installedAt: number;
}

export interface RecordFile {
  version: 1;
  loadouts: PinnedRecord[];
}

export const RECORD_PATH = join('.claude', 'fleet-loadouts.json');

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

const COMMIT = /^[0-9a-f]{40}$/;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function validEntry(e: unknown, target: string): e is PinnedRecord {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.version !== 'string' || typeof r.repo !== 'string' || typeof r.commit !== 'string') return false;
  if (!ID.test(r.id) || !SEMVER.test(r.version) || !COMMIT.test(r.commit)) return false;
  if (!strings(r.files) || typeof r.claudeMd !== 'boolean' || !strings(r.settingsKeys) || !strings(r.mcpServers)) return false;
  if (typeof r.installedAt !== 'number') return false;
  if (!Array.isArray(r.hooks) || !r.hooks.every((h) => !!h && typeof h === 'object' && typeof (h as { event?: unknown }).event === 'string')) return false;
  try {
    for (const f of r.files) safeLayerPath(target, f);
  } catch {
    return false;
  }
  return true;
}

export async function readRecord(target: string): Promise<RecordFile> {
  let raw: string;
  try {
    raw = await readFile(join(target, RECORD_PATH), 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { version: 1, loadouts: [] };
    throw new RecordError(`cannot read ${RECORD_PATH}: ${code ?? 'error'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RecordError(`${RECORD_PATH} is not JSON`);
  }
  const f = parsed as { version?: unknown; loadouts?: unknown } | null;
  const entries = f && f.version === 1 && Array.isArray(f.loadouts) ? (f.loadouts as unknown[]) : null;
  if (!entries || !entries.every((e) => validEntry(e, target))) throw new RecordError(`${RECORD_PATH} is malformed`);
  const loadouts = entries as PinnedRecord[];
  if (new Set(loadouts.map((l) => l.id)).size !== loadouts.length) throw new RecordError(`${RECORD_PATH} is malformed`);
  return { version: 1, loadouts };
}

export async function writeRecord(target: string, file: RecordFile): Promise<void> {
  const path = join(target, RECORD_PATH);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, path);
}
