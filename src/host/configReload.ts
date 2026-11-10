// Hot reload of the read-only ConfigMap mount. Kubernetes swaps the `..data`
// symlink in the mount directory, so the directory is watched, not the file.
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { HostConfig } from './config.js';
import type { Logger } from './log.js';

export interface Reloader {
  /**
   * Load, validate, apply. The first accepted config is the baseline; any
   * refusal returns false before `apply` and keeps the current config. A
   * deep-equal config is accepted without `apply`. Calls are serialized.
   */
  reload(reason: string): Promise<boolean>;
  current(): HostConfig | null;
}

export function createReloader(opts: {
  path: string;
  load(path: string): Promise<HostConfig>;
  apply(config: HostConfig): Promise<void>;
  log: Logger;
}): Reloader {
  let current: HostConfig | null = null;
  let chain: Promise<boolean> = Promise.resolve(true);

  async function step(reason: string): Promise<boolean> {
    const reject = (error: string): boolean => {
      opts.log.log('warn', 'config reload rejected; keeping current config', { reason, error });
      return false;
    };
    let cfg: HostConfig;
    try {
      cfg = await opts.load(opts.path);
    } catch (err) {
      return reject((err as Error).message);
    }
    if (current) {
      // The id is fixed at start (resolveWorkspaceId); a restart is the only way to change it.
      if (cfg.workspace.id !== current.workspace.id) {
        return reject(`workspace.id cannot change on reload (running ${current.workspace.id ?? 'unset'}, file ${cfg.workspace.id ?? 'unset'})`);
      }
      // The credential helper loads the App key once at start.
      if (!isDeepStrictEqual(cfg.github?.app ?? null, current.github?.app ?? null)) {
        return reject('github.appId, github.installationId and github.keyFile cannot change on reload');
      }
      if (!isDeepStrictEqual(cfg.db, current.db)) return reject('db cannot change on reload; restart to apply');
      if (!isDeepStrictEqual(cfg.search, current.search)) return reject('search cannot change on reload; restart to apply');
      if (isDeepStrictEqual(cfg, current)) {
        opts.log.log('info', 'config unchanged', { reason });
        return true;
      }
    }
    try {
      await opts.apply(cfg);
    } catch (err) {
      opts.log.log('error', 'config apply failed; keeping current config', { reason, error: err });
      return false;
    }
    current = cfg;
    opts.log.log('info', 'config reloaded', { reason, grants: cfg.grants.grants.length, machines: cfg.grants.machines.length });
    return true;
  }

  return {
    reload(reason) {
      chain = chain.then(() => step(reason));
      return chain;
    },
    current: () => current
  };
}

export function watchConfigDir(path: string, onChange: () => void, debounceMs = 250, onError?: (err: Error) => void): () => void {
  const file = basename(path);
  let timer: NodeJS.Timeout | null = null;
  let w: FSWatcher;
  try {
    w = watch(dirname(path), (_event, name) => {
      if (name !== null && name !== file && name !== '..data') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
    });
  } catch (err) {
    onError?.(err as Error);
    return () => undefined;
  }
  // An unhandled watcher error would be fatal to the process.
  w.on('error', (err) => onError?.(err));
  return () => {
    if (timer) clearTimeout(timer);
    w.close();
  };
}
