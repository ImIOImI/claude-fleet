// Tails Claude transcript JSONLs and ingests new lines into the SQLite cache.
//
// Each workspace's claude binary writes its transcript to:
//   <userData>/state/<name>/.claude/projects/-workspace/<session-uuid>.jsonl
//
// We watch that directory non-recursively (so subagent JSONLs nested under
// <session-uuid>/subagents/* are deliberately skipped — out of scope for
// step 1). For every change we read from the file's last-known byte offset
// to the current EOF, split on newlines, ingest complete lines, and stash
// the offset of any trailing partial line for the next change event.
//
// Re-ingestion is idempotent: db.ingestLine uses uuid (or a content hash for
// light events) as a dedup key. The byte offset is an in-memory optimization
// only — if we lose it (process restart, watch dropped), re-reading from
// offset 0 produces the same end state.

import { EventEmitter } from 'node:events';
import { mkdirSync, promises as fsp, type Stats } from 'node:fs';
import { join, basename, extname, sep as pathSep } from 'node:path';
// chokidar v5 is ESM-only. Our main bundle is CommonJS (per
// electron.vite.config.ts), so `require('chokidar')` would throw
// ERR_REQUIRE_ESM. Load it via dynamic import inside `start()`.
import type { FSWatcher } from 'chokidar';
import { workspaceClaudeDir, workspaceHistoryDir, workspaceHistoryFile, hostLocalProjectsDir } from './paths.js';
import { ingestLine } from './db.js';
import { effectiveForClaudeSession } from './mirrorPolicy.js';

const PROJECTS_SUBDIR = join('projects', '-workspace');
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Session id + sidecar flag from a watched file path, or null if neither a
 *  primary transcript (<uuid>.jsonl) nor a fleet sidecar (<uuid>.fleet.jsonl).
 *  Sidecars carry host-bound events (session-summary chapters, #207) and are
 *  ingested under their session id but NEVER fire 'new-session' — they must
 *  not touch the pending-attach fallback or look like fresh conversations. */
export function parseTranscriptFilename(
  path: string
): { sessionId: string; sidecar: boolean } | null {
  if (extname(path) !== '.jsonl') return null;
  let stem = basename(path, '.jsonl');
  let sidecar = false;
  if (stem.endsWith('.fleet')) {
    stem = stem.slice(0, -'.fleet'.length);
    sidecar = true;
  }
  if (!UUID_RE.test(stem)) return null;
  return { sessionId: stem, sidecar };
}

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
 * Emitted the first time we see a JSONL file path — i.e. the first
 * `process()` after `initState` for that path. This is the trigger the
 * per-tab mapping layer uses to pair a freshly-spawned claude
 * session UUID with a pending attach (see `pendingAttaches.ts` +
 * `db.learnBrokerSessionMapping`). Fires before the corresponding
 * `'ingest'` event for the same batch.
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

export class JsonlWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private readonly files = new Map<string, FileState>();
  private readonly watchedDirs = new Set<string>();
  // Per-file mutex (sequenced via a chained promise) so concurrent
  // add/change events on the same file don't race the byte offset.
  private readonly chains = new Map<string, Promise<void>>();

  // Registered host transcript dirs for local-backend workspaces:
  //   ~/.claude/projects/<encoded-root>/  →  real workspace id.
  // Consulted before the '.claude'-parent path rule (which is wrong for
  // host paths). Watched at the specific subdir only, so unrelated personal
  // projects in the same ~/.claude/projects tree are never ingested.
  private readonly hostDirs = new Map<string, string>(); // dir → workspaceId

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
      this.watcher.unwatch(dir);
      const prefix = dir + pathSep;
      for (const path of [...this.files.keys()]) {
        if (path === dir || path.startsWith(prefix)) { this.files.delete(path); this.chains.delete(path); }
      }
    }
  }

  async start(workspaceIds: string[]): Promise<void> {
    if (this.watcher) return;
    const chokidar = await import('chokidar');
    this.watcher = chokidar.watch([], {
      depth: 0,
      ignoreInitial: false,
      persistent: true,
      // No awaitWriteFinish: we tolerate partial-line reads by tracking the
      // last newline byte and rolling the offset forward only past complete
      // lines. Lower latency this way.
    });
    this.watcher
      .on('add', (p) => this.enqueue(p))
      .on('change', (p) => this.enqueue(p))
      .on('unlink', (p) => {
        this.files.delete(p);
        this.chains.delete(p);
      })
      .on('error', (err) => console.error('[jsonlWatcher] error:', err));
    for (const name of workspaceIds) {
      this.registerWorkspace(name);
    }
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
    this.files.clear();
    this.chains.clear();
    this.watchedDirs.clear();
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
        this.chains.delete(path);
      }
    }
  }

  private enqueue(path: string): void {
    if (extname(path) !== '.jsonl') return;
    const prev = this.chains.get(path) ?? Promise.resolve();
    const next = prev.then(() => this.process(path)).catch((err) => {
      console.error(`[jsonlWatcher] process failed for ${path}:`, err);
    });
    this.chains.set(path, next);
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
    // Fires before the eventual 'ingest' emit for this batch.
    if (!existing && !state.sidecar) {
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
    const parsed = parseTranscriptFilename(path);
    if (!workspaceId || !parsed) return null;
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

    const text = buf.slice(0, lastNl + 1).toString('utf8');
    // The mirror decision is locked per session, so resolve it once per batch.
    // Sidecars (<uuid>.fleet.jsonl) are DB data (Stop-hook chapter summaries,
    // #207) — they ingest into SQLite normally but are never mirrored: the
    // mirror is a conversation-history backup, not a DB replica.
    const mirrorOn =
      !state.sidecar && effectiveForClaudeSession(state.workspaceId, state.sessionId);
    let insertedCount = 0;
    let mirrorBuf = '';
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const result = ingestLine(state.workspaceId, state.sessionId, trimmed);
      // Mirror only genuinely-new inserts: the DB dedup key suppresses
      // re-reads after a compaction shrink, so we never double-append and the
      // mirror stays append-only / compaction-proof for free.
      if (result.inserted) {
        insertedCount++;
        if (mirrorOn) mirrorBuf += trimmed + '\n';
      }
    }

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
