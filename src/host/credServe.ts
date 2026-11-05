// `fleet-host-cred serve`: the credential socket without fleet-host, reloading
// the host config on file change and SIGHUP like runHost.
import { loadHostConfig, readHostEnv, type HostConfig } from './config.js';
import { createReloader, watchConfigDir } from './configReload.js';
import { startCredHelper, type CredServer } from './credServer.js';
import type { Logger } from './log.js';

export async function serveCred(o: { env: NodeJS.ProcessEnv; log: Logger; proc: NodeJS.EventEmitter; apiBase?: string }): Promise<CredServer> {
  const env = readHostEnv(o.env);
  let config: HostConfig | null = null;
  const reloader = createReloader({ path: env.configPath, load: loadHostConfig, apply: async (c) => void (config = c), log: o.log });
  if (!(await reloader.reload('start')) || !config) throw new Error(`host config rejected: ${env.configPath}`);
  const app = (config as HostConfig).github?.app;
  if (!app) throw new Error('serve needs github.appId, github.installationId and github.keyFile in the host config');
  const server = await startCredHelper({ app, socketPath: env.credSocket, github: () => config!.github, log: o.log, apiBase: o.apiBase });
  const stopWatch = watchConfigDir(
    env.configPath,
    () => void reloader.reload('file change'),
    undefined,
    (err) => o.log.log('warn', 'config watch failed; SIGHUP still reloads', { error: err.message })
  );
  const onHup = (): void => void reloader.reload('SIGHUP');
  o.proc.on('SIGHUP', onHup);
  return {
    close: async () => {
      stopWatch();
      o.proc.off('SIGHUP', onHup);
      await server.close();
    }
  };
}
