// Regenerates embedder/reference/bge-small-q8.json, the parity oracle for the
// sidecar (src/main/embedderParity.test.ts, fleet-host embed-check): each corpus
// text embedded alone by transformers.js on the pinned model files.
// transformers.js is not an app dependency; this installs it into a temp dir.
//
//   node embedder/scripts/write-reference.mjs [hf-cache-dir]
//
// Run after a model or revision bump, with EMBED_HF_REVISION and
// EMBED_MODEL_SHA256 (src/main/vectors.ts) and docker/host/embed-weights.sha256
// already updated.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRANSFORMERS = '@huggingface/transformers@3.8.1';
const MODEL = 'Xenova/bge-small-en-v1.5';
const DIM = 384;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const vectorsTs = readFileSync(join(root, 'src/main/vectors.ts'), 'utf8');
const revision = /EMBED_HF_REVISION = '([0-9a-f]{40})'/.exec(vectorsTs)?.[1];
if (!revision) throw new Error('EMBED_HF_REVISION not found in src/main/vectors.ts');
const manifest = readFileSync(join(root, 'docker/host/embed-weights.sha256'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
const corpus = JSON.parse(readFileSync(join(root, 'src/main/__fixtures__/embed-parity-corpus.json'), 'utf8'));

const cache = resolve(process.argv[2] ?? join(tmpdir(), 'claude-fleet-reference-cache'));
const modelDir = join(cache, ...MODEL.split('/'));
// transformers.js also reads config.json and tokenizer_config.json; only the two pinned files feed the sidecar.
for (const f of ['config.json', 'tokenizer_config.json', ...manifest.map(([, f]) => f)]) {
  const dest = join(modelDir, ...f.split('/'));
  if (existsSync(dest)) continue;
  const res = await fetch(`https://huggingface.co/${MODEL}/resolve/${revision}/${f}`, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download ${f}: HTTP ${res.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
for (const [sha, f] of manifest) {
  const got = createHash('sha256').update(readFileSync(join(modelDir, ...f.split('/')))).digest('hex');
  if (got !== sha) throw new Error(`${f}: sha256 ${got}, manifest ${sha}`);
}

const pkgDir = mkdtempSync(join(tmpdir(), 'fleet-transformers-'));
const buf = Buffer.alloc(corpus.length * DIM * 4);
try {
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', pkgDir, TRANSFORMERS], { stdio: 'inherit', shell: process.platform === 'win32' });
  const { pipeline, env } = createRequire(join(pkgDir, 'package.json'))('@huggingface/transformers');
  env.cacheDir = cache;
  env.allowRemoteModels = false;
  const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  // One text per call, unpadded, like the sidecar: q8 activations are quantized per tensor.
  for (let i = 0; i < corpus.length; i++) {
    const [row] = (await extractor([corpus[i]], { pooling: 'mean', normalize: true })).tolist();
    for (let k = 0; k < DIM; k++) buf.writeFloatLE(row[k] ?? 0, (i * DIM + k) * 4);
  }
} finally {
  rmSync(pkgDir, { recursive: true, force: true });
}
const out = { model: MODEL, dtype: 'q8', revision, dim: DIM, texts: corpus, vectors: buf.toString('base64') };
writeFileSync(join(root, 'embedder/reference/bge-small-q8.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`wrote embedder/reference/bge-small-q8.json (${corpus.length} texts, revision ${revision})`);
