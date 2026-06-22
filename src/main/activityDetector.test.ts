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
});
