// Bundle entry. `fleet-host init` resolves (or mints) the workspace id and exits.
import { existsSync } from 'node:fs';
import { loadHostConfig, readHostEnv } from './config.js';
import { openHostDb } from './hostDb.js';
import { resolveHostWorkspaceId, resolveWorkspaceId } from './hostState.js';
import { createLogger, redactSecrets } from './log.js';
import { runHost } from './main.js';

async function init(): Promise<string> {
  const env = readHostEnv(process.env);
  // Honour a configured workspace.id so init can't mint one the server would then refuse.
  const config = existsSync(env.configPath) ? await loadHostConfig(env.configPath) : null;
  const configured = config?.workspace.id ?? null;
  if (!config?.db) return resolveWorkspaceId(env.stateDir, configured);
  const log = createLogger((l) => process.stderr.write(l + '\n'));
  const db = await openHostDb(config.db, { env: process.env, log });
  try {
    return await resolveHostWorkspaceId(db.k, env.stateDir, configured, log);
  } finally {
    await db.end();
  }
}

async function cli(argv: string[]): Promise<void> {
  if (argv[0] === 'init') {
    process.stdout.write(JSON.stringify({ workspaceId: await init() }) + '\n');
    return;
  }
  await runHost();
}

cli(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(JSON.stringify({ level: 'error', msg: 'fleet-host failed to start', error: redactSecrets(err.message) }) + '\n');
  process.exit(1);
});
