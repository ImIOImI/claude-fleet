import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProfile, frameLabel, startBootProfile, type BootProfileResult, type CpuProfile } from './bootProfile';

const node = (id: number, functionName: string, url = '', lineNumber = 0, children: number[] = []) => ({
  id, callFrame: { functionName, url, lineNumber, columnNumber: 0, scriptId: '0' }, children
});

// root(1) ─┬ (program)(2)
//          ├ (garbage collector)(3)
//          └ registerWorkspace(4, app) ─ _handleFile(5, chokidar) ─ watch(6, node:fs)
const PROFILE_NODES = [
  node(1, '(root)', '', 0, [2, 3, 4]),
  node(2, '(program)'),
  node(3, '(garbage collector)'),
  node(4, 'registerWorkspace', 'file:///C:/app/resources/app.asar/out/main/index.js', 99, [5]),
  node(5, '_handleFile', 'file:///C:/app/resources/app.asar/node_modules/chokidar/handler.js', 392, [6]),
  node(6, 'watch', 'node:fs', 10)
];

/** 1 ms samples: `runs` is a list of [nodeId, count]. */
function profileOf(runs: Array<[number, number]>): CpuProfile {
  const samples: number[] = [];
  for (const [id, n] of runs) for (let i = 0; i < n; i++) samples.push(id);
  return { nodes: PROFILE_NODES, startTime: 0, endTime: samples.length * 1000, samples, timeDeltas: samples.map(() => 1000) };
}

describe('frameLabel', () => {
  it('keeps the node_modules package path, else the basename, 1-based line', () => {
    expect(frameLabel(PROFILE_NODES[4].callFrame)).toBe('_handleFile chokidar/handler.js:393');
    expect(frameLabel(PROFILE_NODES[3].callFrame)).toBe('registerWorkspace index.js:100');
    expect(frameLabel({ functionName: '', url: '', lineNumber: -1, columnNumber: 0, scriptId: '0' })).toBe('(anonymous)');
  });
});

describe('analyzeProfile', () => {
  it('finds a JS-busy block and attributes it to the deepest non-node-internal frame', () => {
    const s = analyzeProfile(profileOf([[2, 200], [6, 1500], [2, 300]]), { blockMinMs: 500 });
    expect(s.blocks).toHaveLength(1);
    const b = s.blocks[0];
    expect(b.startMs).toBe(200);
    expect(b.durMs).toBe(1500);
    expect(b.self[0]).toEqual(['watch fs:11', 1500]);
    expect(b.attr[0]).toEqual(['_handleFile chokidar/handler.js:393', 1500]);
    expect(b.stack).toEqual(['registerWorkspace index.js:100', '_handleFile chokidar/handler.js:393', 'watch fs:11']);
  });

  it('bridges short non-JS gaps and counts GC as busy, but splits on long gaps', () => {
    const s = analyzeProfile(profileOf([[6, 400], [2, 10], [3, 200], [2, 300], [6, 600]]), { blockMinMs: 500 });
    expect(s.blocks.map((b) => [b.startMs, b.durMs])).toEqual([[0, 610], [910, 600]]);
    expect(s.blocks[0].gcMs).toBe(200);
  });

  it('drops blocks shorter than blockMinMs', () => {
    expect(analyzeProfile(profileOf([[6, 499], [2, 100]]), { blockMinMs: 500 }).blocks).toEqual([]);
  });

  it('buckets busy time per second', () => {
    const s = analyzeProfile(profileOf([[6, 700], [2, 300], [3, 250], [2, 750]]), { blockMinMs: 500 });
    expect(s.seconds).toEqual([
      { t: 0, js: 700, gc: 0, top: [['_handleFile chokidar/handler.js:393', 700]] },
      { t: 1, js: 0, gc: 250, top: [] }
    ]);
    expect(s.windowMs).toBe(2000);
    expect(s.sampleCount).toBe(2000);
  });

  it('caps blocks to the heaviest maxBlocks', () => {
    const s = analyzeProfile(profileOf([[6, 600], [2, 100], [6, 900], [2, 100], [6, 700]]), { blockMinMs: 500, maxBlocks: 2 });
    expect(s.blocks.map((b) => b.durMs)).toEqual([900, 700]);
  });
});

describe('startBootProfile (real inspector)', () => {
  function spinFor(ms: number): number {
    const end = Date.now() + ms;
    let x = 0;
    while (Date.now() < end) x += Math.sqrt(x + 1);
    return x;
  }

  it('attributes a sync block to the function that blocked, writes the file and prunes old ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bootprof-'));
    try {
      for (const n of ['boot-2020-01-01.cpuprofile', 'boot-2020-01-02.cpuprofile', 'boot-2020-01-03.cpuprofile']) writeFileSync(join(dir, n), '{}');
      const result = new Promise<BootProfileResult>((resolve, reject) =>
        startBootProfile({ outDir: dir, durationMs: 1200, onResult: resolve, onError: reject }));
      setTimeout(() => spinFor(700), 100);
      const r = await result;
      expect(r.file).not.toBeNull();
      const files = readdirSync(dir).sort();
      expect(files).toHaveLength(3);
      expect(files).not.toContain('boot-2020-01-01.cpuprofile');
      expect(files).toContain(r.file!.split(/[\\/]/).pop());
      const block = r.blocks[0];
      expect(block.durMs).toBeGreaterThanOrEqual(500);
      expect(block.stack.some((f) => f.startsWith('spinFor '))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
