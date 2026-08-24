// Docker-backed workspace operations.
//
// This module talks to dockerode and exposes operations the IPC layer
// translates into `workspace:*` channels. The exported types use
// workspace-level vocabulary because that's what the rest of the app
// sees; the internal `dockerode` calls still operate on the Docker
// notion of a container. When a non-Docker backend lands (the planned
// 'local' kind), it can implement the same surface.
//
// Identity is a ULID stored in the `com.claude-fleet.id` label. Container
// names are derived as `cf-<id>` so they're unique on the host even when
// the user renames the workspace's label. Lookup is always by label.

import { app } from 'electron';
import Docker from 'dockerode';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Writable, type Duplex } from 'node:stream';
import {
  assertValidWorkspaceId,
  sharedClaudeCredentialsPath,
  sharedRemoteSettingsPath,
  workspaceBrokerDir,
  workspaceBrokerSocket,
  workspaceClaudeDir,
  workspaceClaudeJsonPath,
  workspaceStateDir
} from './paths.js';
import type { AuthMode, Harness, Workspace, WorkspaceEnv, WorkspaceResources, WorkspaceKind } from './workspaces.js';
import { FACTORY_MIRROR, readWorkspaceManifest } from './workspaces.js';
import { fleetPrivateDir, fleetSharedDir } from './config.js';
import {
  mcpWorkspaceSocketDir,
  mcpWorkspaceBind,
  CONTAINER_MCP_DIR,
  CONTAINER_MCP_SOCKET,
  CONTAINER_MCP_TOKEN,
  MCP_TCP_PORT
} from './mcpSocket.js';
import { CONTAINER_BRIDGE_FILENAME } from './mcpContainerBridge.js';
import { BrokerClient, brokerPtyStream } from './broker.js';
import { randomUUID } from 'node:crypto';
import { recordBrokerSessionMapping, recordUsageEvent } from './db.js';
import { logError } from './errorLog.js';
import { learnMapping as learnMirrorMapping } from './mirrorPolicy.js';
import { resolveEnv } from './vault.js';
import { endpointEnv } from './endpoints.js';
import { harnessCreateArgs } from './harnessArgs.js';
import { injectAndSubmit } from './ptyInput.js';
import { perfSpan, perfSpanAsync, perfSetSpanContext } from './perf.js';

export const FLEET_LABEL = 'com.claude-fleet.managed';
export const ID_LABEL = 'com.claude-fleet.id';
export const NAME_LABEL = 'com.claude-fleet.name';
export const SUBDIR_LABEL = 'com.claude-fleet.subdir';
export const WORKSPACE_ROOT_LABEL = 'com.claude-fleet.workspace-root';
export const RUNNER_IMAGE = 'ghcr.io/imioimi/claude-fleet/runner:latest';
/** Variant runner image for qwen-code harness workspaces. Carries `qwen` CLI + `socat`. */
export const QWEN_RUNNER_IMAGE = 'ghcr.io/imioimi/claude-fleet/runner-qwen:latest';

const docker = new Docker();

const isWindows = process.platform === 'win32';

// Windows broker transport. A native Windows process cannot connect() to
// the broker's AF_UNIX socket, which only exists inside Docker Desktop's
// Linux VM (surfaced as a shared file → EACCES). On Windows the broker
// listens on loopback TCP inside the container (fixed port) and Docker
// publishes it to an ephemeral 127.0.0.1:<hostPort> on the host. Linux and
// macOS keep using the bind-mounted unix socket. See
// docs/design/windows-broker-tcp.md.
const BROKER_TCP_PORT = 7070;
const BROKER_TCP_KEY = `${BROKER_TCP_PORT}/tcp`;

/**
 * How the host reaches a workspace's broker: a unix-socket path string
 * (Linux/macOS) or a loopback TCP endpoint (Windows). Both forms are
 * accepted by `new BrokerClient()`.
 */
export type BrokerEndpoint = string | { host: string; port: number };

function containerNameFor(id: string): string {
  return `cf-${id}`;
}

/**
 * Derive the broker endpoint from a container's inspect info. On Windows we
 * read the host port Docker published for the container's 7070/tcp; on other
 * platforms the transport is the bind-mounted unix socket and the inspect
 * info is unused.
 */
function brokerEndpointFromInfo(
  workspaceId: string,
  info: Docker.ContainerInspectInfo
): BrokerEndpoint {
  if (!isWindows) return workspaceBrokerSocket(workspaceId);
  const binding = info.NetworkSettings?.Ports?.[BROKER_TCP_KEY]?.[0];
  if (!binding?.HostPort) {
    throw new Error(
      `broker TCP port ${BROKER_TCP_KEY} is not published for workspace ${workspaceId} yet ` +
        `(was the container created by a build new enough to publish it?)`
    );
  }
  return { host: '127.0.0.1', port: Number(binding.HostPort) };
}

/**
 * Resolve the broker endpoint for a workspace by id. On Windows this
 * re-inspects the container on every call, so a host-port reassignment
 * across a container restart is picked up without any persisted state.
 */
export async function brokerEndpoint(workspaceId: string): Promise<BrokerEndpoint> {
  if (!isWindows) return workspaceBrokerSocket(workspaceId);
  const info = await docker.getContainer(containerNameFor(workspaceId)).inspect();
  return brokerEndpointFromInfo(workspaceId, info);
}

/** Human-readable form of a broker endpoint, for error messages. */
function describeEndpoint(ep: BrokerEndpoint): string {
  return typeof ep === 'string' ? ep : `tcp ${ep.host}:${ep.port}`;
}

