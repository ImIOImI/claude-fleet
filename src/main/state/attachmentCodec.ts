// Attachment payload dedupe codec (SPEC §7 *Attachment dedupe*): replace a
// line's `attachment` value with a hash marker, and splice it back. Pure: no DB.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ATTACHMENT_MIN_BYTES = 1024;
const KEY = '"attachment":';
const MARKER_KEY = '"fleetRef":"';
const marker = (ref: string): string => `{${MARKER_KEY}${ref}"}`;

// Not String.replace: payloads contain `$` patterns.
function splice(s: string, at: number, len: number, insert: string): string {
  return s.slice(0, at) + insert + s.slice(at + len);
}

function rebuild(stored: string, ref: string, payload: string): string | null {
  const m = marker(ref);
  const at = stored.indexOf(m);
  return at < 0 ? null : splice(stored, at, m.length, payload);
}

/** The stored form of an attachment line with a large payload, or null when
 *  the line is not one or would not rebuild exactly. */
export function dedupeAttachment(line: string, parsed?: Record<string, unknown>): { stored: string; ref: string; payload: string } | null {
  let o = parsed;
  if (!o) {
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!o || o.type !== 'attachment' || o.attachment === undefined) return null;
  const payload = JSON.stringify(o.attachment);
  if (Buffer.byteLength(payload, 'utf8') < ATTACHMENT_MIN_BYTES || line.includes(MARKER_KEY)) return null;
  const at = line.indexOf(KEY + payload);
  if (at < 0 || line.indexOf(KEY + payload, at + 1) >= 0) return null;
  const ref = createHash('sha256').update(payload, 'utf8').digest('hex');
  const stored = splice(line, at + KEY.length, payload.length, marker(ref));
  return rebuild(stored, ref, payload) === line ? { stored, ref, payload } : null;
}

export function deflatePayload(payload: string): Buffer {
  return deflateSync(Buffer.from(payload, 'utf8'), { level: 6 });
}

/** The original line. A missing or corrupt body reads as the stored form
 *  (valid JSON with the marker); `strict` throws instead. */
export function expandLine(stored: string, ref: string | null, bodyZ: Uint8Array | null, strict = false): string {
  if (!ref) return stored;
  try {
    if (!bodyZ || bodyZ.length === 0) throw new Error(`attachment blob ${ref} missing`);
    const out = rebuild(stored, ref, inflateSync(bodyZ).toString('utf8'));
    if (out === null) throw new Error(`attachment marker ${ref} not found`);
    return out;
  } catch (e) {
    if (strict) throw e;
    return stored;
  }
}
