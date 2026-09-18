// Pure line-splitter for the qwen→fleet transcript sidecar.
// Returns the complete lines from `buffer` (up to the last newline) and the
// new byte offset (= lastNl + 1), so the caller can advance its read pointer.
// When there is no newline yet, returns { lines: [], offset: 0 } so the caller
// keeps its current offset unchanged (it will retry on the next file-change).
export function nextLines(buffer) {
  const lastNl = buffer.lastIndexOf('\n');
  if (lastNl < 0) return { lines: [], offset: 0 };
  const complete = buffer.slice(0, lastNl);
  return { lines: complete.split('\n'), offset: lastNl + 1 };
}
