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

import { promises as fsp, type Stats } from 'node:fs';
import { join, basename, extname, sep as pathSep } from 'node:path';
// chokidar v5 is ESM-only. Our main bundle is CommonJS (per
// electron.vite.config.ts), so `require('chokidar')` would throw
// ERR_REQUIRE_ESM. Load it via dynamic import inside `start()`.
import type { FSWatcher } from 'chokidar';
import { workspaceClaudeDir } from './paths.js';
import { ingestLine } from './db.js';

const PROJECTS_SUBDIR = join('projects', '-workspace');
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FileState {
  workspaceName: string;
  sessionId: string;
  offset: number;
}

export class JsonlWatcher {
  private watcher: FSWatcher | null = null;
  private readonly files = new Map<string, FileState>();
  private readonly watchedDirs = new Set<string>();
  // Per-file mutex (sequenced via a chained promise) so concurrent
  // add/change events on the same file don't race the byte offset.
  private readonly chains = new Map<string, Promise<void>>();

  async start(workspaceNames: string[]): Promise<void> {
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
    for (const name of workspaceNames) {
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
    // chokidar tolerates non-existent paths; when the dir is created later
    // (first time claude runs in the workspace) `add` events fire.
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
    const state = this.files.get(path) ?? this.initState(path);
    if (!state) return;

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

    const newOffset = await readAndIngest(path, state);
    state.offset = newOffset;
    this.files.set(path, state);
  }

  private initState(path: string): FileState | null {
    const workspaceName = workspaceNameFromPath(path);
    const sessionId = basename(path, '.jsonl');
    if (!workspaceName || !UUID_RE.test(sessionId)) return null;
    const state: FileState = { workspaceName, sessionId, offset: 0 };
    this.files.set(path, state);
    return state;
  }
}

/**
 * Read from `state.offset` to EOF, ingest complete lines, return new offset.
 * Trailing partial line (no terminating `\n`) is left for the next call.
 */
async function readAndIngest(path: string, state: FileState): Promise<number> {
  const fh = await fsp.open(path, 'r');
  try {
    const stats = await fh.stat();
    if (stats.size <= state.offset) return state.offset;

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
    if (lastNl === -1) return state.offset;

    const text = buf.slice(0, lastNl + 1).toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      ingestLine(state.workspaceName, state.sessionId, trimmed);
    }

    return state.offset + lastNl + 1;
  } finally {
    await fh.close();
  }
}

/**
 * .../state/<workspace>/.claude/projects/-workspace/<session>.jsonl
 *                       ^ marker — the segment before .claude is the workspace.
 */
function workspaceNameFromPath(filePath: string): string | null {
  const segments = filePath.split(/[\\/]/);
  const idx = segments.lastIndexOf('.claude');
  return idx > 0 ? (segments[idx - 1] ?? null) : null;
}
