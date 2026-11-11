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
/** `coalesced`: full-root rescan requests served by this run (1 = none merged);
 *  `overflowRequests` / `unresolvableRequests` split them by cause. */
export interface ScanReport {
  root: string; reason: ScanReason; files: number; dirs: number;
  coalesced: number; overflowRequests: number; unresolvableRequests: number; startMs: number; endMs: number;
}

/** onScan that records each listing as a `claude_fleet.watcher.scan` span.
 *  root_id is a short hash, not the path, so it lands app-global (no workspace_id). */
export function recordScanSpans(watcher: 'jsonl' | 'peer'): (s: ScanReport) => void {
  return (s) => perfRecordSpan('claude_fleet.watcher.scan', s.startMs, s.endMs, {
    watcher, reason: s.reason, files: s.files, dirs: s.dirs, coalesced: s.coalesced,
    overflow_requests: s.overflowRequests, unresolvable_requests: s.unresolvableRequests,
    root_id: createHash('sha1').update(s.root).digest('hex').slice(0, 8),
  });
}

type WatchFn = (root: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;
const nativeWatch: WatchFn = (root, listener) => watch(root, { recursive: true, persistent: true }, listener);

export class RecursiveDirWatcher extends EventEmitter {
  private readonly roots = new Map<string, FSWatcher>();
  /** Roots added and not unwatched; a failed one is retried until it watches. */
  private readonly wanted = new Set<string>();
  /** Per root, the in-flight full listing (initial or rescan); requests arriving
   *  meanwhile become one follow-up run, counted by cause. */
  private readonly fullRescans = new Map<string, { initial: boolean; overflow: number; unresolvable: number }>();

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
      fsw = (this.opts.watchFn ?? nativeWatch)(realpathSync.native(root), (ev, filename) => {
        // No filename: the OS change buffer overflowed (Windows), so any file may have changed.
        if (filename) void this.onEvent(root, join(root, filename.toString()), ev);
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
    this.requestFullRescan(root, 'initial');
    return this;
  }

  unwatch(root: string): this {
    this.wanted.delete(root);
    this.roots.get(root)?.close();
    this.roots.delete(root);
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

  /** `change` means contents modified: for a directory that's a file inside
   *  changing (which reports itself), so only `rename` (create, delete, move)
   *  can mean a new directory to list. */
  private async onEvent(root: string, p: string, ev: string): Promise<void> {
    const depth = this.depthOf(root, p);
    if (depth > this.opts.depth) return;
    if (ev === 'change' && !this.wants(p)) return;
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      if (!this.roots.has(root) || !this.wants(p)) return;
      // A missing parent means the event filename is not a real path: rescan.
      const parentExists = await fsp.stat(dirname(p)).then(() => true, () => false);
      if (parentExists) this.emit('unlink', p);
      else this.requestFullRescan(root, 'unresolvable');
      return;
    }
    if (!this.roots.has(root)) return;
    if (st.isFile()) {
      if (this.wants(p)) this.emit('change', p);
    } else if (ev !== 'change' && st.isDirectory() && depth < this.opts.depth) {
      // A dir appearing with files already inside (mkdir -p + write, a move).
      await this.runScan(root, p, this.opts.depth - depth - 1, 'add', 'new-dir');
    }
  }

  private wants(p: string): boolean {
    return this.opts.filter ? this.opts.filter(p) : true;
  }

  private requestFullRescan(root: string, reason: ScanReason): void {
    const inFlight = this.fullRescans.get(root);
    if (inFlight) {
      // A re-add (unwatch + add, or a retry) mid-listing: what the old listing
      // already emitted belonged to the old registration, so list it all again.
      if (reason === 'initial') inFlight.initial = true;
      else if (reason === 'overflow') inFlight.overflow++;
      else if (reason === 'unresolvable') inFlight.unresolvable++;
      return;
    }
    const pending = { initial: false, overflow: 0, unresolvable: 0 };
    this.fullRescans.set(root, pending);
    void (async () => {
      let run = { reason, ev: (reason === 'initial' ? 'add' : 'change') as 'add' | 'change',
        overflow: reason === 'overflow' ? 1 : 0, unresolvable: reason === 'unresolvable' ? 1 : 0 };
      try {
        for (;;) {
          await this.runScan(root, root, this.opts.depth, run.ev, run.reason,
            { overflow: run.overflow, unresolvable: run.unresolvable });
          if ((!pending.initial && pending.overflow + pending.unresolvable === 0) || !this.roots.has(root)) return;
          run = {
            reason: pending.initial ? 'initial' : pending.overflow > 0 ? 'overflow' : 'unresolvable',
            ev: pending.initial ? 'add' : 'change',
            overflow: pending.overflow, unresolvable: pending.unresolvable,
          };
          pending.initial = false;
          pending.overflow = 0;
          pending.unresolvable = 0;
        }
      } finally {
        this.fullRescans.delete(root);
      }
    })();
  }

  private async runScan(
    root: string, dir: string, depth: number, ev: 'add' | 'change', reason: ScanReason,
    requests = { overflow: 0, unresolvable: 0 },
  ): Promise<void> {
    const count = { files: 0, dirs: 0 };
    const startMs = Date.now();
    await this.scan(root, dir, depth, ev, count);
    this.opts.onScan?.({
      root, reason, ...count, coalesced: Math.max(1, requests.overflow + requests.unresolvable),
      overflowRequests: requests.overflow, unresolvableRequests: requests.unresolvable, startMs, endMs: Date.now(),
    });
  }

  private async scan(root: string, dir: string, depth: number, ev: 'add' | 'change', count: { files: number; dirs: number }): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    count.dirs++;
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
