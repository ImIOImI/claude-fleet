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

  // Regression for #283: push() used to trim the buffer to its last 512 bytes
  // BEFORE scanning, so a title with enough bytes behind it in the SAME chunk
  // (a full-screen repaint at 206×79 is several KB) was discarded unseen.
  // Claude re-asserts the spinner title every frame but writes the idle title
  // exactly once, so every swallowed edge biased toward a permanently stuck
  // "working…". The boundary cases here straddle the old BUF_CAP.
  it('sees the idle title no matter how many bytes follow it in the same chunk', () => {
    for (const trailing of [0, 490, 511, 512, 600, 4096, 40000]) {
      const d = new ActivityDetector();
      expect(d.push(BUSY)).toBe(true); // arm: busy
      expect(d.push(IDLE + 'x'.repeat(trailing)), `trailing=${trailing}`).toBe(true);
      expect(d.isBusy, `trailing=${trailing}`).toBe(false);
    }
  });

  it('sees a busy title buried in a large chunk (never goes blind)', () => {
    const d = new ActivityDetector();
    expect(d.push(BUSY + 'x'.repeat(40000))).toBe(true);
    expect(d.isBusy).toBe(true);
  });

  it('still tracks a split title after large-chunk trims', () => {
    const d = new ActivityDetector();
    d.push(BUSY + 'x'.repeat(40000)); // busy, buffer trimmed
    expect(d.push('\x1b]0;✳ Cal')).toBe(false); // incomplete OSC carries over
    expect(d.push('culating\x07')).toBe(true); // completes → idle
    expect(d.isBusy).toBe(false);
  });
});
