// `fleet-host loadouts sync`, run by `fleet-host-entry workspace` as uid 1000 before the broker (SPEC §4 Supervision).
import { spawn } from 'node:child_process';
import { requestToken, type CredEndpoint } from './credCli.js';
import { DEFAULT_CRED_SOCKET } from './credServer.js';
import { parseHostPort } from './endpoint.js';
import { DEFAULT_SYNC_TIMEOUT_S, parseTimeoutS } from './loadoutPins.js';
import { syncLoadouts, type ScriptRun } from './loadoutSync.js';
import { createLogger, type Logger } from './log.js';

export const SYNC_TARGET = '/workspace';
const SCRIPT_OUTPUT_MAX = 64 * 1024;
/** fleet-host-entry's `timeout` fires at the cap; stopping this much earlier leaves time to log. */
const EXIT_MARGIN_MS = 5_000;

/** `env` is the entry script's environment, which never holds the token. */
export function runScript(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<ScriptRun> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn('sh', ['-lc', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, Math.max(1, timeoutMs));
    const settle = (r: ScriptRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const take = (c: Buffer): void => {
      if (output.length < SCRIPT_OUTPUT_MAX) output += c.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => settle({ exitCode: -1, output: e.message }));
    child.on('close', (code, signal) => settle({ exitCode: code ?? (signal ? 128 : -1), output }));
  });
}

export async function loadoutsCli(argv: string[], env: NodeJS.ProcessEnv, target = SYNC_TARGET, log: Logger = createLogger()): Promise<number> {
  if (argv.length !== 1 || argv[0] !== 'sync') {
    log.log('error', 'usage: fleet-host loadouts sync');
    return 2;
  }
  let timeoutS = DEFAULT_SYNC_TIMEOUT_S;
  try {
    timeoutS = parseTimeoutS(env.FLEET_LOADOUTS_TIMEOUT_S);
  } catch (e) {
    log.log('warn', 'loadout sync timeout ignored', { error: (e as Error).message, timeoutS });
  }
  const addr = env.FLEET_HOST_CRED_ADDR;
  const endpoint: CredEndpoint | null = addr ? parseHostPort(addr) : env.FLEET_HOST_CRED_SOCKET || DEFAULT_CRED_SOCKET;
  await syncLoadouts({
    env,
    target,
    log,
    budgetMs: Math.max(1_000, timeoutS * 1000 - EXIT_MARGIN_MS),
    token: (owner, repo) =>
      endpoint
        ? requestToken(endpoint, { owner, repositories: [repo], permissions: { contents: 'read' } })
        : Promise.reject(new Error('FLEET_HOST_CRED_ADDR is not host:port')),
    runScript: (command, cwd, timeoutMs) => runScript(command, cwd, timeoutMs, env)
  });
  return 0;
}