export interface CreateWorkspaceInput {
  id: string;
  name: string;
  /**
   * Optional subfolder inside the workspace's private /workspace dir to use as
   * the working directory. Defaults to /workspace itself. The private folder
   * and the shared folder both come from the app-level fleet root — callers
   * no longer supply a host path.
   */
  workspaceSubdir: string;
  /** Plain env vars only — secret values are looked up from the vault. */
  env: WorkspaceEnv;
  /** Image reference to launch. Defaults to the bundled runner image. */
  image?: string;
  resources?: WorkspaceResources;
  /**
   * Auth mode. When 'oauth', `createWorkspace` adds a bind-mount of the
   * shared credentials file (`paths.sharedClaudeCredentialsPath()`) over
   * `/home/fleet/.claude/.credentials.json` so the first browser login
   * propagates to every other OAuth workspace. 'apikey' workspaces don't
   * get the shared bind — their credentials come via the env-var path.
   * 'endpoint' workspaces also don't get the shared bind; their model
   * config comes from the endpoint registry at container-start time (#250).
   */
  authMode: AuthMode;
  /** authMode 'endpoint' only: id into the app-level model-endpoint registry
   *  (<userData>/endpoints.json). A REFERENCE — resolved live at container
   *  create / local spawn, so registry edits apply on next start (#250). */
  endpointId?: string;
  /** authMode 'endpoint' only: which harness drives this workspace. Absent = 'claude-code'. */
  harness?: Harness;
  /**
   * Workspace kind. The Docker backend only ever sees `'container'`; the local
   * backend (#16) uses `'local'`. Optional + defaulted so existing callers and
   * the Docker path are unaffected.
   */
  kind?: WorkspaceKind;
  /**
   * Local backend only (#16): the user-chosen host directory `claude` runs in.
   * Ignored by the Docker backend, which derives the private folder from the
   * fleet root.
   */
  workspaceRoot?: string;
}

export interface ImageInspectResult {
  ref: string;
  digest?: string;
  labels: Record<string, string>;
}

/**
 * Pull (if needed) and inspect an image, returning its digest + labels.
 * Used by the image library to record metadata about images workspaces
 * are actually created against.
 */
export async function inspectImage(ref: string): Promise<ImageInspectResult> {
  const info = await docker.getImage(ref).inspect();
  const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
  const repoDigest = info.RepoDigests?.[0];
  const digest = repoDigest?.split('@')[1];
  return { ref, digest, labels };
}

export interface PullProgress {
  message: string;
}

/**
 * Pull the runner image, with offline fallback. Always asks the registry
 * — `:latest` tags get silent improvements (broker landing, claude
 * version bumps).
 *
 * When the registry is unreachable but we have a local copy, surface a
 * one-line warning and proceed with the local image. Anything else
 * (auth failures, 5xx) bubbles. If no local copy exists either, the
 * caller can't proceed and the error propagates.
 */
export async function ensureImage(
  onProgress: (p: PullProgress) => void,
  imageRef?: string
): Promise<void> {
  // Pull whichever image the workspace will use — defaults to the base runner,
  // but the create/resume flow passes the user-selected ref so a brand-new
  // image (e.g. the devops runner) is pulled here, with progress, instead of
  // 404'ing later at `docker create`. Blank/whitespace falls back to default.
  const ref = imageRef?.trim() || RUNNER_IMAGE;
  const localExists = await docker
    .getImage(ref)
    .inspect()
    .then(() => true)
    .catch((err: unknown) => {
      if ((err as { statusCode?: number }).statusCode === 404) return false;
      throw err;
    });

  onProgress({
    message: localExists ? `Checking ${ref} for updates…` : `Pulling ${ref}…`
  });

  try {
    const stream = (await docker.pull(ref)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (event: Record<string, unknown>) => {
          const status = typeof event.status === 'string' ? event.status : '';
          const id = typeof event.id === 'string' ? ` ${event.id}` : '';
          if (status) onProgress({ message: `${status}${id}` });
        }
      );
    });
  } catch (err) {
    if (localExists) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress({
        message: `Registry check failed (${msg}); using cached ${ref}.`
      });
      return;
    }
    throw err;
  }
}

export function ping(): Promise<boolean> {
  // Two spans discriminate the open stall hypothesis (perf dogfood
  // 2026-08-14): the SYNC dispatch span measures only up to dockerode's
  // first await — the sole portion that can block the main loop (e.g. a
  // Windows named-pipe connect stalling inside libuv). The async span
  // measures the full daemon round trip. dispatch big → ping blocks the
  // loop; dispatch ~0 while the async span stretches → ping is a stall
  // victim. Caveat: a connect deferred to a later tick escapes the
  // dispatch span, so a small dispatch doesn't fully acquit npipe.
  return perfSpanAsync('claude_fleet.docker.ping', () =>
    perfSpan('claude_fleet.docker.ping_dispatch', () => pingInner())
  );
}

