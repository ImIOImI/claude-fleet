// fleet-host deployment config (/etc/fleet-host/config.yaml). Read at start and
// on every reload; grants are validated by the shared identity layer.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { ORG_RE, parseGrantConfig, type GrantConfig } from '../main/identity/grants.js';
import { parseStoreConfig, QUERY_USER, StoreConfigError, type PostgresStoreConfig } from '../main/store/storeConfig.js';
import { parseHostPort, parsePort, type HostPort } from './endpoint.js';
import { MESH_READY_URL } from './mesh.js';

export const DEFAULT_CONFIG_PATH = '/etc/fleet-host/config.yaml';
export const DEFAULT_PORT = 8080;
export const DEFAULT_EMBED_DIR = '/usr/local/lib/fleet-host/embed';
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
  /** Default and ceiling for every token's `permissions`; null = DEFAULT_PERMISSIONS in appToken.ts. */
  permissions: Record<string, 'read' | 'write'> | null;
}

export interface HostConfig {
  workspace: HostWorkspaceInfo;
  github: HostGithubConfig | null;
  /** The host store; null runs without one (process-local lease, no ingest). */
  db: PostgresStoreConfig | null;
  identity: { provider: 'github'; org: string | null };
  grants: GrantConfig;
  /** Proxies in front of the pod that append to X-Forwarded-For; 0 means key on the socket address. */
  trustedProxyHops: number;
  /** The only source of this workspace's automations; the holder validates each definition. */
  automations: HostAutomationEntry[];
  /** D79: fixed for the process lifetime (configReload.ts). */
  search: { embedder: boolean };
}

export const MAX_HOST_AUTOMATIONS = 100;

