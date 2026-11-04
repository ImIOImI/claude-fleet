// Pure JSONL-line → events-row extraction for the state.db ingest path.
// No DB access: db.ts's ingest transaction consumes ParsedLine. Moved verbatim
// out of db.ts (async store part 2) so the extraction is testable on its own.
import { createHash } from 'node:crypto';

export interface ParsedLine {
  /** The parsed JSON object (metadata derivation reads it). */
  parsed: Record<string, unknown>;
  /** `parsed.message` when it is an object, else null. */
  message: Record<string, unknown> | null;
  type: string;
  ts: number | null;
  dedupKey: string;
  /** events columns other than session_id / workspace_id / raw_jsonl. */
  event: {
    ts: number | null;
    type: string;
    subtype: string | null;
    uuid: string | null;
    parent_uuid: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    service_tier: string | null;
    tool_name: string | null;
    tool_use_id: string | null;
    tool_input: string | null;
    tool_result_is_error: number | null;
    dedup_key: string;
  };
}

/** Parse one raw JSONL line; null when it is not valid JSON (a partial write). */
export function parseIngestLine(rawLine: string): ParsedLine | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = String(parsed.type ?? 'unknown');
  const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : null;
  const ts = parseTimestamp(parsed.timestamp);
  const dedupKey = uuid ?? hashLine(rawLine);
  const message = (parsed.message ?? null) as Record<string, unknown> | null;
  const usage = (message?.usage ?? null) as Record<string, unknown> | null;
  const tool = extractToolDetail(message);
  return {
    parsed,
    message,
    type,
    ts,
    dedupKey,
    event: {
      ts,
      type,
      subtype: typeof parsed.subtype === 'string' ? parsed.subtype : null,
      uuid,
      parent_uuid: typeof parsed.parentUuid === 'string' ? parsed.parentUuid : null,
      model: typeof message?.model === 'string' ? message.model : null,
      input_tokens: numOrNull(usage?.input_tokens),
      output_tokens: numOrNull(usage?.output_tokens),
      cache_read_input_tokens: numOrNull(usage?.cache_read_input_tokens),
      cache_creation_input_tokens: numOrNull(usage?.cache_creation_input_tokens),
      service_tier: typeof usage?.service_tier === 'string' ? usage.service_tier : null,
      tool_name: tool.name,
      tool_use_id: tool.useId,
      tool_input: tool.input,
      tool_result_is_error: tool.resultIsError,
      dedup_key: dedupKey,
    },
  };
}

function parseTimestamp(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hashLine(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface ToolDetail {
  name: string | null;
  useId: string | null;
  input: string | null;
  resultIsError: number | null;
}

/**
 * Pull tool-call detail from an event's `message.content[]`. An assistant
 * event's first `tool_use` block yields the name, its id, and a short input
 * summary; a user event's `tool_result` block yields the matching
 * `tool_use_id` and whether it errored. Events with neither return all-null.
 */
function extractToolDetail(message: Record<string, unknown> | null): ToolDetail {
  const empty: ToolDetail = { name: null, useId: null, input: null, resultIsError: null };
  if (!message) return empty;
  const content = message.content;
  if (!Array.isArray(content)) return empty;
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block) continue;
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      return {
        name: block.name,
        useId: typeof block.id === 'string' ? block.id : null,
        input: summarizeToolInput(block.input),
        resultIsError: null,
      };
    }
    if (block.type === 'tool_result') {
      return {
        name: null,
        useId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
        input: null,
        resultIsError: block.is_error === true ? 1 : 0,
      };
    }
  }
  return empty;
}

/**
 * A compact, human-readable one-liner for a tool's input — prefers the most
 * identifying field (command/path/pattern/url/description), else a truncated
 * JSON dump. Capped so it stays a chip-sized label.
 */
function summarizeToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const pick =
    (typeof o.command === 'string' && o.command) ||
    (typeof o.file_path === 'string' && o.file_path) ||
    (typeof o.path === 'string' && o.path) ||
    (typeof o.pattern === 'string' && o.pattern) ||
    (typeof o.url === 'string' && o.url) ||
    (typeof o.description === 'string' && o.description) ||
    '';
  const s = pick || JSON.stringify(o);
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}

export interface SessionTouch {
  started_at: number | null;
  last_active_at: number | null;
}

/**
 * The per-line sessions upsert the ingest path has always run —
 *   INSERT (started_at, last_active_at) = (ts, ts)
 *   ON CONFLICT: last_active_at = MAX(COALESCE(last_active_at, 0), ts),
 *                started_at     = COALESCE(started_at, ts)
 * — folded over a chunk's parsed lines, so a chunk writes the row once.
 * `prev` is the row before the chunk (undefined = no row yet). SQLite's
 * multi-argument MAX returns NULL when any argument is NULL, so a ts-less
 * (light) line sets last_active_at to NULL; that rule is reproduced exactly
 * here and fixed separately (#475).
 */
export function foldSessionTouch(prev: SessionTouch | undefined, tss: ReadonlyArray<number | null>): SessionTouch | undefined {
  let row = prev ? { ...prev } : undefined;
  for (const ts of tss) {
    if (!row) {
      row = { started_at: ts, last_active_at: ts };
      continue;
    }
    row.last_active_at = ts === null ? null : Math.max(row.last_active_at ?? 0, ts);
    row.started_at = row.started_at ?? ts;
  }
  return row;
}
