// Model files the fleet-embedder sidecar reads, in the transformers.js cache
// layout so the in-process fallback finds the same files.
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EMBED_HF_ID } from './vectors.js';

export const SIDECAR_MODEL_FILES = ['tokenizer.json', 'onnx/model_quantized.onnx'] as const;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const DOWNLOAD_STALL_MS = 60_000;

export function modelDir(cacheDir: string): string {
  return join(cacheDir, ...EMBED_HF_ID.split('/'));
}

export interface DownloadLimits { totalMs?: number; stallMs?: number }

/** Fetch any missing sidecar file from the Hub; returns the model dir. A
 *  download is aborted after `totalMs`, or when no bytes arrive for `stallMs`. */
export async function ensureModelFiles(
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
  limits: DownloadLimits = {},
): Promise<string> {
  const dir = modelDir(cacheDir);
  for (const file of SIDECAR_MODEL_FILES) {
    const dest = join(dir, ...file.split('/'));
    if (await access(dest).then(() => true, () => false)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await download(fetchImpl, `https://huggingface.co/${EMBED_HF_ID}/resolve/main/${file}`, dest, limits);
  }
  return dir;
}

async function download(fetchImpl: typeof fetch, url: string, dest: string, limits: DownloadLimits): Promise<void> {
  const stallMs = limits.stallMs ?? DOWNLOAD_STALL_MS;
  const ctl = new AbortController();
  const total = setTimeout(() => ctl.abort(new Error(`download timed out: ${url}`)), limits.totalMs ?? DOWNLOAD_TIMEOUT_MS);
  let stall: NodeJS.Timeout | undefined;
  const armStall = (): void => {
    clearTimeout(stall);
    stall = setTimeout(() => ctl.abort(new Error(`download stalled for ${stallMs} ms: ${url}`)), stallMs);
  };
  const tmp = `${dest}.${process.pid}.tmp`;
  const out = createWriteStream(tmp);
  try {
    armStall();
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const aborted = new Promise<never>((_, reject) => {
      if (ctl.signal.aborted) reject(ctl.signal.reason);
      ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    for (;;) {
      armStall();
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!out.write(value)) await Promise.race([new Promise<void>((r) => out.once('drain', () => r())), aborted]);
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    await rename(tmp, dest);
  } catch (e) {
    out.destroy();
    await rm(tmp, { force: true });
    throw ctl.signal.aborted ? ctl.signal.reason : e;
  } finally {
    clearTimeout(total);
    clearTimeout(stall);
  }
}
