// Model files the fleet-embedder sidecar reads, in the transformers.js cache
// layout so the in-process fallback finds the same files.
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EMBED_HF_ID } from './vectors.js';

export const SIDECAR_MODEL_FILES = ['tokenizer.json', 'onnx/model_quantized.onnx'] as const;

export function modelDir(cacheDir: string): string {
  return join(cacheDir, ...EMBED_HF_ID.split('/'));
}

/** Fetch any missing sidecar file from the Hub; returns the model dir. */
export async function ensureModelFiles(cacheDir: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const dir = modelDir(cacheDir);
  for (const file of SIDECAR_MODEL_FILES) {
    const dest = join(dir, ...file.split('/'));
    if (await access(dest).then(() => true, () => false)) continue;
    const res = await fetchImpl(`https://huggingface.co/${EMBED_HF_ID}/resolve/main/${file}`);
    if (!res.ok || !res.body) throw new Error(`download ${file}: HTTP ${res.status}`);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  return dir;
}
