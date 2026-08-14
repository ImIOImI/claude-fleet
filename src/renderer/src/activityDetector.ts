// Detects whether a claude session is actively working ("busy") vs idle by
// watching its PTY output stream for the terminal-title (OSC) sequence claude
// emits — `ESC ] 0 ; <glyph> <text> BEL`. The leading glyph encodes state:
// a braille spinner (U+2800–U+28FF, animating ⠂⠐⠒…) means busy; anything
// else (claude uses ✳) means idle/done. The title is far more stable to
// parse than the TUI body, so this is the robust signal (see SPEC §11).
//
// Note this is busy-vs-idle, NOT "needs your input" — claude renders an
// AskUserQuestion/permission prompt without a distinct title glyph (it reads
// as idle), and those never reach the JSONL, so a true needs-input signal
// isn't available. Busy/idle is what's reliably detectable.

const OSC_TITLE = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// Cap the CARRY-OVER between pushes: titles are short, so what survives a push
// only needs to span a sequence split across two chunks, never accumulate real
// output. Applied strictly AFTER scanning (#283) — trimming first discarded any
// title with ≥ ~500 bytes behind it in the same chunk (a full-screen repaint is
// several KB), and because claude re-asserts the spinner title every frame but
// writes the idle title exactly once, every swallowed edge left the flag stuck
// on busy.
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
