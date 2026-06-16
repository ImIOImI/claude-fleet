import { describe, it, expect } from 'vitest';
import { ActivityDetector, isBusyTitle } from './activityDetector';

const BUSY = '\x1b]0;⠂ Calculate basic arithmetic\x07';
const IDLE = '\x1b]0;✳ Calculate basic arithmetic\x07';
const IDLE0 = '\x1b]0;✳ Claude Code\x07';

describe('isBusyTitle', () => {
  it('braille spinner glyph → busy', () => {
    expect(isBusyTitle('⠂ working')).toBe(true);
    expect(isBusyTitle('⠐ working')).toBe(true);
  });
  it('✳ or plain text → idle', () => {
    expect(isBusyTitle('✳ Claude Code')).toBe(false);
    expect(isBusyTitle('Claude Code')).toBe(false);
    expect(isBusyTitle('')).toBe(false);
  });
});

describe('ActivityDetector', () => {
  it('flips to busy on a spinner title, back to idle on ✳', () => {
    const d = new ActivityDetector();
    expect(d.push(IDLE0)).toBe(false); // starts idle, idle title → no change
    expect(d.isBusy).toBe(false);
    expect(d.push('some output' + BUSY + 'more')).toBe(true); // → busy
    expect(d.isBusy).toBe(true);
    expect(d.push('still working' + BUSY)).toBe(false); // stays busy → no change
    expect(d.push(IDLE)).toBe(true); // → idle
    expect(d.isBusy).toBe(false);
  });

  it('uses the LAST title in a chunk that has several', () => {
    const d = new ActivityDetector();
    expect(d.push(BUSY + IDLE)).toBe(false); // net result idle, from idle start → no flip
    expect(d.isBusy).toBe(false);
    const d2 = new ActivityDetector();
    expect(d2.push(IDLE + BUSY)).toBe(true); // ends busy
    expect(d2.isBusy).toBe(true);
  });

  it('handles a title split across two chunks', () => {
    const d = new ActivityDetector();
    expect(d.push('\x1b]0;⠂ Cal')).toBe(false); // incomplete OSC, no terminator yet
    expect(d.isBusy).toBe(false);
    expect(d.push('culating\x07')).toBe(true); // completes → busy
    expect(d.isBusy).toBe(true);
  });

  it('ignores ordinary output with no title', () => {
    const d = new ActivityDetector();
    expect(d.push('just some terminal text\r\n$ ')).toBe(false);
    expect(d.isBusy).toBe(false);
  });
});
