import { describe, expect, it } from 'vitest';
import { ECHO_WINDOW_MS, EchoRttTracker } from './echoRtt.js';

describe('EchoRttTracker', () => {
  it('closes a pending keystroke on the next output within the window', () => {
    const t = new EchoRttTracker();
    t.keystroke(1000);
    expect(t.output(1080)).toEqual([80]);
  });

  it('one output closes ALL pending keystrokes, oldest first', () => {
    const t = new EchoRttTracker();
    t.keystroke(1000);
    t.keystroke(1030);
    expect(t.output(1100)).toEqual([100, 70]);
    // Consumed: a second output produces no further samples.
    expect(t.output(1200)).toEqual([]);
  });

  it('drops keystrokes older than ECHO_WINDOW_MS instead of sampling them', () => {
    const t = new EchoRttTracker();
    t.keystroke(1000);
    t.keystroke(2500);
    expect(t.output(1000 + ECHO_WINDOW_MS + 1)).toEqual([501]); // only the 2500 keystroke closes
  });

  it('output with nothing pending returns an empty array', () => {
    expect(new EchoRttTracker().output(1234)).toEqual([]);
  });

  it('caps pending keystrokes so paste storms cannot grow unbounded', () => {
    const t = new EchoRttTracker();
    for (let i = 0; i < 5000; i += 1) t.keystroke(1000 + i);
    expect(t.output(6100).length).toBeLessThanOrEqual(256);
  });
});
