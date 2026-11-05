// Bundle entry for fleet-host-cred.mjs. git runs it per credential lookup, so
// `serve`'s dependencies (config, and through it the store's AWS SDK) load lazily.
import { execFileSync } from 'node:child_process';
import { runCredCli } from './credCli.js';
import { createLogger, redactSecrets } from './log.js';

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'serve') {
    const { loadHostConfig, readHostEnv } = await import('./config.js');
    const { startCredHelper } = await import('./credServer.js');
    const env = readHostEnv(process.env);
    const config = await loadHostConfig(env.configPath);
    const app = config.github?.app;
    if (!app) throw new Error('serve needs github.appId, github.installationId and github.keyFile in the host config');
    await startCredHelper({ app, socketPath: env.credSocket, github: () => config.github, log: createLogger() });
    return new Promise<number>(() => undefined);
  }
  return runCredCli(argv, {
    env: process.env,
    stdin: async () => {
      if (process.stdin.isTTY) return '';
      let s = '';
      for await (const c of process.stdin) s += c;
      return s;
    },
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwdOrigin: () => {
      try {
        return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
      } catch {
        return null;
      }
    }
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`fleet-host-cred: ${redactSecrets(err.message)}\n`);
    process.exit(1);
  }
);
