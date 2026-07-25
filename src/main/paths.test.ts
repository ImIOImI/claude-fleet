import { describe, it, expect } from 'vitest';
import { encodeClaudeProjectDir } from './paths.js';

describe('encodeClaudeProjectDir', () => {
  // Anchor: the container cwd '/workspace' is known to encode as '-workspace'.
  it('encodes an absolute path by replacing non-alphanumerics with dashes', () => {
    expect(encodeClaudeProjectDir('/workspace')).toBe('-workspace');
    expect(encodeClaudeProjectDir('/home/amber/my-proj')).toBe('-home-amber-my-proj');
    expect(encodeClaudeProjectDir('/home/amber/my.proj')).toBe('-home-amber-my-proj');
  });
});
