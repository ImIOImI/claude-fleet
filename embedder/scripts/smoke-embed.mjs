// Real-embed smoke for a built fleet-embedder: loads the model and embeds two
// texts. Usage: node smoke-embed.mjs <binary> <hf-cache-dir>
// Fetches the two model files (pinned revision, sha256-checked) into the cache if absent.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [bin, cache] = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const revision = /EMBED_HF_REVISION = '([0-9a-f]{40})'/.exec(readFileSync(join(root, 'src/main/vectors.ts'), 'utf8'))?.[1];
if (!revision) throw new Error('EMBED_HF_REVISION not found in src/main/vectors.ts');
const manifest = readFileSync(join(root, 'docker/host/embed-weights.sha256'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
const dir = join(cache, 'Xenova', 'bge-small-en-v1.5');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
for (const [want, f] of manifest) {
  const dest = join(dir, ...f.split('/'));
  // A cached file from before the pin may not match: refetch it.
  if (existsSync(dest) && sha(dest) === want) continue;
  rmSync(dest, { force: true });
  const res = await fetch(`https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${revision}/${f}`, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download ${f}: HTTP ${res.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  const got = sha(dest);
  if (got !== want) { rmSync(dest, { force: true }); throw new Error(`${f}: sha256 ${got}, expected ${want}`); }
}

const frame = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
const child = spawn(bin, ['--model-dir', dir], { stdio: ['pipe', 'pipe', 'inherit'] });
const timer = setTimeout(() => { console.error('smoke-embed: timed out'); child.kill(); process.exit(1); }, 120_000);
const texts = ['how do I fix the broker PTY reconnect bug', 'a recipe for banana bread'];
let buf = Buffer.alloc(0);
child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const m = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)));
    buf = buf.subarray(4 + buf.readUInt32LE(0));
    if (m.type === 'fatal') { console.error('smoke-embed: fatal', m.error); process.exit(1); }
    if (m.type === 'ready') {
      if (m.protocol !== 1 || m.dim !== 384) { console.error('smoke-embed: bad ready', m); process.exit(1); }
      child.stdin.write(frame({ id: 1, texts }));
      continue;
    }
    if (m.error || m.n !== 2 || m.dim !== 384) { console.error('smoke-embed: bad reply', m); process.exit(1); }
    const raw = Buffer.from(m.vectors, 'base64');
    const v = [0, 1].map((i) => Array.from({ length: 384 }, (_, k) => raw.readFloatLE((i * 384 + k) * 4)));
    const dot = (a, b) => a.reduce((s, x, k) => s + x * b[k], 0);
    const norms = v.map((x) => Math.sqrt(dot(x, x)));
    const cos = dot(v[0], v[1]);
    console.log(`smoke-embed: norms ${norms.map((n) => n.toFixed(4)).join(', ')}, cross cosine ${cos.toFixed(4)}`);
    if (norms.some((n) => Math.abs(n - 1) > 1e-4) || cos > 0.9) process.exit(1);
    clearTimeout(timer);
    child.stdin.end();
  }
});
child.on('exit', (code) => { if (code !== 0) { console.error(`smoke-embed: exit ${code}`); process.exit(1); } });
