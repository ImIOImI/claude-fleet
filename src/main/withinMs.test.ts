import { describe, expect, it } from 'vitest';
import { withinMs } from './withinMs.js';

describe('withinMs', () => {
  it('is done when the work settles first, rejected or not', async () => {
    expect(await withinMs(Promise.resolve(1), 1000)).toBe('done');
    expect(await withinMs(Promise.reject(new Error('x')), 1000)).toBe('done');
  });

  it('times out when the work never settles', async () => {
    expect(await withinMs(new Promise(() => undefined), 10)).toBe('timeout');
  });
});
