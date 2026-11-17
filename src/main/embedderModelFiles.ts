// Model files the fleet-embedder sidecar reads, under <cache>/<org>/<repo>/.
// Downloads come from the pinned revision and are kept only if their sha256 matches.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EMBED_HF_ID, EMBED_HF_REVISION, EMBED_MODEL_SHA256 } from './vectors.js';

export const SIDECAR_MODEL_FILES = ['tokenizer.json', 'onnx/model_quantized.onnx'] as const;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const DOWNLOAD_STALL_MS = 60_000;

export function modelDir(cacheDir: string): string {
  return join(cacheDir, ...EMBED_HF_ID.split('/'));
}

export interface DownloadLimits {
  totalMs?: number;
  stallMs?: number;
  /** Expected sha256 per file; defaults to EMBED_MODEL_SHA256. */
  sha256?: Readonly<Record<string, string>>;
}

/** Fetch any missing sidecar file from the Hub; returns the model dir. A
 *  download is aborted after `totalMs`, or when no bytes arrive for `stallMs`. */
export async function ensureModelFiles(
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
  limits: DownloadLimits = {},
): Promise<string> {
  const dir = modelDir(cacheDir);
  const pins = limits.sha256 ?? EMBED_MODEL_SHA256;
  for (const file of SIDECAR_MODEL_FILES) {
    const dest = join(dir, ...file.split('/'));
    if (await access(dest).then(() => true, () => false)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await download(fetchImpl, `https://huggingface.co/${EMBED_HF_ID}/resolve/${EMBED_HF_REVISION}/${file}`, dest, limits, pins[file]);
  }
  return dir;
}

async function download(fetchImpl: typeof fetch, url: string, dest: string, limits: DownloadLimits, sha256: string | undefined): Promise<void> {
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
  const hash = createHash('sha256');
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
      hash.update(value);
      if (!out.write(value)) await Promise.race([new Promise<void>((r) => out.once('drain', () => r())), aborted]);
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    const got = hash.digest('hex');
    if (sha256 && got !== sha256) throw new Error(`download ${url}: sha256 ${got}, expected ${sha256}`);
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
