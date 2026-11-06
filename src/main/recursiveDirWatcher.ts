// One recursive fs.watch per root, emitting chokidar's add/change/unlink/error
// events for files up to `depth` subdirectories down (#464). On Windows,
// chokidar's non-polling mode opens a native watch handle per file and dir —
// a synchronous syscall each, which froze main for ~19 s at launch with
// thousands of transcripts. Recursive fs.watch is one handle per root.

import { EventEmitter } from 'node:events';
import { watch, promises as fsp, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';

export class RecursiveDirWatcher extends EventEmitter {
  private readonly roots = new Map<string, FSWatcher>();

  constructor(private readonly opts: { depth: number }) {
    super();
  }

  add(root: string): this {
    if (this.roots.has(root)) return this;
    let fsw: FSWatcher;
    try {
      fsw = watch(root, { recursive: true, persistent: true }, (_ev, filename) => {
        if (filename) void this.onEvent(root, join(root, filename.toString()));
      });
    } catch (err) {
      queueMicrotask(() => this.emit('error', err));
      return this;
    }
    fsw.on('error', (err) => {
      this.unwatch(root);
      this.emit('error', err);
    });
    this.roots.set(root, fsw);
    void this.scan(root, root, this.opts.depth);
    return this;
  }

  unwatch(root: string): this {
    this.roots.get(root)?.close();
    this.roots.delete(root);
    return this;
  }

  async close(): Promise<void> {
    for (const root of [...this.roots.keys()]) this.unwatch(root);
  }

  /** Subdirectory levels between root and p's parent dir. */
  private depthOf(root: string, p: string): number {
    return relative(root, p).split(sep).length - 1;
  }

  private async onEvent(root: string, p: string): Promise<void> {
    const depth = this.depthOf(root, p);
    if (depth > this.opts.depth) return;
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      if (this.roots.has(root)) this.emit('unlink', p);
      return;
    }
    if (!this.roots.has(root)) return;
    if (st.isFile()) this.emit('change', p);
    // A dir appearing with files already inside (mkdir -p + write, a move).
    else if (st.isDirectory() && depth < this.opts.depth) await this.scan(root, p, this.opts.depth - depth - 1);
  }

  private async scan(root: string, dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!this.roots.has(root)) return;
      const p = join(dir, e.name);
      if (e.isFile()) this.emit('add', p);
      else if (e.isDirectory() && depth > 0) await this.scan(root, p, depth - 1);
    }
  }
}