/** A definition the holder reconciles into the store (SPEC §7 *Host automations*). */
export interface HostAutomationEntry {
  definition: Record<string, unknown>;
  enabled: boolean;
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

function parseSearch(v: unknown): { embedder: boolean } {
  if (v === undefined) return { embedder: true };
  const s = record(v, 'search');
  onlyKeys(s, 'search', ['embedder']);
  if (s.embedder !== undefined && typeof s.embedder !== 'boolean') throw new HostConfigError('search.embedder must be true or false');
  return { embedder: s.embedder !== false };
}

function parseAutomations(v: unknown): HostAutomationEntry[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new HostConfigError('automations must be a list');
  if (v.length > MAX_HOST_AUTOMATIONS) throw new HostConfigError(`automations: at most ${MAX_HOST_AUTOMATIONS}`);
  const names = new Set<string>();
  return v.map((raw, i) => {
    const e = record(raw, `automations[${i}]`);
    onlyKeys(e, `automations[${i}]`, ['definition', 'enabled']);
    const definition = record(e.definition, `automations[${i}].definition`);
    if (typeof definition.name !== 'string' || !definition.name) throw new HostConfigError(`automations[${i}].definition.name must be a string`);
    if (names.has(definition.name)) throw new HostConfigError(`duplicate automation name ${definition.name}`);
    names.add(definition.name);
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') throw new HostConfigError(`automations[${i}].enabled must be true or false`);
    return { definition, enabled: e.enabled !== false };
  });
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

function parseDb(v: unknown): PostgresStoreConfig {
  const d = record(v, 'db');
  if ('kind' in d) throw new HostConfigError('db has unknown key kind (the host store is always Postgres)');
  // The config is a ConfigMap that sessions can read.
  const noStatic = 'db: a static password is not allowed (sessions can read the host config); use password "env" or "aws-rds-iam"';
  if ((d.password as { kind?: unknown } | undefined)?.kind === 'static') throw new HostConfigError(noStatic);
  if (typeof d.connectionString === 'string' && URL.canParse(d.connectionString)) {
    const u = new URL(d.connectionString);
    if (u.password || u.searchParams.has('password')) throw new HostConfigError(noStatic);
  }
  const { queryUser, ...store } = d;
  if (queryUser !== undefined && (typeof queryUser !== 'string' || !QUERY_USER.test(queryUser))) {
    throw new HostConfigError('db: queryUser must match [a-z_][a-z0-9_]* and be at most 59 characters');
  }
  try {
    const cfg = parseStoreConfig({ ...store, kind: 'postgres' }, { allowStaticSecrets: false }) as PostgresStoreConfig;
    return queryUser === undefined ? cfg : { ...cfg, queryUser };
  } catch (err) {
    if (err instanceof StoreConfigError) throw new HostConfigError(`db: ${err.message.replace(/^store: /, '')}`);
    throw err;
  }
}

export function parseHostConfig(raw: unknown): HostConfig {
  const o = record(raw, 'host config');
  onlyKeys(o, 'host config', ['workspace', 'identity', 'grants', 'machines', 'trustedProxyHops', 'github', 'db', 'automations', 'search']);
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
  const github = o.github === undefined ? null : parseGithub(o.github);
  const credApp = github?.app?.appId;
  // Otherwise a session could take a token from the credential server and present it as a Bearer on :8080.
  grants.machines.forEach((m, i) => {
    if (credApp !== undefined && String(m.appId) === credApp) {
      throw new HostConfigError(`machines[${i}].appId is this host's credential App; sessions hold its tokens`);
    }
  });
  return {
    workspace: parseWorkspace(o.workspace),
    github,
    db: o.db === undefined ? null : parseDb(o.db),
    identity: { provider: 'github', org: typeof id.org === 'string' ? id.org : null },
    grants,
    trustedProxyHops: hops,
    automations: parseAutomations(o.automations),
    search: parseSearch(o.search)
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
  /** The workspace pod's broker; replaces brokerSocket when set. */
  brokerAddr: HostPort | null;
  credSocket: string;
  /** Serve credentials on 0.0.0.0:<port> instead of credSocket. */
  credPort: number | null;
  /** Claude's transcripts in this container, ingested by the holder. */
  projectsDir: string;
  /** The fleet-state MCP socket the holder serves to sessions. */
  mcpSocket: string;
  /** Serve the MCP on 0.0.0.0:<port> instead of mcpSocket; set with mcpAddr. */
  mcpPort: number | null;
  /** What sessions' bridges dial when mcpPort is set. */
  mcpAddr: HostPort | null;
  /** Host pod: open the credential and MCP ports only behind a ready Istio sidecar. */
  requireMesh: boolean;
  /** The sidecar's readiness URL; tests override it. */
  meshReadyUrl: string;
  /** The sidecar and its weights (D65). */
  embedDir: string;
}

function envHostPort(env: NodeJS.ProcessEnv, name: string): HostPort | null {
  const text = env[name];
  if (!text) return null;
  const v = parseHostPort(text);
  if (!v) throw new HostConfigError(`${name} ${text} is not host:port`);
  return v;
}

function envPort(env: NodeJS.ProcessEnv, name: string): number | null {
  const text = env[name];
  if (!text) return null;
  const v = parsePort(text);
  if (v === null) throw new HostConfigError(`${name} ${text} is not a port`);
  return v;
}

export function readHostEnv(env: NodeJS.ProcessEnv): HostEnv {
  const portText = env.FLEET_HOST_PORT ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HostConfigError(`FLEET_HOST_PORT ${portText} is not a port`);
  const mcpPort = envPort(env, 'FLEET_HOST_MCP_TCP_PORT');
  const mcpAddr = envHostPort(env, 'FLEET_HOST_MCP_ADDR');
  if ((mcpPort === null) !== (mcpAddr === null)) throw new HostConfigError('FLEET_HOST_MCP_TCP_PORT and FLEET_HOST_MCP_ADDR are set together');
  const mcpSocket = env.FLEET_HOST_MCP_SOCKET || '/run/fleet/mcp.sock';
  if (!isAbsolute(mcpSocket)) throw new HostConfigError('FLEET_HOST_MCP_SOCKET must be an absolute path');
  // sun_path holds 108 bytes with the terminating NUL on Linux.
  if (Buffer.byteLength(mcpSocket) > 107) throw new HostConfigError('FLEET_HOST_MCP_SOCKET is longer than 107 bytes');
  const meshText = env.FLEET_HOST_REQUIRE_MESH ?? '';
  if (!['', '0', '1'].includes(meshText)) throw new HostConfigError('FLEET_HOST_REQUIRE_MESH must be 0 or 1');
  return {
    port,
    configPath: env.FLEET_HOST_CONFIG || DEFAULT_CONFIG_PATH,
    stateDir: env.FLEET_HOST_STATE || '/home/fleet/.claude/fleet-host',
    brokerSocket: env.CLAUDE_FLEET_BROKER_SOCKET || '/run/broker/broker.sock',
    brokerAddr: envHostPort(env, 'CLAUDE_FLEET_BROKER_ADDR'),
    credSocket: env.FLEET_HOST_CRED_SOCKET || '/run/fleet-host/cred.sock',
    credPort: envPort(env, 'FLEET_HOST_CRED_TCP_PORT'),
    projectsDir: env.FLEET_HOST_PROJECTS || join(homedir(), '.claude', 'projects'),
    mcpSocket,
    mcpPort,
    mcpAddr,
    requireMesh: meshText === '1',
    meshReadyUrl: env.FLEET_MESH_READY_URL || MESH_READY_URL,
    embedDir: env.FLEET_HOST_EMBED_DIR || DEFAULT_EMBED_DIR
  };
}
