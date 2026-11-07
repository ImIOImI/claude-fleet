// Ingest of this container's own transcripts into the host store (holder only).
// Offsets persist in host_ingest_offsets, so a restart resumes instead of
// re-reading every transcript on shared storage.
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ingestBatch, INGEST_TX_LINES } from '../main/db.js';
import type { StateDb } from '../main/store/stateSchema.js';
import { keyedSerialQueue, type KeyedSerialQueue } from '../main/state/serialQueue.js';
import { parseSubagentPath, parseTranscriptFilename } from '../main/state/transcriptPaths.js';
import type { HostDb } from './hostSchema.js';
import { redactJsonLine, type Logger } from './log.js';

export const RESCAN_MS = 60_000;
/** One read's bound; a larger delta is ingested over several reads. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** A longer line is skipped and logged. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** Per ingest transaction, with INGEST_TX_LINES: a fenced transaction delays any takeover until it ends. */
export const MAX_CHUNK_BYTES = 1024 * 1024;
/** A slow chunk aborts and is retried on the next change or rescan. */
export const INGEST_STATEMENT_TIMEOUT = '5s';

export interface HostIngestOptions {
  projectsDir: string;
  workspaceId: string;
  /** Start-up load only; offsets are written inside ingest's fenced chunk transaction. */
  offsetsRead: Kysely<HostDb>;
  log: Logger;
  ingest?: typeof ingestBatch;
  rescanMs?: number;
  maxReadBytes?: number;
  maxLineBytes?: number;
  maxChunkBytes?: number;
  /** After a chunk's transaction commits. */
  onIngested?: (sessionId: string) => void;
}

interface FileMark {
  offset: number;
  /** Detects a transcript replaced by a new file. */
  ino: string | null;
}

export class HostIngest {
  private readonly done = new Map<string, FileMark>();
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
    const rows = await this.o.offsetsRead.selectFrom('host_ingest_offsets').select(['path', 'byte_offset', 'ino']).orderBy('path').execute();
    for (const r of rows) this.done.set(r.path, { offset: Number(r.byte_offset), ino: r.ino });
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
    let fh: FileHandle;
    try {
      fh = await open(path, 'r');
    } catch {
      return;
    }
    try {
      const st = await fh.stat({ bigint: true });
      const ino = String(st.ino);
      const size = Number(st.size);
      const prev = this.done.get(path);
      let offset = prev?.offset ?? 0;
      // Replaced or shrunk (compaction): re-read; dedup keys keep existing rows.
      if ((prev?.ino != null && prev.ino !== ino) || size < offset) offset = 0;
      while (offset < size && !this.stopped) {
        const next = await this.readFrom(fh, path, ino, offset, size, sessionId);
        if (next === offset) break;
        offset = next;
      }
    } finally {
      await fh.close();
    }
  }

  /** Absolute position of the first newline at or after `from`, or -1. */
  private async findNewline(fh: FileHandle, from: number, size: number): Promise<number> {
    const step = this.o.maxReadBytes ?? MAX_READ_BYTES;
    const buf = Buffer.alloc(step);
    for (let at = from; at < size; at += step) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(step, size - at), at);
      const i = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (i !== -1) return at + i;
      if (bytesRead === 0) break;
    }
    return -1;
  }

  /** Ingests the complete lines from `offset` in bounded chunks; returns the offset after the last one committed. */
  private async readFrom(fh: FileHandle, path: string, ino: string, offset: number, size: number, sessionId: string): Promise<number> {
    const want = Math.min(size - offset, this.o.maxReadBytes ?? MAX_READ_BYTES);
    let buf = Buffer.alloc(want);
    buf = buf.subarray(0, (await fh.read(buf, 0, want, offset)).bytesRead);
    let lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) {
      if (offset + buf.length >= size) return offset;
      const nl = await this.findNewline(fh, offset + buf.length, size);
      if (nl === -1) return offset;
      const len = nl + 1 - offset;
      if (len > (this.o.maxLineBytes ?? MAX_LINE_BYTES)) {
        this.o.log.log('warn', 'transcript line over the size cap; skipped', { path, offset, bytes: len });
        this.done.set(path, { offset: nl + 1, ino });
        return nl + 1;
      }
      buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      lastNl = len - 1;
    }
    const maxChunk = this.o.maxChunkBytes ?? MAX_CHUNK_BYTES;
    let at = offset;
    let lines: string[] = [];
    let bytes = 0;
    const flush = async (end: number) => {
      if (lines.length) {
        await this.ingest(this.o.workspaceId, sessionId, lines, {
          atStart: async (trx) => void (await sql`SET LOCAL statement_timeout = ${sql.lit(INGEST_STATEMENT_TIMEOUT)}`.execute(trx)),
          inTx: (trx) => this.saveOffset(trx, path, ino, end)
        });
        this.o.onIngested?.(sessionId);
      }
      this.done.set(path, { offset: end, ino });
      at = end;
      lines = [];
      bytes = 0;
    };
    let pos = 0;
    while (pos <= lastNl) {
      if (this.stopped) return at;
      const nl = buf.indexOf(0x0a, pos);
      const raw = buf.subarray(pos, nl);
      const l = raw.toString('utf8').trim();
      if (l && lines.length && (lines.length >= INGEST_TX_LINES || bytes + raw.length > maxChunk)) await flush(offset + pos);
      if (l) {
        lines.push(redactJsonLine(l));
        bytes += raw.length;
      }
      pos = nl + 1;
    }
    await flush(offset + pos);
    return at;
  }

  // host_ingest_offsets shares the store schema but not StateDb's types.
  private async saveOffset(trx: Transaction<StateDb>, path: string, ino: string, offset: number): Promise<void> {
    const now = Date.now();
    await sql`INSERT INTO host_ingest_offsets (path, byte_offset, ino, updated_at) VALUES (${path}, ${offset}, ${ino}, ${now})
      ON CONFLICT (path) DO UPDATE SET byte_offset = EXCLUDED.byte_offset, ino = EXCLUDED.ino, updated_at = EXCLUDED.updated_at`.execute(trx);
  }
}
