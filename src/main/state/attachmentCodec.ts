// Attachment payload dedupe codec (SPEC §7 *Attachment dedupe*): replace a
// line's `attachment` and `rendered` values with hash markers, and splice them
// back. Pure: no DB.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ATTACHMENT_MIN_BYTES = 1024;
/** Top-level fields moved into the blob, in part order. `rendered` is the
 *  attachment's rendered text and repeats with it. */
export const DEDUPE_KEYS = ['attachment', 'rendered'] as const;
const MARKER_KEY = '"fleetRef":"';
export const partMarker = (ref: string, part: number): string => `{${MARKER_KEY}${ref}","part":${part}}`;

// Not String.replace: payloads contain `$` patterns.
function splice(s: string, at: number, len: number, insert: string): string {
  return s.slice(0, at) + insert + s.slice(at + len);
}

/** The line with each part marker replaced by its text; null when a marker is missing. */
function rebuild(stored: string, ref: string, parts: readonly string[]): string | null {
  let out = stored;
  for (const [i, text] of parts.entries()) {
    const m = partMarker(ref, i);
    const at = out.indexOf(m);
    if (at < 0) return null;
    out = splice(out, at, m.length, text);
  }
  return out;
}

/** The stored form of an attachment line with a large payload, or null when
 *  the line is not one or would not rebuild exactly. `payload` is the blob
 *  body: a JSON array of the moved values' literal text. */
export function dedupeAttachment(line: string, parsed?: Record<string, unknown>): { stored: string; ref: string; payload: string } | null {
  let o = parsed;
  if (!o) {
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!o || o.type !== 'attachment' || o.attachment === undefined || line.includes(MARKER_KEY)) return null;
  const parts: { at: number; text: string }[] = [];
  for (const key of DEDUPE_KEYS) {
    if (o[key] === undefined) continue;
    const text = JSON.stringify(o[key]);
    const needle = `"${key}":${text}`;
    const at = line.indexOf(needle);
    if (at < 0 || line.indexOf(needle, at + 1) >= 0) return null;
    parts.push({ at: at + key.length + 3, text });
  }
  if (parts.reduce((n, p) => n + Buffer.byteLength(p.text, 'utf8'), 0) < ATTACHMENT_MIN_BYTES) return null;
  const payload = JSON.stringify(parts.map((p) => p.text));
  const ref = createHash('sha256').update(payload, 'utf8').digest('hex');
  // Splice from the end so earlier offsets stay valid.
  let stored = line;
  for (const i of parts.map((_, i) => i).sort((a, b) => parts[b].at - parts[a].at)) {
    stored = splice(stored, parts[i].at, parts[i].text.length, partMarker(ref, i));
  }
  return rebuild(stored, ref, parts.map((p) => p.text)) === line ? { stored, ref, payload } : null;
}

export function deflatePayload(payload: string): Buffer {
  return deflateSync(Buffer.from(payload, 'utf8'), { level: 6 });
}

/** The original line. A missing or corrupt body reads as the stored form
 *  (valid JSON with the markers); `strict` throws instead. */
export function expandLine(stored: string, ref: string | null, bodyZ: Uint8Array | null, strict = false): string {
  if (!ref) return stored;
  try {
    if (!bodyZ || bodyZ.length === 0) throw new Error(`attachment blob ${ref} missing`);
    const parts = JSON.parse(inflateSync(bodyZ).toString('utf8')) as unknown;
    if (!Array.isArray(parts) || !parts.every((p) => typeof p === 'string')) throw new Error(`attachment blob ${ref} malformed`);
    const out = rebuild(stored, ref, parts as string[]);
    if (out === null) throw new Error(`attachment marker ${ref} not found`);
    return out;
  } catch (e) {
    if (strict) throw e;
    return stored;
  }
}
