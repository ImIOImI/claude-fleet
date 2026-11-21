// FLEET_LOADOUTS pins, the sync's settings and its plan (pure).
import type { PinnedRecord } from './loadoutRecord.js';

export interface Pin {
  id: string;
  version: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface SyncPlan {
  unchanged: PinnedRecord[];
  revert: PinnedRecord[];
  install: { pin: Pin; previous: PinnedRecord | null }[];
}

export const DEFAULT_LOADOUTS_REPO = 'SumerSports/claude-fleet-loadouts';
export const DEFAULT_LOADOUTS_API = 'https://api.github.com';
export const DEFAULT_SYNC_TIMEOUT_S = 60;

export const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;

export class PinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinError';
  }
}

export function parsePins(text: string | undefined): Pin[] {
  const seen = new Set<string>();
  return (text ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => {
      const at = token.indexOf('@');
      const id = at > 0 ? token.slice(0, at) : '';
      const version = at > 0 ? token.slice(at + 1) : '';
      if (!ID.test(id) || !SEMVER.test(version)) throw new PinError(`FLEET_LOADOUTS: "${token.slice(0, 120)}" is not <id>@<semver>`);
      if (seen.has(id)) throw new PinError(`FLEET_LOADOUTS: ${id} is pinned twice`);
      seen.add(id);
      return { id, version };
    });
}

export function parseRepo(text: string | undefined): RepoRef {
  const s = (text ?? '').trim() || DEFAULT_LOADOUTS_REPO;
  const parts = s.split('/');
  const [owner, repo] = parts;
  if (parts.length !== 2 || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
    throw new PinError(`FLEET_LOADOUTS_REPO: "${s.slice(0, 160)}" is not <owner>/<repo>`);
  }
  return { owner, repo };
}

export function parseApiBase(text: string | undefined): string {
  const s = (text ?? '').trim() || DEFAULT_LOADOUTS_API;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new PinError('FLEET_LOADOUTS_API is not a URL');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
    throw new PinError('FLEET_LOADOUTS_API must be an http(s) URL without credentials, query or fragment');
  }
  return u.href.replace(/\/+$/, '');
}

export function parseTimeoutS(text: string | undefined): number {
  if (!text) return DEFAULT_SYNC_TIMEOUT_S;
  const n = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
  if (!(n >= 1 && n <= 600)) throw new PinError('FLEET_LOADOUTS_TIMEOUT_S must be 1 to 600');
  return n;
}

export function pinTag(p: Pin): string {
  return `${p.id}/v${p.version}`;
}

export function planSync(pins: Pin[], repo: RepoRef, installed: PinnedRecord[]): SyncPlan {
  const full = `${repo.owner}/${repo.repo}`.toLowerCase();
  const byId = new Map(installed.map((r) => [r.id, r]));
  const pinned = new Set(pins.map((p) => p.id));
  const plan: SyncPlan = { unchanged: [], revert: installed.filter((r) => !pinned.has(r.id)), install: [] };
  for (const pin of pins) {
    const previous = byId.get(pin.id) ?? null;
    if (previous && previous.version === pin.version && previous.repo.toLowerCase() === full) plan.unchanged.push(previous);
    else plan.install.push({ pin, previous });
  }
  return plan;
}
