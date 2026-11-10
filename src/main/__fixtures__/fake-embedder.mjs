// Protocol-speaking stand-in for fleet-embedder (embedderClient.test.ts).
// FAKE_MODE: ok | crash-on-first | fatal | never-ready | hang | error-reply |
// short-reply | stderr-split | old-protocol | ignore-eof | ignore-term.
// FAKE_PID_FILE: if set, the child writes its pid there.
// FAKE_STATE: a file whose existence marks "already crashed once".
import { existsSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_MODE ?? 'ok';
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
const ignoreEof = mode === 'ignore-eof' || mode === 'ignore-term';
const DIM = 384;
const frame = (o) => {
  const b = Buffer.from(JSON.stringify(o));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length);
  return Buffer.concat([h, b]);
};

if (mode === 'fatal') {
  process.stdout.write(frame({ type: 'fatal', error: 'model missing' }), () => process.exit(1));
} else if (mode !== 'never-ready') {
  if (mode === 'stderr-split') {
    process.stderr.write('first hal');
    setTimeout(() => process.stderr.write('f\nsecond\n'), 50);
  }
  process.stdout.write(frame({ type: 'ready', protocol: mode === 'old-protocol' ? 0 : 1, model: 'fake', dim: DIM }));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const n = buf.readUInt32LE(0);
    const req = JSON.parse(buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
    if (mode === 'hang') continue;
    if (mode === 'crash-on-first' && !existsSync(process.env.FAKE_STATE)) {
      writeFileSync(process.env.FAKE_STATE, '1');
      process.exit(3);
    }
    if (mode === 'error-reply') { process.stdout.write(frame({ id: req.id, error: 'boom' })); continue; }
    if (mode === 'short-reply') req.texts = req.texts.slice(1);
    const out = Buffer.alloc(req.texts.length * DIM * 4);
    req.texts.forEach((t, i) => out.writeFloatLE(1, (i * DIM + (t.length % DIM)) * 4));
    process.stdout.write(frame({ id: req.id, n: req.texts.length, dim: DIM, vectors: out.toString('base64') }));
  }
});
process.stdin.on('end', () => { if (!ignoreEof) process.exit(0); });
if (ignoreEof) setInterval(() => {}, 1000);