async function pingInner(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a workspace's container by its ULID. Returns the dockerode
 * container info object, or undefined if not present.
 */
async function findContainerById(
  id: string
): Promise<Docker.ContainerInfo | undefined> {
  const raw = await docker.listContainers({
    all: true,
    filters: { label: [`${ID_LABEL}=${id}`] }
  });
  return raw[0];
}

/**
 * Live workspaces — those whose Docker container currently exists
 * (running or stopped). Does not include "deleted" workspaces (manifest
 * but no container); the IPC layer joins those in via workspace
 * manifests.
 *
 * Note: only minimal fields are populated here. The IPC layer overlays
 * the on-disk manifest (description, labels, color, env, etc.) on top.
 */
export async function listLiveWorkspaces(): Promise<Workspace[]> {
  const raw = await docker.listContainers({
    all: true,
    filters: { label: [FLEET_LABEL] }
  });
  return raw
    .map((c): Workspace | null => {
      const id = c.Labels[ID_LABEL];
      const name = c.Labels[NAME_LABEL] ?? c.Names[0]?.replace(/^\//, '') ?? '';
      // Containers without the id label are pre-migration; the migration
      // step removes them before this list is ever consulted.
      if (!id) return null;
      let state: Workspace['state'];
      if (c.State === 'running') state = 'running';
      else if (c.State === 'paused') state = 'paused';
      else state = 'stopped';
      return {
        id,
        name,
        labels: [],
        workspaceRoot: c.Labels[WORKSPACE_ROOT_LABEL] ?? '',
        workspaceSubdir: c.Labels[SUBDIR_LABEL] ?? '',
        kind: 'container',
        image: c.Image,
        authMode: 'oauth',
        env: { plain: {}, secretKeys: [] },
        // Placeholder; listAllWorkspaces overlays the manifest's mirror value.
        mirror: FACTORY_MIRROR,
        createdAt: c.Created * 1000,
        lastUsedAt: c.Created * 1000,
        state,
        containerId: c.Id,
        status: c.Status
      };
    })
    .filter((w): w is Workspace => w !== null);
}

/**
 * Ensure `<userData>/claude-shared/.credentials.json` exists as a real
 * file on disk so Docker can file-bind it into an OAuth-mode container.
 * Docker refuses to file-bind a missing host path; if we let it auto-
 * create the missing inode it would become a directory, which would
 * make `claude`'s `read .credentials.json` fail. Touching an empty
 * file up front matches what `claude` would write on first OAuth
 * completion — the file is overwritten with real JSON the first time
 * a workspace logs in.
 */
export async function ensureSharedCredentialsFile(): Promise<string> {
  const filePath = sharedClaudeCredentialsPath();
  await mkdir(dirname(filePath), { recursive: true });
  const existing = await stat(filePath).catch(() => null);
  if (!existing) {
    await writeFile(filePath, '', 'utf8');
  }
  return filePath;
}

/**
 * Ensure the shared `remote-settings.json` exists so Docker can file-bind it
 * (Docker refuses to bind a missing host path). It starts empty: the first
 * OAuth workspace fetches the org's managed settings, the user approves the
 * gate once, and claude writes the fetched settings into this file in place —
 * after which every subsequent OAuth workspace finds them already on disk and
 * skips the gate. See `sharedRemoteSettingsPath` for the security rationale.
 */
export async function ensureSharedRemoteSettingsFile(): Promise<string> {
  const filePath = sharedRemoteSettingsPath();
  await mkdir(dirname(filePath), { recursive: true });
  const existing = await stat(filePath).catch(() => null);
  if (!existing) {
    await writeFile(filePath, '', 'utf8');
  }
  return filePath;
}

/**
 * The app-managed `mcpServers` entry seeded into every workspace's
 * `~/.claude.json` (#12). A user-scope entry is trusted (no approval gate,
 * unlike a project `.mcp.json`). It bridges claude's stdio MCP client to the
 * host socket inside the bound `/fleet/mcp` dir.
 *
 * It is a *reconnecting* loop, not a bare `socat`: the host owns the socket and
 * recreates it (new inode) on every app restart, and a paused container
 * survives that restart — so a one-shot socat would die with the old
 * connection and claude would mark the MCP server failed. The `forever` keeps
 * socat retrying the connect while the server is down (e.g. mid-restart); the
 * `while` restarts socat after an established connection drops. The MCP server
 * is stateless per-connection, so a reconnected socket serves tool calls
 * without re-initializing. (#18)
 */
function managedMcpServerEntry(): {
  type: string;
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  // The bridge is a node script the host writes into the per-workspace MCP dir
  // (the one dir bind-mounted into exactly this container, #117), refreshed on
  // every app start — no runner-image rebuild to update it. It reconnects
  // forever and RE-SENDS unanswered requests after a reconnect: the previous
  // `{ printf token; exec cat; } | socat` pipeline silently ate the first
  // request written after a host-app restart (cat died on the SIGPIPE carrying
  // it), which presented as the "first MCP call of the session hangs forever".
  // Windows hosts listen on loopback TCP (a unix socket can't live on a
  // Windows path) with the first-line token as identity; unix hosts use the
  // per-workspace socket, where the path itself is the identity.
  const env: Record<string, string> = isWindows
    ? {
        CLAUDE_FLEET_MCP_TCP: `host.docker.internal:${MCP_TCP_PORT}`,
        CLAUDE_FLEET_MCP_TOKEN_FILE: CONTAINER_MCP_TOKEN
      }
    : { CLAUDE_FLEET_MCP_UNIX: CONTAINER_MCP_SOCKET };
  return {
    type: 'stdio',
    command: 'node',
    args: [`${CONTAINER_MCP_DIR}/${CONTAINER_BRIDGE_FILENAME}`],
    env
  };
}

/**
 * Ensure the per-workspace `~/.claude.json` seed exists, bind-mounted at
 * `/home/fleet/.claude.json`. claude-code stores its onboarding/account
 * state there (NOT in `~/.claude`), so without persisting it every new
 * container re-runs the theme/trust/setup wizard even when the shared
 * credential is already valid. Seeding `hasCompletedOnboarding` plus trust
 * for the container's working directory skips that wizard. The onboarding/
 * account state is only seeded when the file is absent — once claude runs it
 * owns the file, so restarts and recreations keep the real accumulated state.
 *
 * The exception is the app-managed `mcpServers['claude-fleet-state']` entry:
 * that's our infrastructure, not user state, so we **reconcile it on every
 * call** (preserving every other key). This is what carries the reconnecting-
 * bridge fix (#18) onto workspaces created before it landed — when their
 * container is recreated, the stale one-shot `socat` command is rewritten —
 * without clobbering claude's accumulated state.
 *
 * `workingDir` is the in-container cwd (matches the container's WorkingDir);
 * claude keys trust acceptance by directory, so the seed must name it.
 */
export async function ensureWorkspaceClaudeJson(
  id: string,
  workingDir: string
): Promise<string> {
  const filePath = workspaceClaudeJsonPath(id);
  await mkdir(dirname(filePath), { recursive: true });
  const desired = managedMcpServerEntry();
  const existing = await readFile(filePath, 'utf8').catch(() => null);
  if (existing === null) {
    const seed = {
      hasCompletedOnboarding: true,
      projects: { [workingDir]: { hasTrustDialogAccepted: true } },
      mcpServers: { 'claude-fleet-state': desired }
    };
    await writeFile(filePath, JSON.stringify(seed, null, 2), 'utf8');
    return filePath;
  }
  // File exists (claude owns it). Reconcile ONLY our managed mcpServers entry,
  // leaving everything else byte-for-byte. Tolerate a malformed file — claude
  // will rewrite it; we never want to fault container creation on a parse error.
  try {
    const parsed = JSON.parse(existing) as {
      mcpServers?: Record<string, unknown>;
    };
    const current = parsed.mcpServers?.['claude-fleet-state'];
    if (JSON.stringify(current) !== JSON.stringify(desired)) {
      parsed.mcpServers = { ...(parsed.mcpServers ?? {}), 'claude-fleet-state': desired };
      await writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8');
    }
  } catch {
    /* malformed claude.json — leave it untouched */
  }
  return filePath;
}

/**
 * Pure helper: the MCP server object to seed into a qwen-code workspace's
 * `~/.qwen/settings.json`. Unlike claude-code (which uses a reconnecting node
 * bridge because its PTY persists across app restarts), qwen-code is short-lived
 * per invocation — a direct `socat` stdio bridge is sufficient. Identity is
 * ambient from the bind-mounted per-workspace socket path (#117).
 */
export function qwenSettingsContent(): object {
  return {
    mcpServers: {
      'claude-fleet-state': {
        command: 'socat',
        args: ['-', `UNIX-CONNECT:${CONTAINER_MCP_SOCKET}`]
      }
    }
  };
}

/**
 * Ensure the per-workspace `~/.qwen/settings.json` seed exists, bind-mounted
 * at `/home/fleet/.qwen/settings.json`. Mirrors the `ensureWorkspaceClaudeJson`
 * pattern: seeds on first create, reconciles the managed `mcpServers` entry on
 * every subsequent call, leaves everything else byte-for-byte.
 *
 * Only called for `harness === 'qwen-code'` workspaces; the bind mount is
 * wired in `createWorkspaceInner`.
 */
export async function seedQwenSettings(id: string): Promise<string> {
  const filePath = join(workspaceStateDir(id), 'qwen-settings.json');
  await mkdir(dirname(filePath), { recursive: true });
  const desired = qwenSettingsContent();
  const existing = await readFile(filePath, 'utf8').catch(() => null);
  if (existing === null) {
    await writeFile(filePath, JSON.stringify(desired, null, 2), 'utf8');
    return filePath;
  }
  // File exists. Reconcile ONLY our managed mcpServers entry; leave every other
  // key byte-for-byte. Tolerate a malformed file — qwen will rewrite it.
  try {
    const parsed = JSON.parse(existing) as {
      mcpServers?: Record<string, unknown>;
    };
    const current = parsed.mcpServers?.['claude-fleet-state'];
    if (JSON.stringify(current) !== JSON.stringify((desired as { mcpServers: Record<string, unknown> }).mcpServers['claude-fleet-state'])) {
      parsed.mcpServers = {
        ...(parsed.mcpServers ?? {}),
        'claude-fleet-state': (desired as { mcpServers: Record<string, unknown> }).mcpServers['claude-fleet-state']
      };
      await writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8');
    }
  } catch {
    /* malformed qwen settings — leave it untouched */
  }
  return filePath;
}

export function createWorkspace(spec: CreateWorkspaceInput): Promise<Workspace> {
  return perfSpanAsync('claude_fleet.docker.create', () => createWorkspaceInner(spec), { workspace_id: spec.id });
}

async function createWorkspaceInner(spec: CreateWorkspaceInput): Promise<Workspace> {
  assertValidWorkspaceId(spec.id);

  // Private folder (this container only) + shared folder (all containers).
  // Both live under the app-level fleet root and are created on demand.
  const privateDir = await fleetPrivateDir(spec.id);
  const sharedDir = await fleetSharedDir();
  await mkdir(privateDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const claudeDir = workspaceClaudeDir(spec.id);
  await mkdir(claudeDir, { recursive: true });
  const brokerDir = workspaceBrokerDir(spec.id);
  await mkdir(brokerDir, { recursive: true });

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  const image = spec.image?.trim() || (spec.harness === 'qwen-code' ? QWEN_RUNNER_IMAGE : RUNNER_IMAGE);
  // Resolve secrets at create-time; the merged env goes straight to the
  // container's `Env` array. Missing secret keys resolve to empty string
  // so the container still starts (claude itself surfaces the failure
  // later via its own error path).
  // authMode 'endpoint': compile the registry entry to claude-code's env
  // contract (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL/…, #250). Spread FIRST so
  // explicit workspace env still overrides it. Resolved live — registry
  // edits/key rotation apply on next create.
  const backendVars = spec.authMode === 'endpoint' ? await endpointEnv(spec.endpointId, spec.harness) : {};
  const resolvedEnv = { ...backendVars, ...(await resolveEnv(spec.id, spec.env.plain, spec.env.secretKeys)) };
  if (spec.harness === 'qwen-code') resolvedEnv.CLAUDE_FLEET_BROKER_CLAUDE = 'qwen';
  const envArr = ['HOME=/home/fleet', ...Object.entries(resolvedEnv).map(([k, v]) => `${k}=${v}`)];
  // Windows: tell the broker to listen on loopback TCP instead of a unix
  // socket. The host connects via the published 127.0.0.1:<hostPort>.
  if (isWindows) envArr.push(`CLAUDE_FLEET_BROKER_TCP_PORT=${BROKER_TCP_PORT}`);

  // In-container cwd. Reused for the WorkingDir below and for seeding the
  // trust acceptance in ~/.claude.json (claude keys trust by directory).
  const workingDir = `/workspace/${spec.workspaceSubdir}`.replace(/\/$/, '') || '/workspace';

  const binds: string[] = [
    // Private per-container working dir. Only this container gets it mounted,
    // so other containers can't read files dropped here on the host.
    `${privateDir}:/workspace:rw`,
    // Shared scratch space, mounted into every container — write here for
    // other containers to read.
    `${sharedDir}:/shared:rw`,
    `${claudeDir}:/home/fleet/.claude:rw`,
    // The in-container broker creates its socket here. Bind-mounting
    // the *directory* (not the file) lets the broker create the
    // socket node on its own — Docker can't bind-mount a file that
    // doesn't exist yet on the host side.
    `${brokerDir}:/run/broker:rw`
  ];

  // Read-only state-DB MCP server (#12): bind this workspace's **own per-id**
  // socket DIR (`<userData>/mcp/<id>/`, not the parent and not the socket file)
  // so in-container claude can query sessions/events/cost via the `mcpServers`
  // entry seeded in ~/.claude.json below (a reconnecting socat stdio bridge).
  // Binding the per-id LEAF dir is load-bearing (#117): the container's mount
  // namespace then contains only its own `mcp.sock`, never a sibling's, and the
  // host derives an unspoofable caller id from which listener accepted the
  // connection. Binding the parent `<userData>/mcp/` would break both. Binding
  // the *directory* (not the socket file) — like the broker socket above —
  // means a socket the server recreates with a new inode on app restart is
  // still visible at the same container path, so a paused container's MCP
  // survives an app restart (#18). `:rw` because connecting to a Unix socket
  // needs write access — the read-only guarantee is the DB connection, not the
  // mount. The listener is created by `ensureWorkspaceSocket` (workspace:create
  // / startup); we mkdir here too so the bind has a host dir even if the server
  // hasn't started yet (the bridge reconnects until the socket appears).
  const mcpDir = mcpWorkspaceSocketDir(app.getPath('userData'), spec.id);
  await mkdir(mcpDir, { recursive: true });
  binds.push(mcpWorkspaceBind(app.getPath('userData'), spec.id));

  // Persist + pre-complete onboarding. ~/.claude.json lives in $HOME,
  // outside the .claude bind, so without this every new container re-runs
  // the onboarding wizard. Applies to all auth modes — the trust/setup
  // wizard isn't OAuth-specific.
  const claudeJson = await ensureWorkspaceClaudeJson(spec.id, workingDir);
  binds.push(`${claudeJson}:/home/fleet/.claude.json:rw`);

  // OAuth mode: file-bind the shared credentials file on top of the
  // per-workspace .claude dir. Docker layers this file bind over the
  // dir bind, so reads/writes of `/home/fleet/.claude/.credentials.json`
  // hit the shared host file. First OAuth workspace populates it on
  // login; every subsequent OAuth workspace sees an already-valid
  // credentials file and skips the browser dance. Token refresh in any
  // workspace updates the shared file in place.
  //
  // The same pattern shares `remote-settings.json` (the org's managed
  // settings claude fetches): approving the "Managed settings require
  // approval" gate once writes the fetched settings into the shared file,
  // so every subsequent OAuth workspace already has them on disk and skips
  // the gate. claude re-fetches each start and still re-prompts if the org
  // changes the settings, so this shares the approval without suppressing
  // genuine changes.
  // 'apikey' and 'endpoint' modes get no Anthropic credential file — env only (#250).
  if (spec.authMode === 'oauth') {
    const sharedCreds = await ensureSharedCredentialsFile();
    binds.push(`${sharedCreds}:/home/fleet/.claude/.credentials.json:rw`);
    const sharedRemoteSettings = await ensureSharedRemoteSettingsFile();
    binds.push(`${sharedRemoteSettings}:/home/fleet/.claude/remote-settings.json:rw`);
  }

  // qwen-code workspaces: seed ~/.qwen/settings.json with the fleet-state MCP
  // entry (socat direct bridge — no reconnect loop needed; qwen is short-lived
  // per invocation). Bind-mounted as a file, like ~/.claude.json above.
  if (spec.harness === 'qwen-code') {
    const qwenSettings = await seedQwenSettings(spec.id);
    binds.push(`${qwenSettings}:/home/fleet/.qwen/settings.json:rw`);
  }

  const hostCfg: Docker.HostConfig = {
    Binds: binds,
    AutoRemove: false,
    // Survive a host reboot / docker daemon restart: bring the container
    // back automatically so its broker re-launches and the user can resume
    // sessions from disk (transcripts + broker_sessions mapping persist).
    // `unless-stopped` (not `always`) respects an explicit `workspace:stop`
    // — a deliberately stopped workspace stays down across reboots; only
    // ones that were running when the daemon went away come back.
    RestartPolicy: { Name: 'unless-stopped' }
  };
  if (spec.resources?.cpus) hostCfg.NanoCpus = Math.round(spec.resources.cpus * 1e9);
  if (spec.resources?.memoryMb) hostCfg.Memory = spec.resources.memoryMb * 1024 * 1024;
  // Windows: publish the broker's TCP port to the host loopback only — the
  // broker has no auth, so it must never be reachable off-host. Empty
  // HostPort lets Docker pick an ephemeral host port, avoiding collisions
  // across workspaces.
  if (isWindows) {
    hostCfg.PortBindings = { [BROKER_TCP_KEY]: [{ HostIp: '127.0.0.1', HostPort: '' }] };
  }

  const created = await docker.createContainer({
    name: containerNameFor(spec.id),
    Image: image,
    User: `${uid}:${gid}`,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    WorkingDir: workingDir,
    Env: envArr,
    ExposedPorts: isWindows ? { [BROKER_TCP_KEY]: {} } : undefined,
    Labels: {
      [FLEET_LABEL]: 'true',
      [ID_LABEL]: spec.id,
      [NAME_LABEL]: spec.name,
      [SUBDIR_LABEL]: spec.workspaceSubdir,
      [WORKSPACE_ROOT_LABEL]: privateDir
    },
    HostConfig: hostCfg
  });

  await created.start();
  const info = await created.inspect();
  const createdAt = Date.parse(info.Created);
  return {
    id: spec.id,
    name: spec.name,
    labels: [],
    workspaceRoot: privateDir,
    workspaceSubdir: spec.workspaceSubdir,
    kind: 'container',
    image,
    authMode: spec.authMode,
    env: spec.env,
    resources: spec.resources,
    // Placeholder; the ipc create handler overlays the full spec's mirror.
    mirror: FACTORY_MIRROR,
    createdAt,
    lastUsedAt: createdAt,
    state: 'running',
    containerId: info.Id,
    status: info.State.Status
  };
}

/**
 * Start the (live) workspace by id. Returns the container id if it exists
 * (whether it was already running, paused, or stopped), or null if no
 * container has that ULID label and the caller should recreate from the
 * spec. Paused containers are unpaused; stopped containers are started.
 */
export function startWorkspace(id: string): Promise<string | null> {
  return perfSpanAsync('claude_fleet.docker.start', () => startWorkspaceInner(id), { workspace_id: id });
}

async function startWorkspaceInner(id: string): Promise<string | null> {
  assertValidWorkspaceId(id);
  const found = await findContainerById(id);
  if (!found) return null;

  const c = docker.getContainer(found.Id);
  if (found.State === 'paused') {
    try {
      await c.unpause();
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 409) throw err;
    }
  } else if (found.State !== 'running') {
    try {
      await c.start();
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }
  return found.Id;
}

/**
 * Pause a running container. All processes are suspended (cgroups freezer);
 * the container state remains "live" and recoverable via startWorkspace.
 */
export function pauseWorkspace(containerId: string): Promise<void> {
  return perfSpanAsync('claude_fleet.docker.pause', () => pauseWorkspaceInner(containerId));
}

async function pauseWorkspaceInner(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  try {
    await c.pause();
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 409 && status !== 404) throw err;
  }
}

export function stopWorkspace(containerId: string): Promise<void> {
  return perfSpanAsync('claude_fleet.docker.stop', () => stopWorkspaceInner(containerId));
}

async function stopWorkspaceInner(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  try {
    await c.stop({ t: 5 });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 304 && status !== 404) throw err;
  }
}

export interface RemoveWorkspaceOpts {
  /** When true, also wipe the host-side state dir (manifest + .claude + broker). */
  deleteState?: boolean;
  /**
   * Workspace ULID. Required to delete the state dir of a *saved* workspace
   * (one with no live container) — without a container we can't recover the
   * id from a label. Live-path callers may omit it; the id is then read from
   * the container's ID_LABEL.
   */
  id?: string;
}

export async function removeWorkspace(
  containerId: string,
  opts: RemoveWorkspaceOpts = {}
): Promise<void> {
  // Prefer the caller-supplied ULID (the only way to identify a saved
  // workspace, whose container no longer exists). Fall back to the
  // container's label for live-path callers that pass only a containerId.
  let id = opts.id;
  if (opts.deleteState && !id && containerId) {
    try {
      const info = await docker.getContainer(containerId).inspect();
      id = info.Config.Labels?.[ID_LABEL];
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  // Remove the container. Prefer the explicit ref; otherwise derive the name
  // from the id (a saved workspace has none, so this 404s harmlessly).
  const ref = containerId || (id ? containerNameFor(id) : undefined);
  if (ref) {
    try {
      await docker.getContainer(ref).remove({ force: true });
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  if (opts.deleteState && id) {
    await rm(workspaceStateDir(id), { recursive: true, force: true });
  }
}

export interface PtyHandle {
  stream: Duplex;
  /** Resolves `true` when the resize reached the PTY. Backends that cannot
   *  tell (the broker speaks a fire-and-forget RPC) resolve `void`, which the
   *  IPC layer treats as "assume delivered" — only an explicit `false` is a
   *  reported drop. See ipc.ts's `pty:resize` and #268. */
  resize: (cols: number, rows: number) => Promise<void | boolean>;
  /** Size the PTY actually holds, when the backend can report it. Used by the
   *  width-agreement sweep to catch a divergence that no failed call
   *  announced — e.g. a resize lost in the ConPTY → wsl.exe → in-distro pty
   *  relay. Undefined on backends with no way to read it back. */
  getSize?: () => { cols: number; rows: number } | undefined;
  /** Unwire this host connection but leave the broker session (claude) alive. */
  detach: () => void;
  /**
   * Terminate the broker session entirely — kills the PTY (claude) and drops
   * the session from the broker's map. Used by the loadout reload, which then
   * re-attaches the same session id with `--resume` so the same tab picks the
   * conversation back up with the freshly-installed config. (#16)
   */
  close: () => Promise<void>;
}

const HOST_CHANNEL = 1;
// Reattach race backoff: how many times / how often to retry an ATTACH that
// fails "already attached" while the broker reaps a dead prior connection.
// ~3s total covers the unpause-reap window with margin (see attachPty).
const REATTACH_RETRIES = 12;
const REATTACH_RETRY_MS = 250;

/**
 * Resolve only once the workspace's broker answers a `LIST` (#119). Committee
 * unpause uses this so a later `post` (#120) never lands in a *frozen* broker:
 * `docker unpause` (startWorkspace) has thawed the container by the time we
 * poll, but the broker (PID 1) may take a moment to resume servicing RPCs.
 * We retry on the same backoff the reattach race uses.
 *
 * A frozen broker still *accepts* a socket connect (the kernel parks it in the
 * listen backlog) but never answers — so `ready()` succeeding is not enough;
 * the authoritative signal is a `LIST` reply. Each attempt is bounded by a
 * short timeout so a genuinely-stuck broker can't burn the full 30s RPC budget
 * per try (the late reply is swallowed to avoid an unhandled rejection).
 */
export async function waitForBrokerReady(workspaceId: string): Promise<void> {
  const endpoint = await brokerEndpoint(workspaceId);
  const PER_ATTEMPT_MS = 1500;
  let lastErr: unknown;
  for (let i = 0; i < REATTACH_RETRIES; i++) {
    const client = new BrokerClient(endpoint);
    try {
      await client.ready();
      const listed = client.listSessions();
      listed.catch(() => {}); // swallow a late rejection if we time out first
      await Promise.race([
        listed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('broker LIST timed out')), PER_ATTEMPT_MS))
      ]);
      return; // broker is servicing RPCs again
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, REATTACH_RETRY_MS));
    } finally {
      client.close();
    }
  }
  throw new Error(
    `broker for ${workspaceId} did not become ready after unpause: ${(lastErr as Error)?.message ?? String(lastErr)}`
  );
}

