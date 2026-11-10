// Local, on-host embedder. Transcript text never leaves the machine. Runs in
// the fleet-embedder sidecar (embedder/) so model load and inference stay off
// the main thread (#464); falls back to transformers.js in process.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { EmbedderClient, EmbedderUnavailable } from './embedderClient.js';
import { ensureModelFiles } from './embedderModelFiles.js';
import { makeWorkerSpawner } from './embedderSpawnWorker.js';
import { makeInProcessEmbedder } from './embeddingsInProcess.js';
import { logError } from './errorLog.js';
import { perfSpanAsync } from './perf.js';
import type { EmbedFn } from './vectors.js';

export interface BinLookup {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  exists?: (p: string) => boolean;
}

/** First existing of FLEET_EMBEDDER_BIN, the packaged resource, the dev build. */
export function resolveEmbedderBin(l: BinLookup): string | null {
  const exe = l.platform === 'win32' ? 'fleet-embedder.exe' : 'fleet-embedder';
  const exists = l.exists ?? existsSync;
  const candidates = [
    l.env.FLEET_EMBEDDER_BIN,
    l.packaged ? join(l.resourcesPath, 'embedder', exe) : join(l.appPath, 'embedder', 'target', 'release', exe),
  ];
  return candidates.find((p): p is string => !!p && exists(p)) ?? null;
}

function defaultBin(): string | null {
  return resolveEmbedderBin({
    env: process.env,
    platform: process.platform,
    packaged: app?.isPackaged ?? false,
    resourcesPath: process.resourcesPath ?? '',
    appPath: app?.getAppPath?.() ?? process.cwd(),
  });
}

export interface MakeEmbedderOptions {
  /** Overrides the lookup; null means "no binary". */
  bin?: string | null;
  forceInProcess?: boolean;
  /** For tests. */
  inProcess?: () => EmbedFn;
  ensureFiles?: (cacheDir: string) => Promise<string>;
  now?: () => number;
}

/** After a failed model download, embeds reject for this long before retrying. */
export const MODEL_FILES_RETRY_MS = 5 * 60_000;

export class EmbedderModelFilesUnavailable extends Error {}

export function makeEmbedder(cacheDir: string, opts: MakeEmbedderOptions = {}): EmbedFn {
  let inProcess: EmbedFn | null = null;
  let clientP: Promise<EmbedderClient | null> | null = null;
  let fallbackReason: string | null = null;
  let filesFailed: { at: number; reason: string } | null = null;
  const now = opts.now ?? Date.now;

  const fallBack = (reason: string): EmbedFn => {
    if (fallbackReason === null) {
      fallbackReason = reason;
      logError({ source: 'main', level: 'warn', type: 'embedder-fallback', message: reason });
    }
    return (inProcess ??= (opts.inProcess ?? (() => makeInProcessEmbedder(cacheDir)))());
  };

  const startClient = async (): Promise<EmbedderClient | null> => {
    if (opts.forceInProcess || process.env.CLAUDE_FLEET_EMBEDDER === 'inprocess') {
      fallBack('CLAUDE_FLEET_EMBEDDER=inprocess');
      return null;
    }
    const bin = opts.bin !== undefined ? opts.bin : defaultBin();
    if (!bin) { fallBack('fleet-embedder binary not found'); return null; }
    let dir: string;
    try {
      dir = await (opts.ensureFiles ?? ensureModelFiles)(cacheDir);
    } catch (e) {
      // Transient (network): not a reason to give up on the sidecar for the run.
      filesFailed = { at: now(), reason: String(e) };
      logError({ source: 'main', level: 'warn', type: 'embedder-model-files', message: filesFailed.reason });
      throw new EmbedderModelFilesUnavailable(`embedding model files unavailable: ${filesFailed.reason}`);
    }
    return new EmbedderClient({
      bin,
      args: ['--model-dir', dir],
      onFatal: (why) => fallBack(`fleet-embedder crash loop: ${why}`),
      log: (message) => logError({ source: 'main', level: 'warn', type: 'embedder-stderr', message }),
      onSpawn: (ready) => { void perfSpanAsync('claude_fleet.embed.spawn', () => ready).catch(() => {}); },
      spawner: makeWorkerSpawner({
        onCreating: (created) => { void perfSpanAsync('claude_fleet.embed.create_process', () => created).catch(() => {}); },
      }),
    });
  };

  return async function embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (fallbackReason === null) {
      if (filesFailed && now() - filesFailed.at < MODEL_FILES_RETRY_MS) {
        throw new EmbedderModelFilesUnavailable(`embedding model files unavailable: ${filesFailed.reason}`);
      }
      const p = (clientP ??= startClient());
      let client: EmbedderClient | null;
      try {
        client = await p;
      } catch (e) {
        if (clientP === p) clientP = null;
        throw e;
      }
      if (client && fallbackReason === null) {
        const c = client;
        try {
          return await perfSpanAsync('claude_fleet.embed.run', () => c.embed(texts), { texts: texts.length });
        } catch (e) {
          if (!(e instanceof EmbedderUnavailable)) throw e;
          fallBack(e.message);
        }
      }
    }
    return fallBack(fallbackReason ?? 'unknown')(texts);
  };
}
