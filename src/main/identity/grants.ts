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
  /** Display login for the bot; unique (case-insensitively) across rules. */
  login: string;
  /** GitHub org the App's installation must belong to. The tier applies only
   *  to installations whose every repository is owned by this org. */
  org: string;
  tier: Tier;
}

/** What resolveTier looks at: users by login/teams, machines by appId only. */
export type TierSubject =
  | { kind: 'user'; login: string; teams: readonly string[] }
  | { kind: 'machine'; appId: number };
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
 * `grants` by team or login; machines match only `machines`, and only by the
 * verified `appId` — never by login, so a configured display login can't make
 * one App inherit another's tier. A user-shaped rule never admits a machine,
 * and vice versa. (The provider already proved the installation is inside the
 * rule's org; see githubProvider.verifyMachine.)
 */
export function resolveTier(who: TierSubject | Identity, config: GrantConfig): Tier | null {
  let best: Tier | null = null;
  if (who.kind === 'machine') {
    for (const m of config.machines) if (m.appId === who.appId) best = higher(best, m.tier);
    return best;
  }
  const login = lc(who.login);
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
const ORG_RE = LOGIN_RE;

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

  // identity.org is only consulted (and validated) when a machine rule has no org.
  const identityOrg = (p: string): string => {
    const id = o.identity;
    const org = id && typeof id === 'object' && !Array.isArray(id) ? (id as Record<string, unknown>).org : undefined;
    if (org === undefined) throw new GrantConfigError(`${p}.org is required (or set identity.org)`);
    if (typeof org !== 'string' || !ORG_RE.test(org)) throw new GrantConfigError('identity.org must be a GitHub org login');
    return org;
  };
  const seen = new Set<number>();
  const seenLogins = new Set<string>();
  const machines = list('machines').map((m, i): MachineRule => {
    const p = `machines[${i}]`;
    const r = asRecord(m, p);
    if (typeof r.appId !== 'number' || !Number.isInteger(r.appId) || r.appId <= 0) {
      throw new GrantConfigError(`${p}.appId must be a positive integer`);
    }
    if (typeof r.login !== 'string' || !BOT_RE.test(r.login)) {
      throw new GrantConfigError(`${p}.login must be a bot login ending in [bot]`);
    }
    const tier = parseTier(r.tier, p);
    if (seen.has(r.appId)) throw new GrantConfigError(`machines: appId ${r.appId} listed twice`);
    seen.add(r.appId);
    if (seenLogins.has(lc(r.login))) {
      throw new GrantConfigError(`${p}.login ${r.login} listed twice (machine logins compare case-insensitively)`);
    }
    seenLogins.add(lc(r.login));
    let org: string;
    if ('org' in r) {
      if (typeof r.org !== 'string' || !ORG_RE.test(r.org)) throw new GrantConfigError(`${p}.org must be a GitHub org login`);
      org = r.org;
    } else {
      org = identityOrg(p);
    }
    return { appId: r.appId, login: r.login, org, tier };
  });

  return { grants, machines };
}
