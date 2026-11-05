// fleet-host deployment config (/etc/fleet-host/config.yaml). Read at start and
// on every reload; grants are validated by the shared identity layer.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { ORG_RE, parseGrantConfig, type GrantConfig } from '../main/identity/grants.js';

export const DEFAULT_CONFIG_PATH = '/etc/fleet-host/config.yaml';
export const DEFAULT_PORT = 8080;
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface HostWorkspaceInfo {
  id: string | null;
  name: string;
  description: string | null;
  color: { hue: number } | null;
}

/** The GitHub App whose installation tokens the credential helper mints. */
export interface GithubAppConfig {
  appId: string;
  installationId: string;
  /** PEM private key path (a Secret volume); read once at start. */
  keyFile: string;
}

/** Host config `github`. */
export interface HostGithubConfig {
  /** null = the credential helper is off. */
  app: GithubAppConfig | null;
  /** Repository names in the installation's account; null = any. */
  repositories: string[] | null;
  /** Default `permissions` for every token; null = the installation's. */
  permissions: Record<string, 'read' | 'write'> | null;
}

export interface HostConfig {
  workspace: HostWorkspaceInfo;
  github: HostGithubConfig | null;
  identity: { provider: 'github'; org: string | null };
  grants: GrantConfig;
  /** Proxies in front of the pod that append to X-Forwarded-For; 0 means key on the socket address. */
  trustedProxyHops: number;
}

export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostConfigError';
  }
}

function record(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HostConfigError(`${path} must be an object`);
  return v as Record<string, unknown>;
}

// Unknown keys are refused so a typo (e.g. `Id`) can't silently fall back to minting.
function onlyKeys(o: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HostConfigError(`${path} has unknown key ${k}`);
}

function parseWorkspace(v: unknown): HostWorkspaceInfo {
  const w = record(v, 'workspace');
  onlyKeys(w, 'workspace', ['id', 'name', 'description', 'color']);
  if (w.id !== undefined && (typeof w.id !== 'string' || !ULID_RE.test(w.id))) {
    throw new HostConfigError('workspace.id must be a ULID');
  }
  const name = typeof w.name === 'string' ? w.name.trim() : '';
  if (!name || name.length > 64) {
    throw new HostConfigError('workspace.name must be a non-empty string of at most 64 characters');
  }
  if (/\p{Cc}/u.test(name)) throw new HostConfigError('workspace.name must not contain control characters');
  if (w.description !== undefined && typeof w.description !== 'string') {
    throw new HostConfigError('workspace.description must be a string');
  }
  let color: { hue: number } | null = null;
  if (w.color !== undefined) {
    const hue = record(w.color, 'workspace.color').hue;
    if (typeof hue !== 'number' || !Number.isFinite(hue) || hue < 0 || hue >= 360) {
      throw new HostConfigError('workspace.color.hue must be a number in [0, 360)');
    }
    color = { hue };
  }
  return {
    id: typeof w.id === 'string' ? w.id : null,
    name,
    description: typeof w.description === 'string' ? w.description : null,
    color
  };
}

function positiveInt(v: unknown, path: string): string {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^[1-9]\d{0,15}$/.test(s)) throw new HostConfigError(`${path} must be a positive integer`);
  return s;
}

function parseGithub(v: unknown): HostGithubConfig {
  const g = record(v, 'github');
  onlyKeys(g, 'github', ['appId', 'installationId', 'keyFile', 'repositories', 'permissions']);
  let app: GithubAppConfig | null = null;
  const set = [g.appId, g.installationId, g.keyFile].filter((x) => x !== undefined).length;
  if (set !== 0 && set !== 3) throw new HostConfigError('github.appId, github.installationId and github.keyFile must be set together');
  if (set === 3) {
    if (typeof g.keyFile !== 'string' || !g.keyFile.startsWith('/')) throw new HostConfigError('github.keyFile must be an absolute path');
    app = { appId: positiveInt(g.appId, 'github.appId'), installationId: positiveInt(g.installationId, 'github.installationId'), keyFile: g.keyFile };
  }
  let repositories: string[] | null = null;
  if (g.repositories !== undefined) {
    const r = g.repositories;
    if (!Array.isArray(r) || r.length === 0 || r.length > 500 || r.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(x))) {
      throw new HostConfigError('github.repositories must list 1 to 500 repository names (no owner)');
    }
    repositories = [...new Set((r as string[]).map((x) => x.toLowerCase()))].sort();
  }
  let permissions: Record<string, 'read' | 'write'> | null = null;
  if (g.permissions !== undefined) {
    const p = record(g.permissions, 'github.permissions');
    permissions = {};
    for (const [k, val] of Object.entries(p)) {
      if (!/^[a-z_]{1,64}$/.test(k) || (val !== 'read' && val !== 'write')) throw new HostConfigError('github.permissions must map permission names to read or write');
      permissions[k] = val;
    }
  }
  return { app, repositories, permissions };
}

export function parseHostConfig(raw: unknown): HostConfig {
  const o = record(raw, 'host config');
  onlyKeys(o, 'host config', ['workspace', 'identity', 'grants', 'machines', 'trustedProxyHops', 'github']);
  const id = o.identity === undefined ? {} : record(o.identity, 'identity');
  onlyKeys(id, 'identity', ['provider', 'org']);
  if (id.provider !== undefined && id.provider !== 'github') {
    throw new HostConfigError('identity.provider must be github');
  }
  if (id.org !== undefined && (typeof id.org !== 'string' || !ORG_RE.test(id.org))) {
    throw new HostConfigError('identity.org must be a GitHub org login');
  }
  const hops = o.trustedProxyHops ?? 0;
  if (typeof hops !== 'number' || !Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new HostConfigError('trustedProxyHops must be an integer from 0 to 10');
  }
  let grants: GrantConfig;
  try {
    grants = parseGrantConfig(o);
  } catch (err) {
    throw new HostConfigError((err as Error).message);
  }
  return {
    workspace: parseWorkspace(o.workspace),
    github: o.github === undefined ? null : parseGithub(o.github),
    identity: { provider: 'github', org: typeof id.org === 'string' ? id.org : null },
    grants,
    trustedProxyHops: hops
  };
}

export async function loadHostConfig(path: string): Promise<HostConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new HostConfigError(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new HostConfigError(`${path} is not valid YAML: ${(err as Error).message.split('\n')[0]}`);
  }
  return parseHostConfig(raw);
}

export interface HostEnv {
  port: number;
  configPath: string;
  stateDir: string;
  brokerSocket: string;
}

export function readHostEnv(env: NodeJS.ProcessEnv): HostEnv {
  const portText = env.FLEET_HOST_PORT ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HostConfigError(`FLEET_HOST_PORT ${portText} is not a port`);
  return {
    port,
    configPath: env.FLEET_HOST_CONFIG || DEFAULT_CONFIG_PATH,
    stateDir: env.FLEET_HOST_STATE || '/home/fleet/.claude/fleet-host',
    brokerSocket: env.CLAUDE_FLEET_BROKER_SOCKET || '/run/broker/broker.sock'
  };
}
