import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureModelFiles, modelDir } from './embedderModelFiles.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'emb-files-'));

describe('ensureModelFiles', () => {
  it('uses the transformers.js cache layout', () => {
    expect(modelDir('/c')).toBe(join('/c', 'Xenova', 'bge-small-en-v1.5'));
  });

  it('fetches only missing files', async () => {
    const cache = tmp();
    const dir = modelDir(cache);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tokenizer.json'), 'existing');
    const fetchImpl = vi.fn(async () => new Response('onnx-bytes')) as unknown as typeof fetch;
    expect(await ensureModelFiles(cache, fetchImpl)).toBe(dir);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe(
      'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx');
    expect(readFileSync(join(dir, 'onnx', 'model_quantized.onnx'), 'utf8')).toBe('onnx-bytes');
    expect(readFileSync(join(dir, 'tokenizer.json'), 'utf8')).toBe('existing');
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
