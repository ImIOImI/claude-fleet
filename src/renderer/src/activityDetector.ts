// Detects whether a claude session is actively working ("busy") vs idle by
// watching its PTY output stream for the terminal-title (OSC) sequence claude
// emits — `ESC ] 0 ; <glyph> <text> BEL`. The leading glyph encodes state:
// a quadrant-circle spinner (U+25D0–U+25D3, animating ◐◑◒◓ — current claude)
// or a braille spinner (U+2800–U+28FF — legacy claude, kept for back-compat)
// means busy; ✳ (U+2733) means idle/done. The title is far more stable to
// parse than the TUI body, so this is the robust signal (see SPEC §11).
//
// The glyph set is an upstream contract claude can silently change (#343 —
// braille → quadrant circles killed every busy indicator with green tests).
// An unrecognized non-ASCII leading glyph therefore still reads as idle
// (fail-safe) but is surfaced via the detector's onUnknownGlyph callback so
// the next change shows up as a diagnostic instead of a dead indicator.
//
// Note this is busy-vs-idle, NOT "needs your input" — claude renders an
// AskUserQuestion/permission prompt without a distinct title glyph (it reads
// as idle), and those never reach the JSONL, so a true needs-input signal
// isn't available. Busy/idle is what's reliably detectable.

const OSC_TITLE = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// Cap the carry-over buffer: titles are short, so this only needs to span a
// sequence split across two chunks, never accumulate real output.
const BUF_CAP = 512;

const IDLE_GLYPH = 0x2733; // ✳

function leadCodePoint(title: string): number {
  const ch = [...title.trim()][0];
  return ch ? (ch.codePointAt(0) ?? 0) : 0;
}

/** True when the title's leading glyph is a spinner frame (quadrant circle or legacy braille). */
export function isBusyTitle(title: string): boolean {
  const cp = leadCodePoint(title);
  return (cp >= 0x25d0 && cp <= 0x25d3) || (cp >= 0x2800 && cp <= 0x28ff);
}

/**
 * True when the leading glyph is non-ASCII but neither a known spinner frame
 * nor the ✳ idle marker — i.e. claude likely changed its title glyphs again.
 */
export function isUnknownTitleGlyph(title: string): boolean {
  const cp = leadCodePoint(title);
  return cp > 0x7f && cp !== IDLE_GLYPH && !isBusyTitle(title);
}

/**
 * Stateful per-session detector. Feed PTY output chunks via `push`; it returns
 * true only when the busy/idle state actually flips, so callers can fire a
 * change event without debouncing every chunk. `onUnknownGlyph` (if given)
 * fires at most once per detector with the first unrecognized title seen.
 */
export class ActivityDetector {
  private buf = '';
  private busy = false;
  private reportedUnknown = false;

  constructor(private onUnknownGlyph?: (title: string) => void) {}

  push(chunk: string): boolean {
    this.buf += chunk;
    if (this.buf.length > BUF_CAP) this.buf = this.buf.slice(-BUF_CAP);
    let m: RegExpExecArray | null;
    let lastTitle: string | null = null;
    OSC_TITLE.lastIndex = 0;
    while ((m = OSC_TITLE.exec(this.buf)) !== null) lastTitle = m[1];
    if (lastTitle === null) return false;
    if (!this.reportedUnknown && this.onUnknownGlyph && isUnknownTitleGlyph(lastTitle)) {
      this.reportedUnknown = true;
      this.onUnknownGlyph(lastTitle.trim());
    }
    const next = isBusyTitle(lastTitle);
    if (next === this.busy) return false;
    this.busy = next;
    return true;
  }

  get isBusy(): boolean {
    return this.busy;
  }
}
