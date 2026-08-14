// Watches claude's authoritative per-process status files and pushes an
// authoritative busy|idle|waiting snapshot to the renderer (#286).
//
// Claude writes `~/.claude/sessions/<pid>.json` for every session. Those files
// are host-reachable for every backend:
//   - container: `<userData>/state/<id>/.claude/sessions/` (the `.claude` bind,
//     docker.ts — the container's ~/.claude IS this host dir)
//   - local native: the host's real `~/.claude/sessions/`
//   - local WSL: `\\wsl.localhost\<distro>\<home>/.claude/sessions/` (polled,
//     like the transcript watcher — the 9P share delivers no inotify events)
// so a single host-side watcher covers everything with no broker-protocol change.
//
// Whole-file JSON (not offset-tailed like the transcript watcher): on every
// add/change we re-read the file and reparse. The reduced snapshot keys on the
// claude session id (`reducePeerStatuses` picks the newest pid file per session),
// so it joins against the broker→claude mapping identically for both backends.
//
// The stateful snapshot logic (`ingest`/`drop`) is separated from chokidar so it
// is unit-tested without fs timing; the parser and reducer are pure and tested
// on their own.

import { EventEmitter } from 'node:events';
import { mkdirSync, promises as fsp } from 'node:fs';
import { extname, sep as pathSep } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { parsePeerStatus, type PeerStatus } from './peerStatus.js';
import { reducePeerStatuses } from './peerStatusReconcile.js';

export interface PeerStatusWatcher {
  on(event: 'change', listener: (snapshot: PeerStatus[]) => void): this;
  off(event: 'change', listener: (snapshot: PeerStatus[]) => void): this;
  emit(event: 'change', snapshot: PeerStatus[]): boolean;
}

/** Stable key of a reduced snapshot so we only emit on a genuine change. */
function snapshotKey(reduced: Map<string, PeerStatus>): string {
  return [...reduced.values()]
    .map((s) => `${s.sessionId}:${s.status}:${s.waitingFor ?? ''}`)
    .sort()
    .join('|');
}

export class PeerStatusWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private pollWatcher: FSWatcher | null = null;
  private pollWatcherPromise: Promise<FSWatcher | null> | null = null;
  private readonly watchedDirs = new Set<string>();
  private readonly polledDirs = new Set<string>();
  // path → last successfully-parsed status. A parse failure (mid-write) leaves
  // the prior entry intact rather than churning to nothing.
  private readonly byPath = new Map<string, PeerStatus>();
  private lastKey = '';

  async start(): Promise<void> {
    if (this.watcher) return;
    const chokidar = await import('chokidar');
    // depth 0: <pid>.json sit directly in sessions/.
    this.watcher = chokidar.watch([], { depth: 0, ignoreInitial: false, persistent: true });
    this.wireHandlers(this.watcher);
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
    const poller = await this.pollWatcherPromise;
    await poller?.close();
    this.pollWatcher = null;
    this.pollWatcherPromise = null;
    this.polledDirs.clear();
    this.watchedDirs.clear();
    this.byPath.clear();
    this.lastKey = '';
  }

  /** Watch a host-visible sessions dir via inotify. No-op until start(). */
  registerDir(dir: string): void {
    if (!this.watcher) return;
    if (this.watchedDirs.has(dir)) return;
    this.watchedDirs.add(dir);
    try { mkdirSync(dir, { recursive: true }); } catch { /* add() surfaces fs errors via 'error' */ }
    this.watcher.add(dir);
  }

  /** Watch a dir that needs POLLING (no inotify — a \\wsl.localhost share). */
  registerPolledDir(dir: string): void {
    if (!this.watcher) return;
    if (this.watchedDirs.has(dir)) return;
    this.watchedDirs.add(dir);
    this.polledDirs.add(dir);
    try { mkdirSync(dir, { recursive: true }); } catch { /* see registerDir */ }
    void this.ensurePollWatcher().then((w) => {
      if (w && this.polledDirs.has(dir)) w.add(dir);
    });
  }

  unregisterDir(dir: string): void {
    if (!this.watcher) return;
    if (!this.watchedDirs.delete(dir)) return;
    if (this.polledDirs.delete(dir)) {
      void this.pollWatcherPromise?.then((w) => w?.unwatch(dir));
    } else {
      this.watcher.unwatch(dir);
    }
    const prefix = dir + pathSep;
    let changed = false;
    for (const path of [...this.byPath.keys()]) {
      if (path === dir || path.startsWith(prefix)) {
        this.byPath.delete(path);
        changed = true;
      }
    }
    if (changed) this.emitIfChanged();
  }

  private ensurePollWatcher(): Promise<FSWatcher | null> {
    if (!this.pollWatcherPromise) {
      this.pollWatcherPromise = import('chokidar').then((chokidar) => {
        if (!this.watcher) return null;
        this.pollWatcher = chokidar.watch([], {
          depth: 0,
          ignoreInitial: false,
          persistent: true,
          usePolling: true,
          interval: 1500,
          binaryInterval: 3000,
        });
        this.wireHandlers(this.pollWatcher);
        return this.pollWatcher;
      });
    }
    return this.pollWatcherPromise;
  }

  private wireHandlers(w: FSWatcher): void {
    const onTouch = (p: string): void => { void this.onTouch(p); };
    w.on('add', onTouch)
      .on('change', onTouch)
      .on('unlink', (p) => { if (this.drop(p)) this.emitIfChanged(); })
      .on('error', (err) => console.error('[peerStatusWatcher] error:', err));
  }

  private async onTouch(path: string): Promise<void> {
    if (extname(path) !== '.json') return;
    let raw: string;
    try {
      raw = await fsp.readFile(path, 'utf8');
    } catch {
      return; // vanished between event and read — the unlink handler covers it
    }
    if (this.ingest(path, raw)) this.emitIfChanged();
  }

  // ── stateful core (unit-tested without chokidar) ──────────────────────────

  /** Parse `raw` for `path`; update state. Returns whether byPath changed. */
  ingest(path: string, raw: string): boolean {
    const parsed = parsePeerStatus(raw);
    if (!parsed) return false; // partial/foreign file — keep any prior entry
    const prev = this.byPath.get(path);
    if (prev && prev.sessionId === parsed.sessionId && prev.status === parsed.status &&
        prev.waitingFor === parsed.waitingFor) {
      return false;
    }
    this.byPath.set(path, parsed);
    return true;
  }

  /** Forget `path` (file removed). Returns whether byPath changed. */
  drop(path: string): boolean {
    return this.byPath.delete(path);
  }

  /** Authoritative per-session snapshot (newest pid file per session). */
  snapshot(): PeerStatus[] {
    return [...reducePeerStatuses(this.byPath.values()).values()];
  }

  /** Emit 'change' only when the reduced snapshot differs from the last emit. */
  emitIfChanged(): void {
    const reduced = reducePeerStatuses(this.byPath.values());
    const key = snapshotKey(reduced);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.emit('change', [...reduced.values()]);
  }
}
