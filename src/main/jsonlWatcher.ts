// Tails Claude transcript JSONLs and ingests new lines into the SQLite cache.
//
// Each workspace's claude binary writes its transcript to:
//   <userData>/state/<name>/.claude/projects/-workspace/<session-uuid>.jsonl
// Local-backend workspaces instead write under the host's real
//   ~/.claude/projects/<encoded-root>/  (registered via registerLocalWorkspace).
//
// We watch at depth 2 so subagent JSONLs nested under
// <session-uuid>/subagents/agent-*.jsonl are also ingested — their token spend
// rolls up to the parent session (see parseSubagentPath). For every change we
// read from the file's last-known byte offset to the current EOF, split on
// newlines, ingest complete lines, and stash the offset of any trailing
// partial line for the next change event.
//
// Re-ingestion is idempotent: db.ingestBatch uses uuid (or a content hash for
// light events) as a dedup key. The byte offset is an in-memory optimization
// only — if we lose it (process restart, watch dropped), re-reading from
// offset 0 produces the same end state.

import { EventEmitter } from 'node:events';
import { mkdirSync, promises as fsp, type Stats } from 'node:fs';
import { join, extname, sep as pathSep } from 'node:path';
// chokidar v5 is ESM-only. Our main bundle is CommonJS (per
// electron.vite.config.ts), so `require('chokidar')` would throw
// ERR_REQUIRE_ESM. Load it via dynamic import inside `start()`.
import type { FSWatcher } from 'chokidar';
import { RecursiveDirWatcher } from './recursiveDirWatcher.js';
import { workspaceClaudeDir, workspaceHistoryDir, workspaceHistoryFile, hostLocalProjectsDir } from './paths.js';
import { ingestBatch } from './db.js';
import { effectiveForClaudeSession } from './mirrorPolicy.js';
import { perfSpan, perfSpanAsync } from './perf.js';
import { keyedSerialQueue } from './state/serialQueue.js';
import { parseSubagentPath, parseTranscriptFilename } from './state/transcriptPaths.js';

/**
 * Fire-and-forget structured log for watcher lifecycle events (#323).
 *
 * `errorLog` imports electron, and this module is loaded directly by unit tests
 * that don't mock it — so the import is lazy and every failure is swallowed.
 * Logging about the watcher must never be able to break the watcher.
 */
function logWatcherEvent(payload: {
  type: string;
  message: string;
  level?: 'error' | 'warn' | 'info';
  workspaceId?: string;
  extra?: Record<string, unknown>;
}): void {
  void import('./errorLog.js')
    .then(({ logError }) => logError({ source: 'main', ...payload }))
    .catch(() => {
      /* no logger available (unit tests) — nothing useful to do */
    });
}

const PROJECTS_SUBDIR = join('projects', '-workspace');
// chokidar drops (not defers) a file's events within 5 ms of the last one, so
// a write in that window has no event of its own. One re-check this
// long after the last event in a burst reads it.
const SETTLE_RECHECK_MS = 100;
export { parseSubagentPath, parseTranscriptFilename };

interface FileState {
  workspaceId: string;
  sessionId: string;
  sidecar: boolean;
  offset: number;
}

/**
 * Emitted once per `process()` batch that ingested ≥1 new line. The IPC layer
 * subscribes to drive live summary push to the renderer — one emit fans out
 * to chip/pane/context-bar in one round trip, replacing the previous 2s poll.
 * Duplicate-only batches (re-read after compaction with no genuinely new
 * content) suppress the emit so consumers don't re-render for no reason.
 */
export interface IngestEvent {
  workspaceId: string;
  sessionId: string;
}

/**
 * Emitted the first time we see a given session's primary transcript — at
 * most ONCE per session id per watcher lifetime (see `announcedSessions`).
 * This is the trigger the per-tab mapping layer uses to pair a freshly-spawned
 * claude session UUID with a pending attach (see `pendingAttaches.ts` +
 * `db.learnBrokerSessionMapping`). Fires before the corresponding `'ingest'`
 * event for the same batch. Re-sighting the transcript (chokidar unlink→add,
 * unregister/re-register) does NOT re-fire it.
 */
export interface NewSessionEvent {
  workspaceId: string;
  sessionId: string;
}

