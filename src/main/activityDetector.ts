// Main-process twin of `src/renderer/src/activityDetector.ts` (#121). Detects
// whether a claude session is busy vs idle by watching its PTY output for the
// terminal-title OSC sequence `ESC ] 0 ; <glyph> <text> BEL`; a leading braille
// spinner glyph (U+2800–U+28FF) means busy. The renderer runs this for the chip
// indicator, but the committee runs unattended and must not depend on renderer
// React state — so main taps the same broker output stream and scans it here.
//
// Kept as a separate copy (not shared) because the main + renderer tsconfigs
// are disjoint (`src/main` vs `src/renderer/src`). The logic is pure + stable;
// the renderer twin carries the same parser and its own test. Keep them in
// sync. Known limitation (SPEC §11): idle ≈ "done OR waiting on a permission
// prompt" — the glyph can't tell them apart.

const OSC_TITLE = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// Cap on the CARRY-OVER between pushes, applied strictly AFTER scanning (#283):
// trimming before the scan discarded any title with ≥ ~500 bytes behind it in
// the same chunk, and a swallowed idle edge (written once, unlike the spinner)
// left committee busy stuck on permanently.
const BUF_CAP = 512;

/** True when the title's leading glyph is a braille spinner frame. */
export function isBusyTitle(title: string): boolean {
  const ch = [...title.trim()][0];
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x2800 && cp <= 0x28ff;
}

/**
 * Stateful per-session detector. Feed PTY output chunks via `push`; it returns
 * true only when the busy/idle state actually flips, so callers can fire a
 * change event without debouncing every chunk.
 */
export class ActivityDetector {
  private buf = '';
  private busy = false;

  push(chunk: string): boolean {
    this.buf += chunk;
    let m: RegExpExecArray | null;
    let lastTitle: string | null = null;
    let tailStart = 0;
    OSC_TITLE.lastIndex = 0;
    while ((m = OSC_TITLE.exec(this.buf)) !== null) {
      lastTitle = m[1];
      tailStart = m.index + m[0].length;
    }
    // Trim only AFTER the scan: everything up to the last complete title has
    // been seen and is safe to drop; the capped tail carries a possibly-split
    // trailing sequence into the next push.
    const tail = this.buf.slice(tailStart);
    this.buf = tail.length > BUF_CAP ? tail.slice(-BUF_CAP) : tail;
    if (lastTitle === null) return false;
    const next = isBusyTitle(lastTitle);
    if (next === this.busy) return false;
    this.busy = next;
    return true;
  }

  get isBusy(): boolean {
    return this.busy;
  }
}
