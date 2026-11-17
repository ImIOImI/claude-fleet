import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';

const logs: { type: string; message: string }[] = [];
vi.mock('./errorLog.js', () => ({ logError: (e: { type: string; message: string }) => { logs.push(e); } }));

const { makeEmbedder, resolveEmbedderBin, MODEL_FILES_RETRY_MS, EmbedderModelFilesUnavailable } = await import('./embeddings.js');
const { EmbedderUnavailable } = await import('./embedderClient.js');

const HF_CACHE = join(tmpdir(), 'claude-fleet-hf-cache-unused');
const unavailable = (): number => logs.filter((l) => l.type === 'embedder-unavailable').length;

beforeEach(() => { logs.length = 0; });

describe('resolveEmbedderBin', () => {
  const base = { env: {}, platform: 'linux' as const, packaged: true, resourcesPath: '/res', appPath: '/app' };
  it('prefers FLEET_EMBEDDER_BIN, then the packaged resource', () => {
    expect(resolveEmbedderBin({ ...base, env: { FLEET_EMBEDDER_BIN: '/x' }, exists: () => true })).toBe('/x');
    expect(resolveEmbedderBin({ ...base, exists: (p) => p !== '/x' })).toBe(join('/res', 'embedder', 'fleet-embedder'));
  });
  it('uses the dev build and .exe on Windows', () => {
    expect(resolveEmbedderBin({ ...base, platform: 'win32', packaged: false, exists: () => true }))
      .toBe(join('/app', 'embedder', 'target', 'release', 'fleet-embedder.exe'));
  });
  it('returns null when nothing exists', () => {
    expect(resolveEmbedderBin({ ...base, exists: () => false })).toBeNull();
  });
});

describe('makeEmbedder without a working sidecar', () => {
  const ensureFiles = async () => '/unused';

  it('returns [] for empty input without starting anything', async () => {
    const ensure = vi.fn(ensureFiles);
    expect(await makeEmbedder(HF_CACHE, { bin: null, ensureFiles: ensure })([])).toEqual([]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('rejects with EmbedderUnavailable when the binary is missing, logging once', async () => {
    const embed = makeEmbedder(HF_CACHE, { bin: null, ensureFiles });
    await expect(embed(['a'])).rejects.toBeInstanceOf(EmbedderUnavailable);
    await expect(embed(['b'])).rejects.toThrow(/semantic search unavailable: fleet-embedder binary not found/);
    expect(unavailable()).toBe(1);
  });

  it('turns off for the run after a sidecar crash loop', async () => {
    const embed = makeEmbedder(HF_CACHE, { bin: '/nonexistent/fleet-embedder', ensureFiles });
    for (let i = 0; i < 3; i++) await embed(['a']).catch(() => null);
    await expect(embed(['b'])).rejects.toThrow(/semantic search unavailable: fleet-embedder crash loop/);
    expect(unavailable()).toBe(1);
  }, 30_000);

  it('retries model files after a cooldown instead of turning off', async () => {
    let t = 0;
    const ensure = vi.fn(async () => { throw new Error('offline'); });
    const embed = makeEmbedder(HF_CACHE, { bin: '/some/fleet-embedder', ensureFiles: ensure, now: () => t });
    await expect(embed(['a'])).rejects.toBeInstanceOf(EmbedderModelFilesUnavailable);
    await expect(embed(['a'])).rejects.toThrow('offline');
    expect(ensure).toHaveBeenCalledTimes(1);
    t += MODEL_FILES_RETRY_MS;
    await expect(embed(['a'])).rejects.toThrow('offline');
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(unavailable()).toBe(0);
  });
});
