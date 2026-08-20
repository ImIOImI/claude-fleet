import { describe, it, expect, vi } from 'vitest';
import { ActivityDetector, isBusyTitle, isUnknownTitleGlyph } from './activityDetector';

// Real titles captured from a live claude PTY (#343): busy = quadrant circles
// ◐/◑ (U+25D0/U+25D1), idle = ✳ (U+2733). Braille (U+2800–U+28FF) is the
// legacy spinner claude no longer emits, kept for back-compat.
const BUSY = '\x1b]0;◐ Reply with ok\x07';
const BUSY2 = '\x1b]0;◑ Reply with ok\x07';
const IDLE = '\x1b]0;✳ Reply with ok\x07';
const IDLE0 = '\x1b]0;✳ Claude Code\x07';

describe('isBusyTitle', () => {
  it('quadrant-circle spinner glyphs (current claude) → busy', () => {
    expect(isBusyTitle('◐ Claude Code')).toBe(true);
    expect(isBusyTitle('◑ Reply with ok')).toBe(true);
    expect(isBusyTitle('◒ working')).toBe(true);
    expect(isBusyTitle('◓ working')).toBe(true);
  });
  it('braille spinner glyph (legacy claude) → busy', () => {
    expect(isBusyTitle('⠂ working')).toBe(true);
    expect(isBusyTitle('⠐ working')).toBe(true);
  });
  it('✳ or plain text → idle', () => {
    expect(isBusyTitle('✳ Claude Code')).toBe(false);
    expect(isBusyTitle('Claude Code')).toBe(false);
    expect(isBusyTitle('')).toBe(false);
  });
  it('unknown non-ASCII glyph → idle (fail-safe)', () => {
    expect(isBusyTitle('✦ Claude Code')).toBe(false);
  });
});

describe('isUnknownTitleGlyph', () => {
  it('recognized glyphs and plain text are not unknown', () => {
    expect(isUnknownTitleGlyph('◐ Reply with ok')).toBe(false);
    expect(isUnknownTitleGlyph('⠂ working')).toBe(false);
    expect(isUnknownTitleGlyph('✳ Claude Code')).toBe(false);
    expect(isUnknownTitleGlyph('Claude Code')).toBe(false);
    expect(isUnknownTitleGlyph('')).toBe(false);
  });
  it('an unrecognized non-ASCII leading glyph is unknown', () => {
    expect(isUnknownTitleGlyph('✦ Claude Code')).toBe(true);
  });
});

describe('ActivityDetector', () => {
  it('flips to busy on a spinner title, back to idle on ✳', () => {
    const d = new ActivityDetector();
    expect(d.push(IDLE0)).toBe(false); // starts idle, idle title → no change
    expect(d.isBusy).toBe(false);
    expect(d.push('some output' + BUSY + 'more')).toBe(true); // → busy
    expect(d.isBusy).toBe(true);
    expect(d.push('still working' + BUSY2)).toBe(false); // stays busy → no change
    expect(d.push(IDLE)).toBe(true); // → idle
    expect(d.isBusy).toBe(false);
  });

  it('still flips to busy on a legacy braille title', () => {
    const d = new ActivityDetector();
    expect(d.push('\x1b]0;⠂ Calculating\x07')).toBe(true);
    expect(d.isBusy).toBe(true);
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
    expect(d.push('\x1b]0;◐ Cal')).toBe(false); // incomplete OSC, no terminator yet
    expect(d.isBusy).toBe(false);
    expect(d.push('culating\x07')).toBe(true); // completes → busy
    expect(d.isBusy).toBe(true);
  });

  it('ignores ordinary output with no title', () => {
    const d = new ActivityDetector();
    expect(d.push('just some terminal text\r\n$ ')).toBe(false);
    expect(d.isBusy).toBe(false);
  });

  it('reports an unknown title glyph at most once per detector', () => {
    const onUnknown = vi.fn();
    const d = new ActivityDetector(onUnknown);
    d.push('\x1b]0;✦ Mystery glyph\x07');
    d.push('\x1b]0;✦ Mystery glyph again\x07');
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(onUnknown).toHaveBeenCalledWith('✦ Mystery glyph');
    d.push(IDLE);
    expect(onUnknown).toHaveBeenCalledTimes(1); // known glyphs never fire it
  });
});
