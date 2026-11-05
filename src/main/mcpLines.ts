// Newline-delimited request framing for the MCP sockets, bounded per line.

export const MAX_LINE_BYTES = 1 << 20;

/** Feeds utf8 chunks; calls `onLine` per complete line (returning false stops
 *  the stream) and `onOversize` once per line over `max` bytes, which is dropped.
 *  Each chunk is scanned once, so a long line costs linear time. */
export function lineSplitter(
  onLine: (line: string) => boolean | void,
  onOversize: () => void,
  max = MAX_LINE_BYTES,
): (chunk: string) => void {
  let buf = '';
  let skipping = false;
  let stopped = false;
  return (chunk) => {
    let start = 0;
    while (!stopped) {
      const nl = chunk.indexOf('\n', start);
      if (nl < 0) break;
      const part = chunk.slice(start, nl);
      start = nl + 1;
      if (skipping) { skipping = false; buf = ''; continue; }
      const line = buf + part;
      buf = '';
      if (Buffer.byteLength(line) > max) { onOversize(); continue; }
      if (onLine(line) === false) stopped = true;
    }
    if (stopped || skipping) return;
    buf += chunk.slice(start);
    // UTF-16 length bounds the buffer; the exact byte check runs on the complete line.
    if (buf.length > max) {
      buf = '';
      skipping = true;
      onOversize();
    }
  };
}
