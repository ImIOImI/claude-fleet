// Real-embed smoke for a built fleet-embedder: loads the model and embeds two
// texts. Usage: node smoke-embed.mjs <binary> <hf-cache-dir>
// Fetches the two model files into the cache (transformers.js layout) if absent.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [bin, cache] = process.argv.slice(2);
const dir = join(cache, 'Xenova', 'bge-small-en-v1.5');
for (const f of ['tokenizer.json', 'onnx/model_quantized.onnx']) {
  const dest = join(dir, ...f.split('/'));
  if (existsSync(dest)) continue;
  const res = await fetch(`https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/${f}`, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download ${f}: HTTP ${res.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
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
