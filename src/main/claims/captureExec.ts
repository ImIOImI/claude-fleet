// Knowledge capture (#483): run a headless fork in the session's own backend.
import { execFile } from 'node:child_process';
import { execScript as dockerExecScript } from '../docker.js';
import { buildEnv as localBuildEnv, ensureMcpConfig as localEnsureMcpConfig, resolveClaude as localResolveClaude } from '../local.js';
import { buildWslSpawnEnv, posixQuote, wslInDistroPath, type WorkspaceLauncher } from '../localLauncher.js';
import { readWorkspaceManifest } from '../workspaces.js';

export type CaptureTarget =
  | { kind: 'container'; workspaceId: string; cwd: string }
  | { kind: 'local'; workspaceId: string; launcher: WorkspaceLauncher; workspaceRoot: string };
export interface ExecOutcome { exitCode: number; stdout: string; stderr: string; timedOut: boolean }

export interface CaptureExecDeps {
  execScript: typeof dockerExecScript;
  spawnFile: (file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecOutcome>;
  buildEnv: (id: string) => Promise<NodeJS.ProcessEnv>;
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
    const script = `cd ${posixQuote(target.cwd)} && exec claude ${args.map(posixQuote).join(' ')}`;
    return deps.execScript(target.workspaceId, { automationId: 'knowledge-capture', script, env: {}, timeoutMs });
  }
  const env = await deps.buildEnv(target.workspaceId);
  const l = target.launcher;
  if (l.mode === 'wsl') {
    const cmd = `exec ${[l.claudePath, ...args].map(posixQuote).join(' ')}`;
    return deps.spawnFile('wsl.exe', ['-d', l.distro, '--cd', wslInDistroPath(target.workspaceRoot), '--exec', l.shell, '-lic', cmd],
      { cwd: process.cwd(), env: buildWslSpawnEnv(env, []), timeoutMs });
  }
  if (l.mode !== 'native') throw new Error(`knowledge capture does not support launcher mode "${l.mode}" yet`);
  return deps.spawnFile(await deps.resolveClaude(), args, { cwd: target.workspaceRoot, env, timeoutMs });
}
