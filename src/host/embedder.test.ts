import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EmbedderUnavailable } from '../main/embedderClient.js';
import { startHostEmbedder } from './embedder.js';
import { createLogger } from './log.js';

const FAKE = fileURLToPath(new URL('../main/__fixtures__/fake-embedder.mjs', import.meta.url));

function embedDir(withModel = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'he-'));
  if (withModel) {
    mkdirSync(join(dir, 'model', 'onnx'), { recursive: true });
    writeFileSync(join(dir, 'model', 'tokenizer.json'), '{}');
    writeFileSync(join(dir, 'model', 'onnx', 'model_quantized.onnx'), '');
  }
  return dir;
}
const fakeEnv = (mode: string) => ({ FAKE_MODE: mode, FAKE_STATE: join(mkdtempSync(join(tmpdir(), 'he-s-')), 'crashed') });

describe('host embedder (D75)', () => {
  it('embeds through the sidecar with only the env it is given', async () => {
    const e = startHostEmbedder({ dir: embedDir(), log: createLogger(() => undefined), launch: { bin: process.execPath, args: [FAKE] }, env: fakeEnv('ok') });
    const [v] = await e.embed(['abc']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(384);
    expect(e.state()).toBe('ready');
    expect(e.pid()).toBeGreaterThan(0);
    e.close();
  });

  it('is no longer ready after close', async () => {
    const e = startHostEmbedder({ dir: embedDir(), log: createLogger(() => undefined), launch: { bin: process.execPath, args: [FAKE] }, env: fakeEnv('ok') });
    await e.embed(['abc']);
    e.close();
    expect(e.state()).toBe('closed');
    await expect(e.embed(['abc'])).rejects.toThrow();
  });

  it('gives the sidecar an empty environment by default (D80)', async () => {
    // Inherited, FAKE_MODE=old-protocol would make the child refuse.
    const saved = process.env.FAKE_MODE;
    process.env.FAKE_MODE = 'old-protocol';
    try {
      const e = startHostEmbedder({ dir: embedDir(), log: createLogger(() => undefined), launch: { bin: process.execPath, args: [FAKE] } });
      expect(await e.embed(['abc'])).toHaveLength(1);
      expect(e.state()).toBe('ready');
      e.close();
    } finally {
      if (saved === undefined) delete process.env.FAKE_MODE;
      else process.env.FAKE_MODE = saved;
    }
  });

  it('is missing, logs once and never spawns when a weight file is absent', async () => {
    const lines: string[] = [];
    const e = startHostEmbedder({ dir: embedDir(false), log: createLogger((l) => lines.push(l)), launch: { bin: process.execPath, args: [FAKE] }, env: fakeEnv('ok') });
    expect(e.state()).toBe('missing');
    await expect(e.embed(['a'])).rejects.toBeInstanceOf(EmbedderUnavailable);
    expect(e.pid()).toBeUndefined();
    expect(lines.filter((l) => l.includes('transcript search is off'))).toHaveLength(1);
  });

  it('requires <dir>/fleet-embedder when no launch override is given', () => {
    const e = startHostEmbedder({ dir: embedDir(), log: createLogger(() => undefined) });
    expect(e.state()).toBe('missing');
  });

  it('turns failed after the crash loop, with no fallback', async () => {
    const e = startHostEmbedder({ dir: embedDir(), log: createLogger(() => undefined), launch: { bin: process.execPath, args: [FAKE] }, env: fakeEnv('old-protocol') });
    await expect(e.embed(['a'])).rejects.toBeInstanceOf(EmbedderUnavailable);
    expect(e.state()).toBe('failed');
  });
});
