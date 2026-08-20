// Main-process ActivityDetector (#121) — same parser as the renderer twin,
// re-tested here since the two copies must stay behavior-identical.

import { describe, expect, it, vi } from 'vitest';
import { ActivityDetector, isBusyTitle, isUnknownTitleGlyph } from './activityDetector.js';

// Real titles captured from a live claude PTY (#343): busy = quadrant circles
// ◐/◑ (U+25D0/U+25D1), idle = ✳ (U+2733). Braille is the legacy spinner.
const BUSY = '◐';
const BUSY_LEGACY = '⠂';
const IDLE = '✳';

describe('isBusyTitle', () => {
  it('treats leading quadrant-circle or braille glyphs as busy, anything else as idle', () => {
    expect(isBusyTitle(`${BUSY} working`)).toBe(true);
    expect(isBusyTitle('◑ Reply with ok')).toBe(true);
    expect(isBusyTitle('◒ working')).toBe(true);
    expect(isBusyTitle('◓ working')).toBe(true);
    expect(isBusyTitle(`${BUSY_LEGACY} working`)).toBe(true);
    expect(isBusyTitle(`${IDLE} done`)).toBe(false);
    expect(isBusyTitle('✦ unknown glyph')).toBe(false);
    expect(isBusyTitle('')).toBe(false);
  });
});

describe('isUnknownTitleGlyph', () => {
  it('flags only unrecognized non-ASCII leading glyphs', () => {
    expect(isUnknownTitleGlyph(`${BUSY} working`)).toBe(false);
    expect(isUnknownTitleGlyph(`${BUSY_LEGACY} working`)).toBe(false);
    expect(isUnknownTitleGlyph(`${IDLE} done`)).toBe(false);
    expect(isUnknownTitleGlyph('Claude Code')).toBe(false);
    expect(isUnknownTitleGlyph('✦ unknown glyph')).toBe(true);
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
    expect(d.push(osc(`◑ still thinking`))).toBe(false); // still busy
    expect(d.push(osc(`${IDLE} done`))).toBe(true); // busy → idle
    expect(d.isBusy).toBe(false);
  });

  it('still flips on the legacy braille spinner', () => {
    const d = new ActivityDetector();
    expect(d.push(osc(`${BUSY_LEGACY} thinking`))).toBe(true);
    expect(d.isBusy).toBe(true);
  });

  it('uses the LAST title in a chunk', () => {
    const d = new ActivityDetector();
    expect(d.push(osc(`${BUSY} a`) + osc(`${IDLE} b`))).toBe(false); // ends idle = no flip from idle
    expect(d.isBusy).toBe(false);
  });

  it('reports an unknown title glyph at most once per detector', () => {
    const onUnknown = vi.fn();
    const d = new ActivityDetector(onUnknown);
    d.push(osc('✦ Mystery glyph'));
    d.push(osc('✦ Mystery glyph again'));
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(onUnknown).toHaveBeenCalledWith('✦ Mystery glyph');
    d.push(osc(`${IDLE} done`));
    expect(onUnknown).toHaveBeenCalledTimes(1); // known glyphs never fire it
  });
});
