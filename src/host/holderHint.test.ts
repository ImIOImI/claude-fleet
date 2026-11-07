import { describe, expect, it } from 'vitest';
import { trailingHint } from './holder.js';

describe('trailingHint', () => {
  it('fires once per quiet window and not after stop', () => {
    const timers: Array<() => void> = [];
    let fired = 0;
    const h = trailingHint(() => fired++, 2_000, (fn) => { timers.push(fn); return () => undefined; });
    h.bump(); h.bump(); h.bump();
    expect(timers).toHaveLength(1);
    timers.shift()!();
    expect(fired).toBe(1);
    h.bump();
    h.stop();
    timers.shift()?.();
    expect(fired).toBe(1);
  });
});
