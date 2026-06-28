import { describe, it, expect } from 'vitest';
import { decideTerminalKeyAction, type TerminalKeyEvent } from './terminalKeymap';

// Build a keydown event with the given code and modifiers (ctrl-only by default).
function key(code: string, mods: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent {
  return {
    type: 'keydown',
    code,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods
  };
}

describe('decideTerminalKeyAction', () => {
  // #150: the regression guard. Returning false to xterm is not enough — the
  // handler must ALSO preventDefault, or the browser's native paste fires and
  // xterm's textarea writes the clipboard to the PTY a second time.
  it('Ctrl+V pastes once: consumes the key AND suppresses the native paste', () => {
    const a = decideTerminalKeyAction(key('KeyV'), false);
    expect(a.effect).toBe('paste');
    expect(a.pass).toBe(false); // xterm must not process it
    expect(a.preventDefault).toBe(true); // and the browser default must be suppressed
  });

  it('Ctrl+Shift+V also pastes once with the native default suppressed', () => {
    const a = decideTerminalKeyAction(key('KeyV', { shiftKey: true }), false);
    expect(a.effect).toBe('paste');
    expect(a.pass).toBe(false);
    expect(a.preventDefault).toBe(true);
  });

  it('Ctrl+C copies when there is a selection', () => {
    const a = decideTerminalKeyAction(key('KeyC'), true);
    expect(a.effect).toBe('copy');
    expect(a.pass).toBe(false);
  });

  it('Ctrl+C passes through as SIGINT when there is no selection', () => {
    const a = decideTerminalKeyAction(key('KeyC'), false);
    expect(a.effect).toBeNull();
    expect(a.pass).toBe(true);
    expect(a.preventDefault).toBe(false);
  });

  it('non-keydown events pass straight through', () => {
    const a = decideTerminalKeyAction(key('KeyV', { type: 'keyup' }), false);
    expect(a).toEqual({ pass: true, preventDefault: false, effect: null });
  });

  it('unrelated keys pass through to xterm', () => {
    const a = decideTerminalKeyAction(key('KeyA'), false);
    expect(a.pass).toBe(true);
    expect(a.effect).toBeNull();
  });
});
