import { describe, it, expect } from 'vitest';
// @ts-expect-error — lines.mjs is a plain ESM script in docker/qwen/, not part of the TS build.
// Vitest resolves .mjs imports at runtime; there is no @types stub.
import { nextLines } from '../../docker/qwen/lines.mjs';

describe('nextLines', () => {
  it('returns only complete lines and the new offset', () => {
    const buf = 'a\nb\nhalf';
    const { lines, offset } = nextLines(buf);
    expect(lines).toEqual(['a', 'b']);
    expect(offset).toBe(4); // bytes up to and incl. the 2nd \n
  });
  it('yields nothing when no newline yet', () => {
    expect(nextLines('partial').lines).toEqual([]);
  });
});
