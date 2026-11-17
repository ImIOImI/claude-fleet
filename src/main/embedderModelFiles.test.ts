import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureModelFiles, modelDir } from './embedderModelFiles.js';
import { EMBED_HF_REVISION } from './vectors.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'emb-files-'));

describe('ensureModelFiles', () => {
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

  it('uses the <org>/<repo> cache layout', () => {
    expect(modelDir('/c')).toBe(join('/c', 'Xenova', 'bge-small-en-v1.5'));
  });

  it('fetches only missing files', async () => {
    const cache = tmp();
    const dir = modelDir(cache);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tokenizer.json'), 'existing');
    const fetchImpl = vi.fn(async () => new Response('onnx-bytes')) as unknown as typeof fetch;
    const pins = { 'tokenizer.json': sha('existing'), 'onnx/model_quantized.onnx': sha('onnx-bytes') };
    expect(await ensureModelFiles(cache, fetchImpl, { sha256: pins })).toBe(dir);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe(
      `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${EMBED_HF_REVISION}/onnx/model_quantized.onnx`);
    expect(readFileSync(join(dir, 'onnx', 'model_quantized.onnx'), 'utf8')).toBe('onnx-bytes');
    expect(readFileSync(join(dir, 'tokenizer.json'), 'utf8')).toBe('existing');
  });

  it('replaces a corrupt cached file, then trusts the cache until the pins change', async () => {
    const cache = tmp();
    const dir = modelDir(cache);
    mkdirSync(join(dir, 'onnx'), { recursive: true });
    writeFileSync(join(dir, 'tokenizer.json'), 'truncat');
    writeFileSync(join(dir, 'onnx', 'model_quantized.onnx'), 'onnx-bytes');
    const pins = { 'tokenizer.json': sha('tok-bytes'), 'onnx/model_quantized.onnx': sha('onnx-bytes') };
    const fetchImpl = vi.fn(async () => new Response('tok-bytes')) as unknown as typeof fetch;
    await ensureModelFiles(cache, fetchImpl, { sha256: pins });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, 'tokenizer.json'), 'utf8')).toBe('tok-bytes');
    expect(readdirSync(dir)).toContain(`.verified-${EMBED_HF_REVISION}`);
    // Verified: not re-hashed on the next start.
    writeFileSync(join(dir, 'tokenizer.json'), 'changed-after-verify');
    await ensureModelFiles(cache, fetchImpl, { sha256: pins });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // New pins: the cached file is hashed again, fails, and is refetched.
    vi.mocked(fetchImpl).mockImplementation(async () => new Response('fresh'));
    await ensureModelFiles(cache, fetchImpl, { sha256: { ...pins, 'tokenizer.json': sha('fresh') } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(dir, 'tokenizer.json'), 'utf8')).toBe('fresh');
  });

  it('sweeps leftover temp files', async () => {
    const cache = tmp();
    const dir = modelDir(cache);
    mkdirSync(join(dir, 'onnx'), { recursive: true });
    writeFileSync(join(dir, 'tokenizer.json.123.tmp'), 'x');
    writeFileSync(join(dir, 'onnx', 'model_quantized.onnx.456.tmp'), 'x');
    const fetchImpl = vi.fn(async (u: string) => new Response(u.endsWith('tokenizer.json') ? 'a' : 'b')) as unknown as typeof fetch;
    await ensureModelFiles(cache, fetchImpl, { sha256: { 'tokenizer.json': sha('a'), 'onnx/model_quantized.onnx': sha('b') } });
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(join(dir, 'onnx'))).toEqual(['model_quantized.onnx']);
  });

  it('aborts the download when the temp file cannot be written', async () => {
    const cache = tmp();
    const dir = modelDir(cache);
    // A directory where the temp file should go: the write stream fails with EISDIR.
    mkdirSync(join(dir, `tokenizer.json.${process.pid}.tmp`), { recursive: true });
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('partial')); } }))) as unknown as typeof fetch;
    await expect(ensureModelFiles(cache, fetchImpl, { stallMs: 30_000, totalMs: 30_000 })).rejects.toThrow(/EISDIR|illegal operation/);
  }, 10_000);

  it('rejects a file whose sha256 does not match the pin and keeps nothing', async () => {
    const cache = tmp();
    const fetchImpl = vi.fn(async () => new Response('tampered')) as unknown as typeof fetch;
    await expect(ensureModelFiles(cache, fetchImpl)).rejects.toThrow(/sha256 [0-9a-f]{64}, expected/);
    expect(readdirSync(modelDir(cache))).toEqual([]);
  });

  it('throws on a failed download and leaves no partial file', async () => {
    const cache = tmp();
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(ensureModelFiles(cache, fetchImpl)).rejects.toThrow('HTTP 503');
    expect(readdirSync(modelDir(cache))).toEqual([]);
  });

  it('aborts a download that stops sending bytes', async () => {
    const cache = tmp();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('partial')); },
    }))) as unknown as typeof fetch;
    await expect(ensureModelFiles(cache, fetchImpl, { stallMs: 100 })).rejects.toThrow('stalled');
    expect(readdirSync(join(modelDir(cache)))).toEqual([]);
  });

  it('aborts a request that never answers', async () => {
    const cache = tmp();
    const fetchImpl = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    await expect(ensureModelFiles(cache, fetchImpl, { totalMs: 100, stallMs: 10_000 })).rejects.toThrow('timed out');
  });
});
