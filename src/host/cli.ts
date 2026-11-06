// Bundle entry: the host, or a one-shot `init` (resolve or mint the workspace id), `bootstrap` or `migrate` (dbCli.ts),
// or `write-mcp-bridge <path>` (image build).
import { existsSync } from 'node:fs';
import { loadHostConfig, readHostEnv } from './config.js';
import { openHostDb } from './hostDb.js';
import { resolveHostWorkspaceId, resolveWorkspaceId } from './hostState.js';
import { runDbCommand } from './dbCli.js';
import { createLogger, redactSecrets } from './log.js';
import { runHost } from './main.js';
import { writeMcpBridge } from './mcpBridgeFile.js';

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
  if (argv[0] === 'write-mcp-bridge') {
    if (!argv[1]) {
      process.stderr.write('usage: fleet-host write-mcp-bridge <path>\n');
      process.exit(2);
    }
    writeMcpBridge(argv[1]);
    return;
  }
  // Anything else exits (2 if unknown) rather than starting a host inside a Job.
  if (argv.length > 0) {
    const code = await runDbCommand(argv, { env: process.env, sink: (l) => process.stdout.write(l + '\n') });
    await new Promise<void>((r) => process.stdout.write('', () => r()));
    process.exit(code);
  }
  await runHost();
}

cli(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(JSON.stringify({ level: 'error', msg: 'fleet-host failed to start', error: redactSecrets(err.message) }) + '\n');
  process.exit(1);
});
