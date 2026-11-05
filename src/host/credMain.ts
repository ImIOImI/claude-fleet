// Bundle entry for fleet-host-cred.mjs. git runs it per credential lookup, so
// `serve`'s dependencies (config, and through it the store's AWS SDK) load lazily.
import { execFileSync } from 'node:child_process';
import { runCredCli } from './credCli.js';
import { createLogger, redactSecrets } from './log.js';

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'serve') {
    const { serveCred } = await import('./credServe.js');
    await serveCred({ env: process.env, log: createLogger(), proc: process });
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
    stdoutIsTty: process.stdout.isTTY === true,
    cwdRemotes: () => {
      let text: string;
      try {
        text = execFileSync('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
      } catch {
        return [];
      }
      return text.split('\n').flatMap((l) => {
        const m = /^remote\.(.+)\.url (.+)$/.exec(l.trim());
        return m ? [{ name: m[1], url: m[2] }] : [];
      });
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
