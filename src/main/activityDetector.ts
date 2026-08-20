// Main-process twin of `src/renderer/src/activityDetector.ts` (#121). Detects
// whether a claude session is busy vs idle by watching its PTY output for the
// terminal-title OSC sequence `ESC ] 0 ; <glyph> <text> BEL`; a leading
// quadrant-circle spinner glyph (U+25D0–U+25D3, current claude) or braille
// spinner glyph (U+2800–U+28FF, legacy) means busy; ✳ (U+2733) means idle.
// The renderer runs this for the chip indicator, but the committee runs
// unattended and must not depend on renderer React state — so main taps the
// same broker output stream and scans it here.
//
// The glyph set is an upstream contract claude can silently change (#343) —
// unrecognized non-ASCII leading glyphs read as idle (fail-safe) but are
// surfaced once per detector via the onUnknownGlyph callback.
//
// Kept as a separate copy (not shared) because the main + renderer tsconfigs
// are disjoint (`src/main` vs `src/renderer/src`). The logic is pure + stable;
// the renderer twin carries the same parser and its own test. Keep them in
// sync. Known limitation (SPEC §11): idle ≈ "done OR waiting on a permission
// prompt" — the glyph can't tell them apart.

const OSC_TITLE = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
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
