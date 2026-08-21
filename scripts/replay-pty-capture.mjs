#!/usr/bin/env node
// Replay a PTY capture (see src/main/ptyCapture.ts) into a headless xterm and
// report terminal corruption.
//
// Usage:
//   node scripts/replay-pty-capture.mjs <capture.jsonl> [--dump N] [--all]
//
// Why: #268's rendering corruption survived four root-cause theories because
// every investigation reasoned from screenshots. This replays the exact bytes
// the renderer received, at the exact geometry, through the app's real
// terminal options — so corruption reproduces deterministically and offline,
// on any platform, and a capture becomes a regression fixture.
//
// The app's Terminal options are transpiled from the real source rather than
// copied: a replay against a divergent options object would prove nothing
// (the same reason #331 extracted terminalOptions.ts in the first place).

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/replay-pty-capture.mjs <capture.jsonl> [--dump N] [--all]');
  process.exit(2);
}
const dumpN = Number((args.find((a) => a.startsWith('--dump=')) ?? '--dump=6').split('=')[1]);
const showAll = args.includes('--all');

/** Load the app's real buildTerminalOptions() by transpiling the TS source. */
async function loadRealOptions() {
  const src = readFileSync('src/renderer/src/components/terminalOptions.ts', 'utf8');
  const js = transformSync(src, { loader: 'ts', format: 'esm' }).code;
  const dir = mkdtempSync(join(tmpdir(), 'fleet-replay-'));
  const out = join(dir, 'terminalOptions.mjs');
  writeFileSync(out, js);
  return (await import(pathToFileURL(out).href)).buildTerminalOptions;
}

// @xterm/* ship a browser bundle whose export shape differs between bundlers
// and plain node ESM (named vs. default-wrapped). Accept either.
const pick = (mod, name) => mod[name] ?? mod.default?.[name] ?? mod.default;
const Terminal = pick(await import('@xterm/xterm'), 'Terminal');
const Unicode11Addon = pick(await import('@xterm/addon-unicode11'), 'Unicode11Addon');
const buildTerminalOptions = await loadRealOptions();

const events = readFileSync(resolve(file), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      console.warn(`! skipping unparsable line ${i + 1}`);
      return null;
    }
  })
  .filter(Boolean);

const open = events.find((e) => e.k === 'open');
if (!open) {
  console.error('capture has no "open" event — not a PTY capture file?');
  process.exit(2);
}

const term = new Terminal({ ...buildTerminalOptions(), cols: open.cols, rows: open.rows });
// Match the app: it activates the Unicode 11 width tables (TerminalSession).
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11';

const write = (d) => new Promise((r) => term.write(d, r));

let dataChunks = 0;
let dataBytes = 0;
const geometry = [`${open.cols}x${open.rows} @0ms (spawn)`];

for (const e of events) {
  if (e.k === 'data') {
    const buf = Buffer.from(e.b64, 'base64');
    dataChunks++;
    dataBytes += buf.length;
    // Feed raw bytes, not a decoded string: xterm does its own UTF-8 decoding
    // and this keeps multi-byte sequences split across chunks faithful.
    await write(new Uint8Array(buf));
  } else if (e.k === 'resize') {
    geometry.push(`${e.cols}x${e.rows} @${e.t}ms`);
    term.resize(e.cols, e.rows);
  } else if (e.k === 'capped') {
    console.warn(`! capture hit its size cap at ${e.bytes} bytes — replay is truncated`);
  }
}

// ---- analysis -------------------------------------------------------------

const buf = term.buffer.active;
const rows = [];
for (let i = 0; i < buf.length; i++) {
  const line = buf.getLine(i);
  rows.push({ i, text: line ? line.translateToString(true) : '', wrapped: line ? line.isWrapped : false });
}

const width = term.cols;
// The overflow-tail signature: a full-width row followed by a very short one.
// If claude laid a row out for a terminal `delta` columns wider than xterm,
// the last `delta` characters wrap onto the next line and nothing repairs it.
const suspects = [];
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1].text;
  const cur = rows[i].text;
  if (!cur.trim()) continue;
  const prevFull = prev.length >= width - 1;
  const curShort = cur.trim().length > 0 && cur.trim().length <= 4;
  if (prevFull && curShort) suspects.push({ row: i, delta: cur.trim().length, frag: cur.trim(), prevTail: prev.slice(-12) });
}

const nonEmpty = rows.filter((r) => r.text.trim());
console.log('='.repeat(72));
console.log(`capture      : ${file}`);
console.log(`workspace    : ${open.workspaceId ?? '(none)'}   session: ${open.brokerSessionId ?? '?'}`);
console.log(`data         : ${dataChunks} chunks, ${dataBytes} bytes`);
console.log(`geometry     : ${geometry.join('  ->  ')}`);
console.log(`final size   : ${term.cols}x${term.rows}`);
console.log(`buffer       : ${rows.length} lines (${nonEmpty.length} non-empty)`);
console.log('='.repeat(72));

if (!suspects.length) {
  console.log('\nNo overflow-tail signature found.');
  console.log('(A full-width row followed by a <=4 char orphan is the #268 shape.)');
} else {
  const byDelta = {};
  for (const s of suspects) byDelta[s.delta] = (byDelta[s.delta] ?? 0) + 1;
  console.log(`\n!! ${suspects.length} suspected overflow fragment(s)`);
  console.log(`   fragment lengths: ${Object.entries(byDelta).map(([d, n]) => `${d} col -> ${n}x`).join(', ')}`);
  console.log('   (fragment length == how many columns claude was ahead of xterm)\n');
  for (const s of suspects.slice(0, dumpN)) {
    console.log(`   line ${s.row}: prev ends …${JSON.stringify(s.prevTail)}  orphan ${JSON.stringify(s.frag)}`);
  }
}

if (showAll) {
  console.log('\n--- full buffer ---');
  for (const r of rows) if (r.text.trim()) console.log(String(r.i).padStart(5), r.wrapped ? 'W' : ' ', JSON.stringify(r.text));
}
