// Pure decision logic for the terminal's custom key handling (copy/paste).
//
// xterm's `attachCustomKeyEventHandler` takes an event and returns a boolean:
// `true` lets xterm process the key normally, `false` tells xterm to ignore it.
// Returning `false` does NOT, however, call `preventDefault()` on the keydown —
// so the browser still performs the native action. For Ctrl+V that native
// action is a `paste` event delivered to xterm's hidden helper textarea, whose
// own paste handler writes the clipboard to the PTY a SECOND time (#150). The
// custom handler must therefore signal when the browser default has to be
// suppressed, not just whether xterm should process the key.
//
// Kept as a pure function (no xterm / DOM deps) so the decision is unit-tested
// directly, matching the repo's "test the pure chokepoint" pattern.

/** The minimal slice of a KeyboardEvent this decision needs. */
export interface TerminalKeyEvent {
  type: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface TerminalKeyAction {
  /** Value to return to xterm: true ⇒ xterm processes the key; false ⇒ it ignores it. */
  pass: boolean;
  /** Whether the handler must call `e.preventDefault()` to stop the browser's
   *  native action (the load-bearing bit for paste: without it the native
   *  `paste` event double-writes the clipboard). */
  preventDefault: boolean;
  /** Side effect the handler should perform itself. */
  effect: 'copy' | 'paste' | null;
}

const PASS_THROUGH: TerminalKeyAction = { pass: true, preventDefault: false, effect: null };

/**
 * Decide how the terminal should handle a key event.
 *
 * @param e            the keyboard event (only the fields in TerminalKeyEvent are read)
 * @param hasSelection whether the terminal currently has a text selection (governs Ctrl+C:
 *                     copy when there's a selection, otherwise pass through as SIGINT)
 */
export function decideTerminalKeyAction(
  e: TerminalKeyEvent,
  hasSelection: boolean
): TerminalKeyAction {
  if (e.type !== 'keydown') return PASS_THROUGH;

  const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
  const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;

  if (plainCtrl && e.code === 'KeyC') {
    if (hasSelection) return { pass: false, preventDefault: false, effect: 'copy' };
    return PASS_THROUGH; // no selection — let Ctrl+C through as SIGINT
  }
  if (plainCtrl && e.code === 'KeyV') {
    // preventDefault is load-bearing: it stops the browser's native paste from
    // also reaching xterm's textarea and double-writing the clipboard (#150).
    return { pass: false, preventDefault: true, effect: 'paste' };
  }
  if (ctrlShift && e.code === 'KeyC') {
    return { pass: false, preventDefault: false, effect: 'copy' };
  }
  if (ctrlShift && e.code === 'KeyV') {
    return { pass: false, preventDefault: true, effect: 'paste' };
  }
  return PASS_THROUGH;
}