// Typed event surface — TS doesn't get to constrain EventEmitter's own
// signatures, so we expose a strict facade and assert the underlying calls.
// Same approach Node's own docs suggest for typed events.
export interface JsonlWatcher {
  on(event: 'ingest', listener: (e: IngestEvent) => void): this;
  on(event: 'new-session', listener: (e: NewSessionEvent) => void): this;
  off(event: 'ingest', listener: (e: IngestEvent) => void): this;
  off(event: 'new-session', listener: (e: NewSessionEvent) => void): this;
  emit(event: 'ingest', e: IngestEvent): boolean;
  emit(event: 'new-session', e: NewSessionEvent): boolean;
}

/** The add/change/unlink/error surface shared by chokidar and RecursiveDirWatcher. */
interface DirWatcher {
  add(path: string): unknown;
  unwatch(path: string): unknown;
  close(): Promise<void>;
  on(event: 'add' | 'change' | 'unlink', listener: (path: string) => void): this;
  on(event: 'error', listener: (err: unknown) => void): this;
}

export class JsonlWatcher extends EventEmitter {
  private watcher: DirWatcher | null = null;
  // win32/darwin: one recursive fs.watch per dir. chokidar opens a native
  // handle per file there, synchronously (#464). Linux keeps chokidar (inotify).
  private readonly nativeRecursive: boolean;

  constructor(opts: { nativeRecursive?: boolean } = {}) {
    super();
    this.nativeRecursive = opts.nativeRecursive ?? (process.platform === 'win32' || process.platform === 'darwin');
  }
  // Second chokidar instance for dirs where inotify can't reach — the
  // \\wsl.localhost 9P share delivers no change events (#253). Created
  // lazily on the first polled registration; same handlers as `watcher`.
  private pollWatcher: FSWatcher | null = null;
  private pollWatcherPromise: Promise<FSWatcher | null> | null = null;
  private readonly polledDirs = new Set<string>();
  private readonly files = new Map<string, FileState>();
  private readonly watchedDirs = new Set<string>();
  // Per-file serial queue: a file's process() runs never overlap and run in
  // event order, so its lines ingest strictly in file order (ingest is async;
  // nothing else serializes it). Tails self-clean when they settle and are
  // NOT dropped on unlink/unregister — a re-added file still waits for its
  // in-flight batch — and stop() drains every queued batch.
  private readonly queue = keyedSerialQueue((path, err) => {
    console.error(`[jsonlWatcher] process failed for ${path}:`, err);
  });
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  // Sessions already announced via 'new-session'. Keyed by session id (the
  // session's stable identity), and deliberately OUTLIVES the `files` map:
  // `files` entries are dropped on chokidar unlink, unregister, and stat
  // failures, and a re-sighted transcript would then look like `!existing`
  // and re-fire 'new-session'. Under a chokidar unlink→add re-add storm that
  // re-fire becomes a runaway that floods the pending-attach layer with
  // dropped events (#243). This set caps 'new-session' to once per session
  // per watcher lifetime. Cleared only on stop().
  private readonly announcedSessions = new Set<string>();

  // Registered host transcript dirs for local-backend workspaces:
  //   ~/.claude/projects/<encoded-root>/  →  real workspace id.
  // Consulted before the '.claude'-parent path rule (which is wrong for
  // host paths). Watched at the specific subdir only, so unrelated personal
  // projects in the same ~/.claude/projects tree are never ingested.
  private readonly hostDirs = new Map<string, string>(); // dir → workspaceId

  /**
   * Register a local-backend workspace's host transcript dir
   * (~/.claude/projects/<encoded-root>/) so its files ingest under `id`.
   * Must be called AFTER start() — like registerWorkspace, this silently
   * no-ops if the watcher isn't running yet.
   */
  registerLocalWorkspace(id: string, workspaceRoot: string): void {
    this.addHostDir(id, hostLocalProjectsDir(workspaceRoot));
  }

  /** @internal test seam — register a host dir directly. */
  registerLocalDirForTest(id: string, dir: string): void {
    this.addHostDir(id, dir);
  }

  private addHostDir(id: string, dir: string): void {
    if (!this.watcher) return;
    if (this.hostDirs.has(dir)) return;
    this.hostDirs.set(dir, id);
    this.watchedDirs.add(dir);
    try { mkdirSync(dir, { recursive: true }); } catch { /* see registerWorkspace */ }
    this.watcher.add(dir);
  }

