// The fleet-embedder sidecar for the holder (D75): no in-process fallback and
// no model download; missing files or a crash loop turn search off.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EmbedderClient, EmbedderUnavailable } from '../main/embedderClient.js';
import type { EmbedFn } from '../main/vectors.js';
import type { Logger } from './log.js';

export const EMBED_MODEL_FILES = ['tokenizer.json', 'onnx/model_quantized.onnx'] as const;

export type HostEmbedderState = 'ready' | 'missing' | 'failed';

export interface HostEmbedder {
  embed: EmbedFn;
  state(): HostEmbedderState;
  pid(): number | undefined;
  /** Closes the sidecar's stdin; it exits on EOF. */
  close(): void;
}

export interface HostEmbedderOptions {
  dir: string;
  log: Logger;
  /** Tests: run this instead of `<dir>/fleet-embedder`; `--model-dir` is appended. */
  launch?: { bin: string; args: string[] };
  /** The sidecar's whole environment (D80). */
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

export function startHostEmbedder(o: HostEmbedderOptions): HostEmbedder {
  const exists = o.exists ?? existsSync;
  const modelDir = join(o.dir, 'model');
  const bin = o.launch?.bin ?? join(o.dir, 'fleet-embedder');
  const need = [...(o.launch ? [] : [bin]), ...EMBED_MODEL_FILES.map((f) => join(modelDir, ...f.split('/')))];
  const missing = need.filter((p) => !exists(p));
  if (missing.length) {
    const why = `not installed: ${missing.join(', ')}`;
    o.log.log('error', 'embedder unavailable; transcript search is off', { error: why });
    return {
      embed: async () => { throw new EmbedderUnavailable(why); },
      state: () => 'missing',
      pid: () => undefined,
      close: () => undefined
    };
  }
  let state: HostEmbedderState = 'ready';
  const client = new EmbedderClient({
    bin,
    args: [...(o.launch?.args ?? []), '--model-dir', modelDir],
    env: o.env ?? {},
    onFatal: (why) => {
      state = 'failed';
      o.log.log('error', 'embedder crash loop; transcript search is off until the next holder', { error: why });
    },
    log: (message) => o.log.log('warn', 'embedder', { message })
  });
  return { embed: (texts) => client.embed(texts), state: () => state, pid: () => client.pid, close: () => client.dispose() };
}
