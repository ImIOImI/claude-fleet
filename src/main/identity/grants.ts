// Grant tiers (remote-workspaces §5). Pure: fleet-host (sub-project (c)) maps a
// verified Identity plus its deployment's grant rules to a tier, and checks
// each route/frame with tierAtLeast. No match means no access (403).

import type { Identity } from './types.js';

export type Tier = 'read' | 'steer' | 'session';
/** Cumulative, lowest first. */
export const TIERS: readonly Tier[] = ['read', 'steer', 'session'];

export type GrantRule = { team: string; tier: Tier } | { login: string; tier: Tier };
export interface MachineRule {
  appId: number;
  login: string;
  tier: Tier;
}
export interface GrantConfig {
  grants: GrantRule[];
  machines: MachineRule[];
}

const rank = (t: Tier): number => TIERS.indexOf(t);
const lc = (s: string): string => s.toLowerCase();

export function tierAtLeast(have: Tier | null, need: Tier): boolean {
  return have !== null && rank(have) >= rank(need);
}

function higher(a: Tier | null, b: Tier): Tier {
  return a === null || rank(b) > rank(a) ? b : a;
}

/**
 * The highest tier any matching rule grants, or null (no access). People match
 * `grants` by team or login; machines match only `machines` by login — a
 * user-shaped rule never admits a machine, and vice versa.
 */
export function resolveTier(who: Pick<Identity, 'kind' | 'login' | 'teams'>, config: GrantConfig): Tier | null {
  const login = lc(who.login);
  let best: Tier | null = null;
  if (who.kind === 'machine') {
    for (const m of config.machines) if (lc(m.login) === login) best = higher(best, m.tier);
    return best;
  }
  const teams = new Set(who.teams.map(lc));
  for (const g of config.grants) {
    const hit = 'team' in g ? teams.has(lc(g.team)) : lc(g.login) === login;
    if (hit) best = higher(best, g.tier);
  }
  return best;
}

export class GrantConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantConfigError';
  }
}

const TEAM_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const LOGIN_RE = /^[A-Za-z0-9-]+$/;
const BOT_RE = /^[A-Za-z0-9-]+\[bot\]$/;

function parseTier(v: unknown, path: string): Tier {
  if (v === 'read' || v === 'steer' || v === 'session') return v;
  throw new GrantConfigError(`${path}.tier must be one of read, steer, session`);
}

function asRecord(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new GrantConfigError(`${path} must be an object`);
  return v as Record<string, unknown>;
}

/**
 * Validate deployment-provided grant config (host config YAML, already parsed).
 * Throws GrantConfigError naming the offending path. Unknown keys are ignored
 * so the same object can carry `identity: {...}` and other host settings.
 */
export function parseGrantConfig(raw: unknown): GrantConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GrantConfigError('grant config must be an object');
  const o = raw as Record<string, unknown>;
  const list = (k: string): unknown[] => {
    const v = o[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new GrantConfigError(`${k} must be a list`);
    return v;
  };

  const grants = list('grants').map((g, i): GrantRule => {
    const p = `grants[${i}]`;
    const r = asRecord(g, p);
    const hasTeam = 'team' in r;
    const hasLogin = 'login' in r;
    if (hasTeam === hasLogin) throw new GrantConfigError(`${p} needs exactly one of team or login`);
    const tier = parseTier(r.tier, p);
    if (hasTeam) {
      if (typeof r.team !== 'string' || !TEAM_RE.test(r.team)) {
        throw new GrantConfigError(`${p}.team must look like org/team-slug`);
      }
      return { team: r.team, tier };
    }
    if (typeof r.login !== 'string' || !LOGIN_RE.test(r.login)) {
      throw new GrantConfigError(`${p}.login must be a GitHub login`);
    }
    return { login: r.login, tier };
  });

  const seen = new Set<number>();
  const machines = list('machines').map((m, i): MachineRule => {
    const p = `machines[${i}]`;
    const r = asRecord(m, p);
    if (typeof r.appId !== 'number' || !Number.isInteger(r.appId) || r.appId <= 0) {
      throw new GrantConfigError(`${p}.appId must be a positive integer`);
    }
    if (typeof r.login !== 'string' || !BOT_RE.test(r.login)) {
      throw new GrantConfigError(`${p}.login must be a bot login ending in [bot]`);
    }
    if (seen.has(r.appId)) throw new GrantConfigError(`machines: appId ${r.appId} listed twice`);
    seen.add(r.appId);
    return { appId: r.appId, login: r.login, tier: parseTier(r.tier, p) };
  });

  return { grants, machines };
}
