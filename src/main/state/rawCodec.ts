// Retention codec for events.raw_jsonl (SPEC §7 *Retention*): strip a line to
// a stub, deflate it into raw_z, and read either form back. Pure: no DB.
import { deflateSync, inflateSync } from 'node:zlib';

/** Lines shorter than this stay uncompressed: deflate barely shrinks them. */
export const COMPRESS_MIN_BYTES = 512;
export const STUB_HEAD_CHARS = 500;
/** A tool_use input whose JSON is longer than this is stripped. */
export const TOOL_INPUT_MAX = 2048;
const KEEP_INPUT = new Set(['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'description', 'skill', 'subagent_type']);
const KEEP_MAX = 4096;
const OTHER_MAX = 200;

/** The stored line: raw_z inflated when present, else raw_jsonl. */
export function rawLine(r: { raw_jsonl: string; raw_z: Uint8Array | null }): string {
  return r.raw_z && r.raw_z.length > 0 ? inflateSync(r.raw_z).toString('utf8') : r.raw_jsonl;
}

export function deflateLine(line: string): Buffer {
  return deflateSync(Buffer.from(line, 'utf8'), { level: 6 });
}

type Block = Record<string, unknown>;

/** The stub for a tool_result line or a line with an oversized tool_use input;
 *  null when the line is neither, is already stripped, or isn't JSON. The stub
 *  stays a valid transcript line so existing readers parse it. */
export function stripLine(line: string, nowMs: number): string | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.fleetStripped) return null;
  const msg = o.message as { content?: unknown } | undefined;
  if (!msg || !Array.isArray(msg.content)) return null;
  const content = msg.content as Block[];
  const fleetStripped = { bytes: Buffer.byteLength(line, 'utf8'), at: nowMs };

  if (o.type === 'user' && content.some((b) => b?.type === 'tool_result')) {
    const blocks = content.map((b) => {
      if (b?.type !== 'tool_result') return b;
      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error ?? false, content: text.slice(0, STUB_HEAD_CHARS) };
    });
    const { toolUseResult: _dropped, ...rest } = o;
    return JSON.stringify({ ...rest, message: { ...msg, content: blocks }, fleetStripped });
  }

  if (o.type === 'assistant') {
    let changed = false;
    const blocks = content.map((b) => {
      if (b?.type !== 'tool_use' || !b.input || typeof b.input !== 'object') return b;
      if (JSON.stringify(b.input).length <= TOOL_INPUT_MAX) return b;
      changed = true;
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.input as Record<string, unknown>)) {
        const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
        if (KEEP_INPUT.has(k)) input[k] = s.length > KEEP_MAX ? s.slice(0, KEEP_MAX) : v;
        else input[k] = s.length > OTHER_MAX ? `${s.slice(0, OTHER_MAX)}…` : v;
      }
      return { ...b, input };
    });
    return changed ? JSON.stringify({ ...o, message: { ...msg, content: blocks }, fleetStripped }) : null;
  }
  return null;
}
