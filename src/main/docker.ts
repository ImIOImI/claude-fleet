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
import { dirname } from 'node:path';
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
import type { AuthMode, Workspace, WorkspaceEnv, WorkspaceResources, WorkspaceKind } from './workspaces.js';
import { FACTORY_MIRROR } from './workspaces.js';
import { fleetPrivateDir, fleetSharedDir } from './config.js';
import { mcpWorkspaceSocketDir, mcpWorkspaceBind, CONTAINER_MCP_SOCKET } from './mcpSocket.js';
import { BrokerClient, brokerPtyStream } from './broker.js';
import { recordPendingAttach } from './pendingAttaches.js';
import { learnBrokerSessionMapping } from './db.js';
import { learnMapping as learnMirrorMapping } from './mirrorPolicy.js';
import { resolveEnv } from './vault.js';

export const FLEET_LABEL = 'com.claude-fleet.managed';
export const ID_LABEL = 'com.claude-fleet.id';
export const NAME_LABEL = 'com.claude-fleet.name';
export const SUBDIR_LABEL = 'com.claude-fleet.subdir';
export const WORKSPACE_ROOT_LABEL = 'com.claude-fleet.workspace-root';
export const RUNNER_IMAGE = 'ghcr.io/imioimi/claude-fleet/runner:latest';

const docker = new Docker();

function containerNameFor(id: string): string {
  return `cf-${id}`;
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
   */
  authMode: AuthMode;
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

export async function ping(): Promise<boolean> {
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
} {
  return {
    type: 'stdio',
    command: 'sh',
    args: [
      '-c',
      `while :; do socat - "UNIX-CONNECT:${CONTAINER_MCP_SOCKET},forever,interval=1"; sleep 1; done`
    ]
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

export async function createWorkspace(spec: CreateWorkspaceInput): Promise<Workspace> {
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

  const image = spec.image?.trim() || RUNNER_IMAGE;
  // Resolve secrets at create-time; the merged env goes straight to the
  // container's `Env` array. Missing secret keys resolve to empty string
  // so the container still starts (claude itself surfaces the failure
  // later via its own error path).
  const resolvedEnv = await resolveEnv(spec.id, spec.env.plain, spec.env.secretKeys);
  const envArr = ['HOME=/home/fleet', ...Object.entries(resolvedEnv).map(([k, v]) => `${k}=${v}`)];

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
  if (spec.authMode === 'oauth') {
    const sharedCreds = await ensureSharedCredentialsFile();
    binds.push(`${sharedCreds}:/home/fleet/.claude/.credentials.json:rw`);
    const sharedRemoteSettings = await ensureSharedRemoteSettingsFile();
    binds.push(`${sharedRemoteSettings}:/home/fleet/.claude/remote-settings.json:rw`);
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

  const created = await docker.createContainer({
    name: containerNameFor(spec.id),
    Image: image,
    User: `${uid}:${gid}`,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    WorkingDir: workingDir,
    Env: envArr,
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
export async function startWorkspace(id: string): Promise<string | null> {
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
export async function pauseWorkspace(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  try {
    await c.pause();
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 409 && status !== 404) throw err;
  }
}

export async function stopWorkspace(containerId: string): Promise<void> {
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
  resize: (cols: number, rows: number) => Promise<void>;
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
  const sockPath = workspaceBrokerSocket(workspaceId);
  const PER_ATTEMPT_MS = 1500;
  let lastErr: unknown;
  for (let i = 0; i < REATTACH_RETRIES; i++) {
    const client = new BrokerClient(sockPath);
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
  const client = new BrokerClient(workspaceBrokerSocket(workspaceId));
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
    client.sendInput(HOST_CHANNEL, Buffer.from(text + '\r', 'utf8'));
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
export async function attachPty(
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

  // Per-tab mapping. Two paths:
  //  - Fresh session: record a "pending" attach so the JsonlWatcher's
  //    new-session hook pairs the broker session id with the claude UUID
  //    the first time a brand-new JSONL appears.
  //  - Resume: the claude UUID is already known (it's what we're
  //    resuming), and `claude --resume` APPENDS to the existing
  //    `<uuid>.jsonl` rather than creating a new one — so no 'new-session'
  //    event ever fires for it. Learn the broker→claude mapping directly
  //    and skip the pending queue, or the per-tab observability lookup
  //    would never resolve.
  if (resumeOf) {
    learnBrokerSessionMapping(workspaceId, sessionId, resumeOf);
    learnMirrorMapping(workspaceId, sessionId, resumeOf);
  } else {
    recordPendingAttach(workspaceId, sessionId);
  }

  const sockPath = workspaceBrokerSocket(workspaceId);
  const client = new BrokerClient(sockPath);
  try {
    await client.ready();
  } catch (err) {
    client.close();
    throw new Error(
      `broker socket not reachable at ${sockPath}: ${(err as Error).message}. ` +
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
    const createResp = await client.createSession(
      sessionId,
      cols,
      rows,
      resumeOf ? ['--resume', resumeOf] : undefined
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
