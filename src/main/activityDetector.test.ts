// Main-process ActivityDetector (#121) — same parser as the renderer twin,
// re-tested here since the two copies must stay behavior-identical.

import { describe, expect, it } from 'vitest';
import { ActivityDetector, isBusyTitle } from './activityDetector.js';

const BUSY = '⠂'; // braille spinner frame ⠂
const IDLE = '✳';

describe('isBusyTitle', () => {
  it('treats a leading braille glyph as busy, anything else as idle', () => {
    expect(isBusyTitle(`${BUSY} working`)).toBe(true);
    expect(isBusyTitle(`${IDLE} done`)).toBe(false);
    expect(isBusyTitle('')).toBe(false);
  });
});

describe('ActivityDetector.push', () => {
  function osc(title: string): string {
    return `\x1b]0;${title}\x07`;
  }

  it('returns true only on a busy↔idle flip', () => {
    const d = new ActivityDetector();
    expect(d.push('plain output, no title')).toBe(false);
    expect(d.push(osc(`${BUSY} thinking`))).toBe(true); // idle → busy
    expect(d.isBusy).toBe(true);
    expect(d.push(osc(`${BUSY} still thinking`))).toBe(false); // still busy
    expect(d.push(osc(`${IDLE} done`))).toBe(true); // busy → idle
    expect(d.isBusy).toBe(false);
  });

  it('uses the LAST title in a chunk', () => {
    const d = new ActivityDetector();
    expect(d.push(osc(`${BUSY} a`) + osc(`${IDLE} b`))).toBe(false); // ends idle = no flip from idle
    expect(d.isBusy).toBe(false);
  });

  // Regression for #283: push() used to trim the buffer to its last 512 bytes
  // BEFORE scanning, so a title followed in the SAME chunk by ≥ ~500 bytes
  // (a full-screen repaint is several KB) was discarded unseen. Busy re-asserts
  // every spinner frame, idle is written once — so a swallowed idle edge stuck
  // committee_status on busy permanently. Boundary cases straddle the old cap.
  it('sees the idle title no matter how many bytes follow it in the same chunk', () => {
    for (const trailing of [0, 490, 511, 512, 600, 4096, 40000]) {
      const d = new ActivityDetector();
      expect(d.push(osc(`${BUSY} working`))).toBe(true); // arm: busy
      expect(d.push(osc(`${IDLE} done`) + 'x'.repeat(trailing)), `trailing=${trailing}`).toBe(
        true
      );
      expect(d.isBusy, `trailing=${trailing}`).toBe(false);
    }
  });

  it('sees a busy title buried in a large chunk (never goes blind)', () => {
    const d = new ActivityDetector();
    expect(d.push(osc(`${BUSY} working`) + 'x'.repeat(40000))).toBe(true);
    expect(d.isBusy).toBe(true);
  });
});
