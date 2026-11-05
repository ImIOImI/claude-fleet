// Bundle entry. `fleet-host init` resolves (or mints) the workspace id and exits.
import { existsSync } from 'node:fs';
import { loadHostConfig, readHostEnv } from './config.js';
import { resolveWorkspaceId } from './hostState.js';
import { redactSecrets } from './log.js';
import { runHost } from './main.js';

async function cli(argv: string[]): Promise<void> {
  if (argv[0] === 'init') {
    const env = readHostEnv(process.env);
    // Honour a configured workspace.id so init can't mint one the server would then refuse.
    const configured = existsSync(env.configPath) ? (await loadHostConfig(env.configPath)).workspace.id : null;
    const id = await resolveWorkspaceId(env.stateDir, configured);
    process.stdout.write(JSON.stringify({ workspaceId: id }) + '\n');
    return;
  }
  await runHost();
}

cli(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(JSON.stringify({ level: 'error', msg: 'fleet-host failed to start', error: redactSecrets(err.message) }) + '\n');
  process.exit(1);
});
