// Knowledge capture (#483): run a headless fork in the session's own backend.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { execScript as dockerExecScript } from '../docker.js';
import { buildEnv as localBuildEnv, ensureMcpConfig as localEnsureMcpConfig, resolveClaude as localResolveClaude } from '../local.js';
import {
  buildWslSpawnEnv,
  posixQuote,
  windowsPathToWslPath,
  wslInDistroPath,
  wslPassKeys,
  type WorkspaceLauncher
} from '../localLauncher.js';
import { readWorkspaceManifest } from '../workspaces.js';

export type CaptureTarget =
  | { kind: 'container'; workspaceId: string; cwd: string }
  | { kind: 'local'; workspaceId: string; launcher: WorkspaceLauncher; workspaceRoot: string };
export interface ExecOutcome { exitCode: number; stdout: string; stderr: string; timedOut: boolean }

export interface CaptureExecDeps {
  execScript: typeof dockerExecScript;
  spawnFile: (file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecOutcome>;
  buildEnv: (id: string) => Promise<NodeJS.ProcessEnv>;
  /** The workspace's own plain+secret env key names (not the values) — needed
   *  alongside `buildEnv`'s resolved env so the wsl branch can forward keys
   *  that don't match the ANTHROPIC_/CLAUDE_ auto-detected prefixes, exactly
   *  like a real session (localLauncher.ts:wrapSpawnForLauncher /
   *  local.ts:attachPty's `passEnvKeys`). Kept separate from `buildEnv` so
   *  each is independently mockable in tests. */
  workspaceEnvKeys: (id: string) => Promise<string[]>;
  ensureMcpConfig: (id: string, launcher: WorkspaceLauncher) => Promise<string | undefined>;
  resolveClaude: () => Promise<string>;
}

function defaultSpawnFile(file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({ exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: !!e?.killed });
    });
  });
}

const DEFAULT_DEPS: CaptureExecDeps = {
  execScript: dockerExecScript,
  spawnFile: defaultSpawnFile,
  buildEnv: async (id) => {
    const m = await readWorkspaceManifest(id);
    // `local.ts:buildEnv`'s second parameter types `env` as `Workspace['env']`
    // (`WorkspaceEnv = { plain: Record<string,string>; secretKeys: string[] }`,
    // a required field on WorkspaceSpec) — neither `[]` nor `{}` satisfy that
    // shape, so the empty default has to be a real (empty) WorkspaceEnv.
    return localBuildEnv(id, { env: m?.env ?? { plain: {}, secretKeys: [] }, authMode: m?.authMode, endpointId: m?.endpointId });
  },
  workspaceEnvKeys: async (id) => {
    const m = await readWorkspaceManifest(id);
    if (!m) return [];
    return [...Object.keys(m.env.plain), ...m.env.secretKeys];
  },
  ensureMcpConfig: localEnsureMcpConfig,
  // local.ts:resolveClaude resolves to `string | null` (null = not found).
  // CaptureExecDeps needs a non-nullable resolver, so turn "not found" into a
  // thrown error here rather than silently spawning `null`.
  resolveClaude: async () => {
    const p = await localResolveClaude();
    if (!p) throw new Error('knowledge capture: claude binary not found on this host');
    return p;
  }
};

export async function runCapture(target: CaptureTarget, args: string[], timeoutMs: number, deps: CaptureExecDeps = DEFAULT_DEPS): Promise<ExecOutcome> {
  if (target.kind === 'container') {
    // Container targets don't use --mcp-config: the fleet-state MCP server is
    // already wired into the container's own ~/.claude.json.
    const script = `cd ${posixQuote(target.cwd)} && exec claude ${args.map(posixQuote).join(' ')}`;
    return deps.execScript(target.workspaceId, { automationId: 'knowledge-capture', script, env: {}, timeoutMs });
  }
  const env = await deps.buildEnv(target.workspaceId);
  const l = target.launcher;
  // Wire the same session-scoped --mcp-config a real session gets (local.ts
  // ~564-570) so the fork can reach the fleet-state MCP server and actually
  // call record_claim — without this the fork authenticates fine but has no
  // tool to record anything with.
  const mcpConfigHostPath = await deps.ensureMcpConfig(target.workspaceId, l);
  if (l.mode === 'wsl') {
    // claude reads --mcp-config INSIDE the distro, so the host path must be
    // translated the same way local.ts:attachPty does for real sessions.
    const mcpConfigArg = mcpConfigHostPath ? (windowsPathToWslPath(mcpConfigHostPath) ?? mcpConfigHostPath) : undefined;
    const fullArgs = mcpConfigArg ? [...args, '--mcp-config', mcpConfigArg] : args;
    const cmd = `exec ${[l.claudePath, ...fullArgs].map(posixQuote).join(' ')}`;
    const extraKeys = await deps.workspaceEnvKeys(target.workspaceId);
    return deps.spawnFile('wsl.exe', ['-d', l.distro, '--cd', wslInDistroPath(target.workspaceRoot), '--exec', l.shell, '-lic', cmd],
      // wsl.exe itself needs a valid WINDOWS cwd (the Linux cwd goes via
      // --cd) — wrapSpawnForLauncher uses homedir() for the same reason.
      { cwd: homedir(), env: buildWslSpawnEnv(env, wslPassKeys(env, extraKeys)), timeoutMs });
  }
  if (l.mode !== 'native') throw new Error(`knowledge capture does not support launcher mode "${l.mode}" yet`);
  const fullArgs = mcpConfigHostPath ? [...args, '--mcp-config', mcpConfigHostPath] : args;
  return deps.spawnFile(await deps.resolveClaude(), fullArgs, { cwd: target.workspaceRoot, env, timeoutMs });
}
