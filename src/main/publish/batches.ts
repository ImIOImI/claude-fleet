// Splits publishable rows into POST /publish batches (remote-workspaces §7). Pure.
import { PUBLISH_MAX_BODY, PUBLISH_MAX_LINES, SESSION_UUID_RE, type PublishBatch } from './protocol.js';
import { UnpublishableLineError, type ScrubbedLine } from './scrub.js';

export interface PublishRow {
  id: number;
  sessionId: string;
  rawJsonl: string;
  startedAt: number | null;
}

/** `batch` null: nothing to send, only move the cursor to `lastId`. */
export interface PlannedBatch {
  batch: PublishBatch<ScrubbedLine> | null;
  lastId: number;
}

export function planBatches(
  sourceWorkspaceId: string,
  rows: readonly PublishRow[],
  o: {
    scrub: (line: string) => ScrubbedLine;
    withheld: ReadonlySet<string>;
    /** Sessions that started earlier, or have no start yet, aren't published (D104). */
    since: number;
    maxBody?: number;
    maxLines?: number;
    onOversize?: (row: PublishRow) => void;
    onUnpublishable?: (row: PublishRow, why: string) => void;
  }
): PlannedBatch[] {
  const maxBody = o.maxBody ?? PUBLISH_MAX_BODY;
  const maxLines = o.maxLines ?? PUBLISH_MAX_LINES;
  const out: PlannedBatch[] = [];
  let cur: { sessionId: string; lines: ScrubbedLine[]; bytes: number; lastId: number } | null = null;
  const flush = (): void => {
    if (cur) out.push({ batch: { sourceWorkspaceId, sessionId: cur.sessionId, events: cur.lines }, lastId: cur.lastId });
    cur = null;
  };
  const skip = (id: number): void => {
    flush();
    const last = out[out.length - 1];
    if (last && !last.batch) last.lastId = id;
    else out.push({ batch: null, lastId: id });
  };
  for (const row of rows) {
    if (o.withheld.has(row.sessionId) || !SESSION_UUID_RE.test(row.sessionId) || row.startedAt === null || row.startedAt < o.since) {
      skip(row.id);
      continue;
    }
    let line: ScrubbedLine;
    try {
      line = o.scrub(row.rawJsonl);
    } catch (err) {
      if (!(err instanceof UnpublishableLineError)) throw err;
      o.onUnpublishable?.(row, err.message);
      skip(row.id);
      continue;
    }
    // The host refuses the whole batch over one non-object line.
    if (!line.startsWith('{')) {
      o.onUnpublishable?.(row, 'line is not a JSON object');
      skip(row.id);
      continue;
    }
    const cost = Buffer.byteLength(JSON.stringify(line)) + 1;
    const base = Buffer.byteLength(JSON.stringify({ sourceWorkspaceId, sessionId: row.sessionId, events: [] }));
    if (base + cost > maxBody) {
      o.onOversize?.(row);
      skip(row.id);
      continue;
    }
    if (cur && (cur.sessionId !== row.sessionId || cur.lines.length >= maxLines || cur.bytes + cost > maxBody)) flush();
    cur ??= { sessionId: row.sessionId, lines: [], bytes: base, lastId: row.id };
    cur.lines.push(line);
    cur.bytes += cost;
    cur.lastId = row.id;
  }
  flush();
  return out;
}