/**
 * Inject `text` into the workspace's single live session as if typed (committee
 * `post`, #120). A **transient** attach: LIST → guard → ATTACH → INPUT → DETACH,
 * so we hold the broker's one-writer slot only for the keystroke. We deliberately
 * do NOT read the session's output stream — the committee reads replies from the
 * state DB via `collect`, so output capture never depends on this attach. INPUT
 * is dropped on an unattached channel, hence the ATTACH; frame order on the one
 * socket guarantees the broker processes INPUT before the following DETACH.
 *
 * If a human is viewing the expert (renderer holds the session's writer), the
 * ATTACH is rejected `already attached`; we retry on the reattach backoff, then
 * fail — a watched expert can't be posted to in v1 (documented limitation).
 */
export async function committeePost(
  workspaceId: string,
  text: string
): Promise<{ brokerSessionId: string }> {
  const client = new BrokerClient(await brokerEndpoint(workspaceId));
  try {
    await client.ready();
    const alive = (await client.listSessions()).filter((s) => s.alive);
    if (alive.length === 0) {
      throw new Error(`expert ${workspaceId} has no live session yet — open/attach it before posting`);
    }
    if (alive.length > 1) {
      throw new Error(
        `expert ${workspaceId} has ${alive.length} live sessions; committee post requires a single-tab expert (v1)`
      );
    }
    const brokerSessionId = alive[0].id;
    let resp = await client.attachSession(brokerSessionId, HOST_CHANNEL);
    for (let i = 0; i < REATTACH_RETRIES && !resp.ok && /already attached/i.test(resp.error ?? ''); i++) {
      await new Promise((r) => setTimeout(r, REATTACH_RETRY_MS));
      resp = await client.attachSession(brokerSessionId, HOST_CHANNEL);
    }
    if (!resp.ok) {
      throw new Error(`committee post could not attach expert ${workspaceId}: ${resp.error}`);
    }
    await injectAndSubmit((chunk) => client.sendInput(HOST_CHANNEL, Buffer.from(chunk, 'utf8')), text);
    await client.detachChannel(HOST_CHANNEL).catch(() => undefined);
    return { brokerSessionId };
  } finally {
    client.close();
  }
}