  unregisterLocalWorkspace(id: string): void {
    if (!this.watcher) return;
    for (const [dir, wsId] of [...this.hostDirs]) {
      if (wsId !== id) continue;
      this.hostDirs.delete(dir);
      this.watchedDirs.delete(dir);
      if (this.polledDirs.delete(dir)) {
        void this.pollWatcherPromise?.then((w) => w?.unwatch(dir));
      } else {
        this.watcher.unwatch(dir);
      }
      const prefix = dir + pathSep;
      for (const path of [...this.files.keys()]) {
        if (path === dir || path.startsWith(prefix)) this.files.delete(path);
      }
    }
  }

  /** Register a transcript dir that needs POLLING (no inotify — e.g. a
   *  \\wsl.localhost share for a wsl-launcher workspace, #253).
   *
   *  Logs the dir it settles on, and no longer swallows a failed mkdir (#323). */
  registerPolledLocalDir(id: string, dir: string): void {
    if (!this.watcher) return; // same started-gate as registerLocalWorkspace
    if (this.hostDirs.has(dir)) return;
    this.hostDirs.set(dir, id);
    this.watchedDirs.add(dir);
    this.polledDirs.add(dir);
    // Record WHICH directory this workspace is polled at (#323). A "shows
    // nothing in either rail" report is otherwise undiagnosable from logs
    // alone; with this line you compare it against where claude actually
    // writes, and the answer is immediate — that is how #313 was found.
    logWatcherEvent({
      type: 'watcher-polled-dir',
      level: 'info',
      message: `polling ${dir}`,
      workspaceId: id,
      extra: { dir }
    });
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      // Previously swallowed, and that silence is what let #313 run for ~6
      // days: this mkdir FAILED over the \\wsl.localhost 9P share, so the app
      // polled a path that never existed and never said so. It also means a
      // "does the watch dir exist?" health check proves nothing — we create it
      // ourselves — which makes the failure to create it the signal worth having.
      logWatcherEvent({
        type: 'watcher-dir-mkdir-failed',
        level: 'warn',
        message: `could not create the directory to poll: ${dir}`,
        workspaceId: id,
        extra: { dir, err: String(err) }
      });
    }
    void this.ensurePollWatcher().then((w) => {
      // Skip if stopped or unregistered while chokidar was loading.
      if (w && this.polledDirs.has(dir)) w.add(dir);
    });
  }

  private ensurePollWatcher(): Promise<FSWatcher | null> {
    if (!this.pollWatcherPromise) {
      // Lazy import mirrors start(); chokidar is ESM-only under our CJS bundle.
      this.pollWatcherPromise = import('chokidar').then((chokidar) => {
        if (!this.watcher) return null; // stopped while loading
        this.pollWatcher = chokidar.watch([], {
          depth: 2,
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

  private wireHandlers(w: DirWatcher): void {
    w.on('add', (p) => this.onFsEvent(p))
      .on('change', (p) => this.onFsEvent(p))
      .on('unlink', (p) => {
        this.files.delete(p);
        this.cancelSettle(p);
      })
      .on('error', (err) => console.error('[jsonlWatcher] error:', err));
  }

  async start(workspaceIds: string[]): Promise<void> {
    if (this.watcher) return;
    // depth 2 reaches <projectdir>/<session>/subagents/agent-*.jsonl (#plan-usage).
    // No awaitWriteFinish: we tolerate partial-line reads by tracking the
    // last newline byte and rolling the offset forward only past complete
    // lines. Lower latency this way.
    this.watcher = this.nativeRecursive
      ? new RecursiveDirWatcher({ depth: 2 })
      : (await import('chokidar')).watch([], { depth: 2, ignoreInitial: false, persistent: true });
    this.wireHandlers(this.watcher);
    for (const name of workspaceIds) {
      this.registerWorkspace(name);
    }
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
    for (const t of this.settleTimers.values()) clearTimeout(t);
    this.settleTimers.clear();
    // Await the creation PROMISE, not the field: a stop() racing the lazy
    // chokidar import would otherwise miss (and leak) the poller the import
    // is about to create. this.watcher is already null here, so a still-
    // in-flight ensurePollWatcher resolves to null and creates nothing.
    const poller = await this.pollWatcherPromise;
    await poller?.close();
    this.pollWatcher = null;
    this.pollWatcherPromise = null;
    // No new events can arrive now; let every queued batch finish before the
    // caller closes state.db.
    await this.queue.drain();
    this.polledDirs.clear();
    this.files.clear();
    this.watchedDirs.clear();
    this.announcedSessions.clear();
  }

  registerWorkspace(name: string): void {
    if (!this.watcher) return;
    const dir = join(workspaceClaudeDir(name), PROJECTS_SUBDIR);
    if (this.watchedDirs.has(dir)) return;
    this.watchedDirs.add(dir);
    // Pre-create the dir before adding it to chokidar's watch list.
    // Despite chokidar's docs implying that non-existent paths are
    // saved as "wanted" and watched once they appear, in practice
    // chokidar v5 silently drops paths that don't exist at `add()`
    // time — when claude later writes its first JSONL into the
    // dir-that-was-missing, no 'add' event fires and the watcher
    // never ingests anything for the workspace. Symptom: the
    // observability pane stays empty for any workspace whose claude
    // first-run happens AFTER the workspace was registered.
    // mkdirSync is recursive so it's a no-op when the dir already
    // exists, which is the common case at app startup.
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Ignore — `add()` below will surface any deeper filesystem
      // problem via the watcher's 'error' event, and the watcher
      // works fine if the dir gets created elsewhere later.
    }
    this.watcher.add(dir);
  }

  unregisterWorkspace(name: string): void {
    if (!this.watcher) return;
    const dir = join(workspaceClaudeDir(name), PROJECTS_SUBDIR);
    if (!this.watchedDirs.delete(dir)) return;
    this.watcher.unwatch(dir);
    const prefix = dir + pathSep;
    for (const path of [...this.files.keys()]) {
      if (path === dir || path.startsWith(prefix)) {
        this.files.delete(path);
      }
    }
    for (const path of [...this.settleTimers.keys()]) {
      if (path.startsWith(prefix)) this.cancelSettle(path);
    }
  }

  /** Re-read every known transcript from its offset. A batch that failed
   *  (store down) left its offset behind, and nothing else re-reads it until
   *  the file changes again. */
  requeueAll(): void {
    for (const path of this.files.keys()) this.enqueue(path);
  }

  private onFsEvent(path: string): void {
    this.enqueue(path);
    if (extname(path) !== '.jsonl') return;
    this.cancelSettle(path);
    this.settleTimers.set(path, setTimeout(() => {
      this.settleTimers.delete(path);
      this.enqueue(path);
    }, SETTLE_RECHECK_MS));
  }

  private cancelSettle(path: string): void {
    clearTimeout(this.settleTimers.get(path));
    this.settleTimers.delete(path);
  }

  private enqueue(path: string): void {
    if (extname(path) !== '.jsonl') return;
    void this.queue.enqueue(path, () => this.process(path));
  }

  private async process(path: string): Promise<void> {
    const existing = this.files.get(path);
    const state = existing ?? this.initState(path);
    if (!state) return;
    // First sighting of a primary transcript → fire 'new-session' so the
    // mapping layer can pair this claude UUID with a pending attach.
    // Sidecars (<uuid>.fleet.jsonl) are host-written summary data and must
    // NOT fire 'new-session': they arrive after the session is already known
    // and firing would corrupt the pending-attach fallback (#207).
    // Guarded by `announcedSessions` so a transcript re-sighted after its
    // `files` entry was dropped (unlink→add, unregister, stat failure) does
    // NOT re-fire — the source of the #243 new-session-dropped flood.
    // Fires before the eventual 'ingest' emit for this batch.
    if (!existing && !state.sidecar && !this.announcedSessions.has(state.sessionId)) {
      this.announcedSessions.add(state.sessionId);
      this.emit('new-session', {
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
      });
    }

    let stats: Stats;
    try {
      stats = await fsp.stat(path);
    } catch {
      this.files.delete(path);
      return;
    }
    // Compaction: file shrank below our offset — reset and re-ingest.
    // dedup_key keeps existing rows; only genuinely new lines insert.
    if (stats.size < state.offset) state.offset = 0;
    if (stats.size === state.offset) return;

    const { newOffset, insertedCount } = await readAndIngest(path, state);
    state.offset = newOffset;
    this.files.set(path, state);

    // Only emit when ≥1 line genuinely inserted (compaction re-reads return
    // duplicates whose dedup_key already exists; no consumer state change
    // happened, so don't wake them up).
    if (insertedCount > 0) {
      this.emit('ingest', {
        workspaceId: state.workspaceId,
        sessionId: state.sessionId,
      });
    }
  }

  private initState(path: string): FileState | null {
    const workspaceId = this.workspaceIdForPath(path);
    if (!workspaceId) return null;

    const sub = parseSubagentPath(path);
    if (sub) {
      // Subagent transcript — attribute to the parent session; never a
      // 'new-session' (the parent already exists) and never mirrored.
      const state: FileState = { workspaceId, sessionId: sub.parentSessionId, sidecar: true, offset: 0 };
      this.files.set(path, state);
      return state;
    }

    const parsed = parseTranscriptFilename(path);
    if (!parsed) return null;
    const state: FileState = { workspaceId, sessionId: parsed.sessionId, sidecar: parsed.sidecar, offset: 0 };
    this.files.set(path, state);
    return state;
  }

  /** Host-dir map first (local workspaces), then the '.claude'-parent rule. */
  private workspaceIdForPath(path: string): string | null {
    for (const [dir, wsId] of this.hostDirs) {
      if (path === dir || path.startsWith(dir + pathSep)) return wsId;
    }
    return workspaceIdFromPath(path);
  }
}

interface ReadResult {
  newOffset: number;
  insertedCount: number;
}

/**
 * Read from `state.offset` to EOF, ingest complete lines, return the new
 * offset plus the count of lines that produced a non-duplicate insert.
 * Trailing partial line (no terminating `\n`) is left for the next call.
 */
async function readAndIngest(path: string, state: FileState): Promise<ReadResult> {
  const fh = await fsp.open(path, 'r');
  try {
    const stats = await fh.stat();
    if (stats.size <= state.offset) return { newOffset: state.offset, insertedCount: 0 };

    const bytesToRead = stats.size - state.offset;
    const buf = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fh.read(buf, 0, bytesToRead, state.offset);

    // Find the last newline (0x0a). Everything up to and including it is
    // complete lines; anything after is partial and we revisit next change.
    let lastNl = -1;
    for (let i = bytesRead - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) {
        lastNl = i;
        break;
      }
    }
    if (lastNl === -1) return { newOffset: state.offset, insertedCount: 0 };
    // The mirror decision is locked per session, so resolve it once per batch.
    // Sidecars (<uuid>.fleet.jsonl) are DB data (Stop-hook chapter summaries,
    // #207) — they ingest into SQLite normally but are never mirrored: the
    // mirror is a conversation-history backup, not a DB replica.
    const mirrorOn =
      !state.sidecar && effectiveForClaudeSession(state.workspaceId, state.sessionId);
    // Synchronous: decode + split of the whole unread tail.
    const batch = perfSpan(
      'claude_fleet.ingest.read',
      () => buf.slice(0, lastNl + 1).toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l.length > 0),
      { workspace_id: state.workspaceId, session_id: state.sessionId, bytes: lastNl + 1 }
    );
    const results = await perfSpanAsync(
      'claude_fleet.ingest',
      () => ingestBatch(state.workspaceId, state.sessionId, batch),
      { workspace_id: state.workspaceId, session_id: state.sessionId, lines: batch.length }
    );
    let insertedCount = 0;
    let mirrorBuf = '';
    results.forEach((result, i) => {
      // Mirror only genuinely-new inserts: the DB dedup key suppresses
      // re-reads after a compaction shrink, so we never double-append and the
      // mirror stays append-only / compaction-proof for free.
      if (!result.inserted) return;
      insertedCount++;
      if (mirrorOn) mirrorBuf += batch[i] + '\n';
    });

    if (mirrorBuf) {
      // Host-private location — never bind-mounted (SPEC §9). mkdir is cheap
      // and idempotent; do it lazily so off-sessions write nothing.
      await fsp.mkdir(workspaceHistoryDir(state.workspaceId), { recursive: true });
      await fsp.appendFile(
        workspaceHistoryFile(state.workspaceId, state.sessionId),
        mirrorBuf,
        'utf8'
      );
    }

    return { newOffset: state.offset + lastNl + 1, insertedCount };
  } finally {
    await fh.close();
  }
}

/**
 * .../state/<workspace>/.claude/projects/-workspace/<session>.jsonl
 *                       ^ marker — the segment before .claude is the workspace.
 */
function workspaceIdFromPath(filePath: string): string | null {
  const segments = filePath.split(/[\\/]/);
  const idx = segments.lastIndexOf('.claude');
  return idx > 0 ? (segments[idx - 1] ?? null) : null;
}
