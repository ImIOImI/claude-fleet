import { describe, it, expect, vi } from 'vitest';
import { PASTE_START, PASTE_END, SUBMIT_DELAY_MS, injectAndSubmit } from './ptyInput.js';

describe('injectAndSubmit', () => {
  it('writes the message as a bracketed paste, then a separate CR to submit', async () => {
    const writes: string[] = [];
    await injectAndSubmit((chunk) => writes.push(chunk), 'hello world');
    expect(writes).toEqual([`${PASTE_START}hello world${PASTE_END}`, '\r']);
  });

  it('sends the payload before the submit keystroke (two distinct writes)', async () => {
    const writes: string[] = [];
    await injectAndSubmit((chunk) => writes.push(chunk), 'x');
    // The CR must be its own write — a single "text\r" chunk is what the
    // TUI mis-reads as a paste and never submits (the bug this fixes).
    expect(writes).toHaveLength(2);
    expect(writes[0]).not.toContain('\r');
    expect(writes[1]).toBe('\r');
  });

  it('preserves multi-line messages inside the paste wrapper', async () => {
    const writes: string[] = [];
    await injectAndSubmit((chunk) => writes.push(chunk), 'line one\nline two');
    expect(writes[0]).toBe(`${PASTE_START}line one\nline two${PASTE_END}`);
    expect(writes[1]).toBe('\r');
  });

  it('delays between paste and submit so the TUI registers a discrete keypress', async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const p = injectAndSubmit((chunk) => writes.push(chunk), 'q');
      // Paste lands synchronously; CR is deferred until the delay elapses.
      expect(writes).toEqual([`${PASTE_START}q${PASTE_END}`]);
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      await p;
      expect(writes).toEqual([`${PASTE_START}q${PASTE_END}`, '\r']);
    } finally {
      vi.useRealTimers();
    }
  });
});