/**
 * Open a terminal session against the in-container broker.
 *
 * Broker socket lives in the host state dir keyed by workspace id. We
 * resolve the id from the container's `com.claude-fleet.id` label.
 */
export function attachPty(
  containerId: string,
  sessionId: string,
  cols: number,
  rows: number,
  resumeOf?: string
): Promise<PtyHandle> {
  return perfSpanAsync('claude_fleet.docker.attach_pty', () => attachPtyInner(containerId, sessionId, cols, rows, resumeOf), { session_id: sessionId });
}

async function attachPtyInner(
  containerId: string,
  sessionId: string,
  cols: number,
  rows: number,
  resumeOf?: string
): Promise<PtyHandle> {
  const c = docker.getContainer(containerId);
  const info = await c.inspect();
  const workspaceId = info.Config.Labels?.[ID_LABEL];
  if (!workspaceId) {
    throw new Error(`container ${containerId} is missing ${ID_LABEL} label`);
  }
  perfSetSpanContext({ workspaceId });

  const manifest = await readWorkspaceManifest(workspaceId);
  const harness = manifest?.harness;

  const endpoint = brokerEndpointFromInfo(workspaceId, info);
  const client = new BrokerClient(endpoint);
  try {
    await client.ready();
  } catch (err) {
    client.close();
    throw new Error(
      `broker not reachable at ${describeEndpoint(endpoint)}: ${(err as Error).message}. ` +
        `Is the runner image new enough to include the broker?`
    );
  }

  // CRITICAL: wire the stream BEFORE sending ATTACH so HISTORY frames
  // aren't dropped. See the long comment block on this function in
  // earlier iterations — kept terse here since the constraint hasn't
  // changed but the rest of the function got smaller.
  const stream = brokerPtyStream(client, HOST_CHANNEL);

  let attachResp = await client.attachSession(sessionId, HOST_CHANNEL);

  // Reattach race (#18): when the previous app instance vanished (pause → quit
  // → reopen → resume), the broker may still hold the dead connection's
  // attachment — its read loop only reaps it on unpause, just as we reconnect.
  // The broker rejects the legitimate reattach as "already attached" (#89's
  // concurrent-attach guard, correct for a genuinely-live second client). The
  // reap completes within ms of unpause, so retry briefly to win that race
  // rather than fail. A truly-live second client keeps failing → gives up.
  for (
    let i = 0;
    i < REATTACH_RETRIES && !attachResp.ok && /already attached/i.test(attachResp.error ?? '');
    i++
  ) {
    await new Promise((r) => setTimeout(r, REATTACH_RETRY_MS));
    attachResp = await client.attachSession(sessionId, HOST_CHANNEL);
  }

  if (!attachResp.ok && /no such session/i.test(attachResp.error ?? '')) {
    // Resume only matters at CREATE time — if the broker already has this
    // session alive (reattach after an app restart where the broker kept
    // claude running), ATTACH succeeds above and the resume args are
    // correctly ignored: we must not spawn a second claude.
    //
    // Session identity (#195): the claude UUID this CREATE will run under is
    // decided HERE — resumeOf when resuming, else a host-generated UUID passed
    // as `--session-id`. The broker→claude mapping is learned before the
    // spawn instead of guessed later from JSONL appearance order (the old
    // pending-attach FIFO could pair a new JSONL with the wrong tab, and a
    // wrong row makes a later tab Refresh silently resume a different
    // conversation). Learning is deliberately NOT done on the plain-ATTACH
    // path above: an already-live claude keeps whatever id it already has.
    const claudeSessionId = resumeOf ?? randomUUID();
    const { mode, previous } = recordBrokerSessionMapping(workspaceId, sessionId, claudeSessionId);
    if (mode === 'deferred') {
      // Re-CREATE of a tab that still holds a real conversation, onto a fresh
      // (not-yet-written) session id. Parked until it produces a transcript so
      // a session that never gets used can't black-hole the tab (#170).
      logError({
        source: 'main',
        type: 'mapping-deferred',
        level: 'info',
        message: `broker ${sessionId} parked → ${claudeSessionId} at CREATE (awaiting transcript; keeping ${previous})`,
        workspaceId,
        extra: { brokerSessionId: sessionId, pending: claudeSessionId, keeping: previous }
      });
    } else if (previous && previous !== claudeSessionId) {
      logError({
        source: 'main',
        type: 'mapping-remapped',
        level: 'warn',
        message: `broker ${sessionId} remapped ${previous} → ${claudeSessionId} at CREATE`,
        workspaceId,
        extra: { brokerSessionId: sessionId, from: previous, to: claudeSessionId }
      });
    } else if (!previous) {
      logError({
        source: 'main',
        type: 'mapping-learned',
        level: 'info',
        message: `paired ${claudeSessionId} with broker ${sessionId} at CREATE (${resumeOf ? 'resume' : 'session-id'})`,
        workspaceId,
        extra: { claudeSessionId, brokerSessionId: sessionId, how: resumeOf ? 'resume' : 'session-id' }
      });
    }
    learnMirrorMapping(workspaceId, sessionId, claudeSessionId);
    if (resumeOf) recordUsageEvent({ workspaceId, sessionId: resumeOf, kind: 'resumed' });
    const createResp = await client.createSession(
      sessionId,
      cols,
      rows,
      harnessCreateArgs(harness, resumeOf, claudeSessionId)
    );
    if (!createResp.ok) {
      stream.destroy();
      client.close();
      throw new Error(`broker CREATE failed: ${createResp.error}`);
    }
    attachResp = await client.attachSession(sessionId, HOST_CHANNEL);
  }
  if (!attachResp.ok) {
    stream.destroy();
    client.close();
    throw new Error(`broker ATTACH failed: ${attachResp.error}`);
  }

  return {
    stream,
    resize: async (newCols, newRows) => {
      client.sendResize(HOST_CHANNEL, newCols, newRows);
    },
    detach: () => {
      void client.detachChannel(HOST_CHANNEL).catch(() => undefined);
      stream.destroy();
      client.close();
    },
    close: async () => {
      // CLOSE kills the PTY and drops the session (broker server.go: FrameClose
      // → mgr.Close(id)). Must go through this attached client — the broker only
      // honors CLOSE on a channel this connection actually holds.
      await client.closeChannel(HOST_CHANNEL).catch(() => undefined);
      stream.destroy();
      client.close();
    }
  };
}

