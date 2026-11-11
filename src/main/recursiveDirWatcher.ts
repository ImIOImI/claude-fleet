// One recursive fs.watch per root, emitting chokidar's add/change/unlink/error
// events for files up to `depth` subdirectories down (#464). On Windows,
// chokidar's non-polling mode opens a native watch handle per file and dir —
// a synchronous syscall each, which froze main for ~30 s at launch with
// thousands of transcripts and session pid files. Recursive fs.watch is one
// handle per root.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync, watch, promises as fsp, type FSWatcher } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { perfRecordSpan } from './perf.js';

const RETRY_MS = 5000;

/** The add/change/unlink/error surface shared by chokidar and RecursiveDirWatcher. */
export interface DirWatcher {
  add(path: string): unknown;
  unwatch(path: string): unknown;
  close(): Promise<void>;
  on(event: 'add' | 'change' | 'unlink', listener: (path: string) => void): this;
  on(event: 'error', listener: (err: unknown) => void): this;
}

/** win32/darwin: recursive fs.watch is one native handle per dir. Linux keeps
 *  chokidar, whose per-file inotify watches are cheap. */
export const NATIVE_RECURSIVE_DEFAULT = process.platform === 'win32' || process.platform === 'darwin';

/** Why a directory was listed: first watch (or a retry), the OS change buffer
 *  overflowed (no filename), an event path didn't resolve, or a dir appeared. */
export type ScanReason = 'initial' | 'overflow' | 'unresolvable' | 'new-dir';
/** `coalesced`: full-root rescan requests merged into this run (1 = none merged). */
export interface ScanReport { root: string; reason: ScanReason; files: number; dirs: number; coalesced: number; startMs: number; endMs: number }

/** onScan that records each listing as a `claude_fleet.watcher.scan` span.
 *  root_id is a short hash, not the path, so it lands app-global (no workspace_id). */
export function recordScanSpans(watcher: 'jsonl' | 'peer'): (s: ScanReport) => void {
  return (s) => perfRecordSpan('claude_fleet.watcher.scan', s.startMs, s.endMs, {
    watcher, reason: s.reason, files: s.files, dirs: s.dirs, coalesced: s.coalesced,
    root_id: createHash('sha1').update(s.root).digest('hex').slice(0, 8),
  });
}

