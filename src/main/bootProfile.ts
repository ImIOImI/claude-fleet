// Boot CPU profile (#464): the V8 sampling profiler over main's first
// BOOT_PROFILE_MS. The sampler runs on its own thread, so it still sees what
// main executes while the event loop is blocked. The full .cpuprofile goes to
// <userData>/perf/; a compact summary becomes one `boot_profile` perf row.

import { Session } from 'node:inspector';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const BOOT_PROFILE_MS = 30_000;
const SAMPLING_INTERVAL_US = 1000;
const BLOCK_MIN_MS = 500;
/** A non-JS gap this short inside a block is sampler jitter, not a yield. */
const BLOCK_GAP_MS = 20;
const MAX_BLOCKS = 8;
const TOP_N = 8;
const KEEP_FILES = 3;

interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number; scriptId: string }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
export interface CpuProfile { nodes: ProfileNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] }

type Top = Array<[string, number]>;
export interface BootBlock { startMs: number; durMs: number; gcMs: number; self: Top; attr: Top; stack: string[] }
export interface BootProfileSummary {
  windowMs: number;
  sampleCount: number;
  /** Per wall second: JS / GC busy ms and the heaviest attributed frames. */
  seconds: Array<{ t: number; js: number; gc: number; top: Top }>;
  /** Contiguous JS/GC-busy runs ≥ blockMinMs, heaviest first. */
  blocks: BootBlock[];
}

export function frameLabel(f: CallFrame): string {
  const name = f.functionName || '(anonymous)';
  if (!f.url) return name;
  const nm = f.url.lastIndexOf('node_modules/');
  const file = nm >= 0 ? f.url.slice(nm + 'node_modules/'.length) : f.url.replace(/^node:/, '').split(/[\\/]/).pop();
  return `${name} ${file}:${f.lineNumber + 1}`;
}

const top = (m: Map<string, number>, n = TOP_N): Top =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v)]);
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

export function analyzeProfile(
  p: CpuProfile,
  o: { blockMinMs?: number; maxBlocks?: number } = {}
): BootProfileSummary {
  const blockMinMs = o.blockMinMs ?? BLOCK_MIN_MS;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

  // Per node: busy class, self label, attributed label (deepest frame outside
  // node internals, i.e. the app/library caller of a native), and its stack.
  const info = new Map<number, { cls: 'js' | 'gc' | 'other'; self: string; attr: string | null; stack: string[] }>();
  for (const n of p.nodes) {
    const name = n.callFrame.functionName;
    const cls = name === '(garbage collector)' ? 'gc' : /^\(.*\)$/.test(name) ? 'other' : 'js';
    const stack: string[] = [];
    let attr: string | null = null;
    for (let id: number | undefined = n.id; id !== undefined; id = parent.get(id)) {
      const f = byId.get(id)!.callFrame;
      if (f.functionName === '(root)') break;
      stack.unshift(frameLabel(f));
      if (attr === null && f.url && !f.url.startsWith('node:')) attr = frameLabel(f);
    }
    info.set(n.id, { cls, self: frameLabel(n.callFrame), attr, stack });
  }

  const seconds = new Map<number, { js: number; gc: number; top: Map<string, number> }>();
  const blocks: Array<{ start: number; end: number; gc: number; self: Map<string, number>; attr: Map<string, number>; stackOf: Map<string, string[]> }> = [];
  let cur: (typeof blocks)[number] | null = null;
  let t = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const w = (p.timeDeltas[i] ?? 0) / 1000;
    t += w;
    const start = t - w;
    const s = info.get(p.samples[i]);
    if (!s) continue;
    const sec = Math.floor(start / 1000);
    const bucket = seconds.get(sec) ?? { js: 0, gc: 0, top: new Map() };
    seconds.set(sec, bucket);
    if (s.cls === 'other') {
      if (cur && start - cur.end > BLOCK_GAP_MS) cur = null;
      continue;
    }
    if (s.cls === 'gc') bucket.gc += w;
    else {
      bucket.js += w;
      if (s.attr) add(bucket.top, s.attr, w);
    }
    if (!cur || start - cur.end > BLOCK_GAP_MS) {
      cur = { start, end: start, gc: 0, self: new Map(), attr: new Map(), stackOf: new Map() };
      blocks.push(cur);
    }
    cur.end = t;
    if (s.cls === 'gc') cur.gc += w;
    add(cur.self, s.self, w);
    if (s.attr) {
      add(cur.attr, s.attr, w);
      if (!cur.stackOf.has(s.attr)) cur.stackOf.set(s.attr, s.stack);
    }
  }

  return {
    windowMs: Math.round(t),
    sampleCount: p.samples.length,
    seconds: [...seconds.entries()]
      .filter(([, b]) => b.js + b.gc > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([sec, b]) => ({ t: sec, js: Math.round(b.js), gc: Math.round(b.gc), top: top(b.top, 3) })),
    blocks: blocks
      .filter((b) => b.end - b.start >= blockMinMs)
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, o.maxBlocks ?? MAX_BLOCKS)
      .map((b) => {
        const attr = top(b.attr);
        return {
          startMs: Math.round(b.start),
          durMs: Math.round(b.end - b.start),
          gcMs: Math.round(b.gc),
          self: top(b.self),
          attr,
          stack: attr.length > 0 ? b.stackOf.get(attr[0][0])!.slice(-15) : []
        };
      })
  };
}

export interface BootProfileResult extends BootProfileSummary { startedAt: number; file: string | null }

/** Profile main for `durationMs`, then write the .cpuprofile under `outDir`
 *  (newest KEEP_FILES kept) and hand back the summary. Never throws. */
export function startBootProfile(o: {
  outDir: string;
  onResult: (r: BootProfileResult) => void;
  onError: (e: unknown) => void;
  durationMs?: number;
}): void {
  const startedAt = Date.now();
  const session = new Session();
  try {
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
    session.post('Profiler.start');
  } catch (e) {
    session.disconnect();
    o.onError(e);
    return;
  }
  setTimeout(() => {
    session.post('Profiler.stop', (err, res) => {
      session.disconnect();
      if (err) return o.onError(err);
      const profile = res.profile as unknown as CpuProfile;
      let summary: BootProfileSummary;
      try {
        summary = analyzeProfile(profile);
      } catch (e) {
        return o.onError(e);
      }
      const file = join(o.outDir, `boot-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
      void writeProfile(o.outDir, file, profile)
        .then(() => file, (e: unknown) => { o.onError(e); return null; })
        .then((written) => o.onResult({ ...summary, startedAt, file: written }));
    });
  }, o.durationMs ?? BOOT_PROFILE_MS).unref();
}

async function writeProfile(dir: string, file: string, profile: CpuProfile): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(profile));
  const old = (await readdir(dir)).filter((f) => /^boot-.*\.cpuprofile$/.test(f)).sort().slice(0, -KEEP_FILES);
  await Promise.all(old.map((f) => unlink(join(dir, f)).catch(() => undefined)));
}