/**
 * Read the last `tailLines` of the container's stdout/stderr. Used as
 * diagnostic context when attachPty fails. Returns empty string on any
 * error — never let this mask the underlying failure.
 */
export async function getBrokerLogs(
  containerId: string,
  tailLines = 100
): Promise<string> {
  try {
    const c = docker.getContainer(containerId);
    const buf = await c.logs({
      stdout: true,
      stderr: true,
      tail: tailLines,
      timestamps: true,
      follow: false,
    });
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Run a shell command inside a workspace's (running) container and capture its
 * combined output + exit code. Used by the loadout run layer (#16) for a
 * loadout's setup `scripts`. Runs `sh -lc <command>` as the container user in
 * `/workspace`. Throws if the container isn't found/running.
 */
export async function runInWorkspace(
  workspaceId: string,
  command: string
): Promise<{ exitCode: number; output: string }> {
  const found = await findContainerById(workspaceId);
  if (!found) throw new Error(`no container for workspace ${workspaceId}`);
  const container = docker.getContainer(found.Id);
  const exec = await container.exec({
    Cmd: ['sh', '-lc', command],
    WorkingDir: '/workspace',
    AttachStdout: true,
    AttachStderr: true
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const sink = new Writable({
      write(chunk, _enc, cb) {
        output += chunk.toString('utf8');
        cb();
      }
    });
    container.modem.demuxStream(stream, sink, sink);
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const info = await exec.inspect();
  return { exitCode: info.ExitCode ?? -1, output };
}