type WatchFn = (root: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;
const nativeWatch: WatchFn = (root, listener) => watch(root, { recursive: true, persistent: true }, listener);

export class RecursiveDirWatcher extends EventEmitter {
  private readonly roots = new Map<string, FSWatcher>();
  /** Roots added and not unwatched; a failed one is retried until it watches. */
  private readonly wanted = new Set<string>();
  /** Directories already listed, per root. Windows also reports a directory
   *  when a file inside it changes; only an unknown directory needs a listing. */
  private readonly knownDirs = new Map<string, Set<string>>();
  /** Per root, an in-flight full rescan; requests arriving meanwhile become one follow-up. */
  private readonly fullRescans = new Map<string, { pending: number; reason: ScanReason }>();

  constructor(private readonly opts: {
    depth: number; retryMs?: number; watchFn?: WatchFn; onScan?: (s: ScanReport) => void;
    /** Files to report; others are never emitted or counted. Directories always pass. */
    filter?: (path: string) => boolean;
  }) {
    super();
  }

  add(root: string): this {
    this.wanted.add(root);
    if (this.roots.has(root)) return this;
    let fsw: FSWatcher;
    try {
      // Electron on Windows derives event filenames by stripping the watched
      // path's length from the long-name event path: an 8.3 short name in
      // root (RUNNER~1) yields garbage like `ce\a.jsonl`. Watch the long form.
      fsw = (this.opts.watchFn ?? nativeWatch)(realpathSync.native(root), (_ev, filename) => {
        // No filename: the OS change buffer overflowed (Windows), so any file may have changed.
        if (filename) void this.onEvent(root, join(root, filename.toString()));
        else this.requestFullRescan(root, 'overflow');
      });
    } catch (err) {
      queueMicrotask(() => this.emit('error', err));
      this.retry(root);
      return this;
    }
    fsw.on('error', (err) => {
      fsw.close();
      this.roots.delete(root);
      this.emit('error', err);
      this.retry(root);
    });
    this.roots.set(root, fsw);
    this.knownDirs.set(root, new Set());
    void this.runScan(root, root, this.opts.depth, 'add', 'initial');
    return this;
  }

  unwatch(root: string): this {
    this.wanted.delete(root);
    this.roots.get(root)?.close();
    this.roots.delete(root);
    this.knownDirs.delete(root);
    return this;
  }

  async close(): Promise<void> {
    for (const root of [...this.wanted]) this.unwatch(root);
  }

  private retry(root: string): void {
    setTimeout(() => {
      if (this.wanted.has(root) && !this.roots.has(root)) this.add(root);
    }, this.opts.retryMs ?? RETRY_MS).unref();
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
      if (!this.roots.has(root)) return;
      this.forgetDirs(root, p);
      // A missing parent means the event filename is not a real path: rescan.
      const parentExists = await fsp.stat(dirname(p)).then(() => true, () => false);
      if (parentExists) {
        if (this.wants(p)) this.emit('unlink', p);
      } else this.requestFullRescan(root, 'unresolvable');
      return;
    }
    if (!this.roots.has(root)) return;
    if (st.isFile()) {
      if (this.wants(p)) this.emit('change', p);
    } else if (st.isDirectory() && depth < this.opts.depth && !this.knownDirs.get(root)?.has(p)) {
      // A dir appearing with files already inside (mkdir -p + write, a move).
      await this.runScan(root, p, this.opts.depth - depth - 1, 'add', 'new-dir');
    }
  }

  private wants(p: string): boolean {
    return this.opts.filter ? this.opts.filter(p) : true;
  }

  /** Drop p and everything under it from the known set, so a re-created dir is listed again. */
  private forgetDirs(root: string, p: string): void {
    const known = this.knownDirs.get(root);
    if (!known) return;
    const prefix = p + sep;
    for (const d of known) if (d === p || d.startsWith(prefix)) known.delete(d);
  }

  private requestFullRescan(root: string, reason: ScanReason): void {
    const inFlight = this.fullRescans.get(root);
    if (inFlight) {
      inFlight.pending++;
      inFlight.reason = reason;
      return;
    }
    const st = { pending: 0, reason };
    this.fullRescans.set(root, st);
    void (async () => {
      let coalesced = 1;
      try {
        for (;;) {
          await this.runScan(root, root, this.opts.depth, 'change', st.reason, coalesced);
          if (st.pending === 0 || !this.roots.has(root)) return;
          coalesced = st.pending;
          st.pending = 0;
        }
      } finally {
        this.fullRescans.delete(root);
      }
    })();
  }

  private async runScan(root: string, dir: string, depth: number, ev: 'add' | 'change', reason: ScanReason, coalesced = 1): Promise<void> {
    const count = { files: 0, dirs: 0 };
    const startMs = Date.now();
    await this.scan(root, dir, depth, ev, count);
    this.opts.onScan?.({ root, reason, ...count, coalesced, startMs, endMs: Date.now() });
  }

  private async scan(root: string, dir: string, depth: number, ev: 'add' | 'change', count: { files: number; dirs: number }): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    count.dirs++;
    this.knownDirs.get(root)?.add(dir);
    for (const e of entries) {
      if (!this.roots.has(root)) return;
      const p = join(dir, e.name);
      if (e.isFile()) {
        if (!this.wants(p)) continue;
        count.files++;
        this.emit(ev, p);
      } else if (e.isDirectory() && depth > 0) await this.scan(root, p, depth - 1, ev, count);
    }
  }
}
