// Ingest of this container's own transcripts into the host store (holder only).
// Offsets persist in host_ingest_offsets, so a restart resumes instead of
// re-reading every transcript on shared storage.
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ingestBatch, INGEST_TX_LINES } from '../main/db.js';
import type { StateDb } from '../main/store/stateSchema.js';
import { keyedSerialQueue, type KeyedSerialQueue } from '../main/state/serialQueue.js';
import { parseSubagentPath, parseTranscriptFilename } from '../main/state/transcriptPaths.js';
import type { HostDb } from './hostSchema.js';
import { redactSecrets, type Logger } from './log.js';

export const RESCAN_MS = 60_000;
/** One read's bound; a larger delta is ingested over several reads. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

export interface HostIngestOptions {
  projectsDir: string;
  workspaceId: string;
  /** Start-up load only; offsets are written inside ingest's fenced chunk transaction. */
  offsetsRead: Kysely<HostDb>;
  log: Logger;
  ingest?: typeof ingestBatch;
  rescanMs?: number;
}

export class HostIngest {
  private readonly done = new Map<string, number>();
  private readonly queue: KeyedSerialQueue;
  private readonly ingest: typeof ingestBatch;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly o: HostIngestOptions) {
    this.ingest = o.ingest ?? ingestBatch;
    this.queue = keyedSerialQueue((path, err) => o.log.log('warn', 'transcript ingest failed', { path, error: (err as Error).message }));
  }

  /** Loads offsets and starts watching; the first full scan runs in the background. */
  async start(): Promise<void> {
    const rows = await this.o.offsetsRead.selectFrom('host_ingest_offsets').select(['path', 'byte_offset']).orderBy('path').execute();
    for (const r of rows) this.done.set(r.path, Number(r.byte_offset));
    await mkdir(this.o.projectsDir, { recursive: true });
    try {
      // Writers are local processes, so inotify fires even on an NFS mount.
      this.watcher = watch(this.o.projectsDir, { recursive: true }, (_event, name) => {
        if (name?.endsWith('.jsonl')) void this.enqueue(join(this.o.projectsDir, name));
      });
      this.watcher.on('error', (err) => this.o.log.log('warn', 'transcript watch failed; rescans continue', { error: err.message }));
    } catch (err) {
      this.o.log.log('warn', 'transcript watch unavailable; rescans only', { error: (err as Error).message });
    }
    this.timer = setInterval(() => void this.scan(), this.o.rescanMs ?? RESCAN_MS);
    this.timer.unref();
    void this.scan();
  }

  /** Enqueues every transcript and subagent transcript, and waits for them. */
  async scan(): Promise<void> {
    const files: string[] = [];
    for (const proj of await readdir(this.o.projectsDir, { withFileTypes: true }).catch(() => [])) {
      if (!proj.isDirectory()) continue;
      const pdir = join(this.o.projectsDir, proj.name);
      for (const e of await readdir(pdir, { withFileTypes: true }).catch(() => [])) {
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(pdir, e.name));
        else if (e.isDirectory()) {
          const sub = join(pdir, e.name, 'subagents');
          for (const f of await readdir(sub).catch(() => [] as string[])) if (f.endsWith('.jsonl')) files.push(join(sub, f));
        }
      }
    }
    await Promise.all(files.map((f) => this.enqueue(f)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    await this.queue.drain();
  }

  private enqueue(path: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.queue.enqueue(path, () => this.process(path));
  }

  private async process(path: string): Promise<void> {
    if (this.stopped) return;
    const sessionId = parseSubagentPath(path)?.parentSessionId ?? parseTranscriptFilename(path)?.sessionId;
    if (!sessionId) return;
    const size = (await stat(path).catch(() => null))?.size;
    if (size === undefined) return;
    let offset = this.done.get(path) ?? 0;
    // Shrunk (compaction): re-read; dedup keys keep existing rows.
    if (size < offset) offset = 0;
    while (offset < size && !this.stopped) {
      const next = await this.readFrom(path, offset, size, sessionId);
      if (next === offset) break;
      offset = next;
    }
  }

  /** Ingests the complete lines from `offset`, one chunk per call; returns the offset after the last one. */
  private async readFrom(path: string, offset: number, size: number, sessionId: string): Promise<number> {
    const fh = await open(path, 'r');
    let buf: Buffer;
    let lastNl: number;
    try {
      let want = Math.min(size - offset, MAX_READ_BYTES);
      buf = Buffer.alloc(want);
      let { bytesRead } = await fh.read(buf, 0, want, offset);
      lastNl = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (lastNl === -1 && want < size - offset) {
        // One line longer than the bound: read the rest in one go.
        want = size - offset;
        buf = Buffer.alloc(want);
        ({ bytesRead } = await fh.read(buf, 0, want, offset));
        lastNl = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      }
    } finally {
      await fh.close();
    }
    if (lastNl === -1) return offset;
    let at = offset;
    let pos = 0;
    let lines: string[] = [];
    while (pos <= lastNl && !this.stopped) {
      const nl = buf.indexOf(0x0a, pos);
      const l = buf.subarray(pos, nl).toString('utf8').trim();
      pos = nl + 1;
      if (l) lines.push(redactSecrets(l));
      if (lines.length < INGEST_TX_LINES && pos <= lastNl) continue;
      const end = offset + pos;
      if (lines.length) await this.ingest(this.o.workspaceId, sessionId, lines, { inTx: (trx) => this.saveOffset(trx, path, end) });
      this.done.set(path, end);
      at = end;
      lines = [];
    }
    return at;
  }

  // host_ingest_offsets shares the store schema but not StateDb's types.
  private async saveOffset(trx: Transaction<StateDb>, path: string, offset: number): Promise<void> {
    const now = Date.now();
    await sql`INSERT INTO host_ingest_offsets (path, byte_offset, updated_at) VALUES (${path}, ${offset}, ${now})
      ON CONFLICT (path) DO UPDATE SET byte_offset = EXCLUDED.byte_offset, updated_at = EXCLUDED.updated_at`.execute(trx);
  }
}
