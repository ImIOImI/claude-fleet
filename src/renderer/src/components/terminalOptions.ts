// The Terminal() construction options for every session pane, extracted from
// TerminalSession.tsx so the reflow regression test (terminalOptions.test.ts)
// exercises the exact options the app runs with — a fix that only lands in a
// test-local options object would prove nothing.

import type { ITerminalOptions } from '@xterm/xterm';

// Stretch the font fallback chain so canvas renders for glyphs xterm
// can't find in a monospace font (emoji, symbols, regional indicators)
// fall through to a system emoji font instead of rendering as tofu. The
// monospace fonts come first so character-grid alignment is preserved
// for the common case; emoji-font glyphs are typically wide and pair
// with the unicode11 width tables loaded in TerminalSession.
const TERMINAL_FONT_FAMILY = [
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  '"DejaVu Sans Mono"',
  'monospace',
  // Bundled @font-face subset (styles.css): crisp Miscellaneous-Technical
  // symbols the host fontconfig set lacks — notably Claude's permission-mode
  // media-control triangles (⏵, U+23F5). Placed before the emoji fonts so a
  // sharp glyph wins over an emoji-style one.
  '"Noto Sans Symbols 2"',
  '"Apple Color Emoji"',
  '"Segoe UI Emoji"',
  '"Noto Color Emoji"',
  '"Segoe UI Symbol"',
  'emoji',
  // Last-resort catch-all (bundled Unifont subset) for glyphs nothing else
  // covers — e.g. the tool-result tree connector ⎿ (U+23BF), which even Noto
  // Sans Symbols 2 lacks. Pixelated, but guarantees no tofu boxes.
  '"Unifont"'
].join(', ');

export function buildTerminalOptions(): ITerminalOptions {
  return {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 13,
    theme: { background: '#101216' },
    cursorBlink: true,
    // MUST stay false (#268). `convertEol` makes xterm treat a bare LF as
    // CRLF. That is right for line-oriented output piped into a terminal, and
    // wrong for a full-screen TUI: claude's Ink renderer positions absolutely
    // and then relies on LF meaning "down one row, same column". Injecting a
    // carriage return moves the cursor to column 0, so a frame that positions
    // to column 3, erases to end of line and emits LF no longer writes where
    // it intended — leaving the previous frame's leading characters stranded
    // in the first columns. That is the stray `Th` / `Co` / `Tw` fragments
    // reported in #268, and it is why they survived every renderer change:
    // the damage happens in the parser, before anything is painted.
    //
    // A real PTY already applies ONLCR on the slave side, so a bare LF that
    // needs a CR has one by the time it reaches us; this option only ever
    // added a second, unwanted one. Verified against two recorded sessions
    // (src/main/ptyCapture.ts): orphan fragments 10 -> 0, with indentation
    // unchanged (no stair-stepping, the failure mode if bare LFs were acting
    // as line separators).
    convertEol: false,
    allowProposedApi: true,
    wordSeparator: ' \t()[]{}\'"<>`',
    // Default is 1, which feels glacial on most trackpads/wheels. 3 is
    // closer to native terminal scroll cadence — a normal wheel notch
    // moves a few lines instead of a single character row.
    scrollSensitivity: 3,
    fastScrollSensitivity: 6,
    // Disable scrollback reflow on resize (#330). Claude's TUI (Ink) paints
    // absolutely-positioned full-width rows, not genuinely wrapped text, so
    // xterm re-wrapping scrollback on a width change splits those rows —
    // orphaned tails ("Re", "Th", "So.") land at column 0 over the transcript
    // and nothing ever repairs them. Trade-off: old scrollback keeps its
    // original wrap points when the terminal is resized (tmux behavior).
    //
    // xterm 5.5 gate specifics (Buffer._isReflowEnabled): `backend` is only
    // consulted when `buildNumber` is TRUTHY — `{ backend: 'winpty' }` alone
    // silently leaves reflow ON. And the "assume wrapped if the last char is
    // non-whitespace" selection heuristic this option is documented to imply
    // is in fact only enabled for conpty < 21376, so this exact value turns
    // reflow off without touching selection/copy of wrapped lines. Pinned by
    // terminalOptions.test.ts.
    windowsPty: { backend: 'winpty', buildNumber: 1 }
  };
}
