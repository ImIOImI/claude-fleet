import { describe, expect, it } from 'vitest';
import { isValidGithubClientId, resolveGithubClientId } from './githubClientId';

describe('isValidGithubClientId', () => {
  it.each(['Iv1.0123456789abcdef', 'Ov23liAbCdEfGh123456', 'a', 'x'.repeat(100), 'a_b-c.d'])('accepts %s', (v) => {
    expect(isValidGithubClientId(v)).toBe(true);
  });

  it.each(['', 'x'.repeat(101), 'has space', 'Iv1/abc', 'Iv1.abc!', 'ü', ' Iv1.abc', 'Iv1.abc\n'])('rejects %j', (v) => {
    expect(isValidGithubClientId(v)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 42, {}, ['Iv1.abc']]) expect(isValidGithubClientId(v)).toBe(false);
  });
});

describe('resolveGithubClientId', () => {
  it('prefers env, then config, then the built-in, and reports the source', () => {
    expect(resolveGithubClientId({ env: 'Iv1.env', config: 'Iv1.cfg', builtin: 'Iv1.bi' })).toEqual({ value: 'Iv1.env', source: 'env' });
    expect(resolveGithubClientId({ env: '', config: 'Iv1.cfg', builtin: 'Iv1.bi' })).toEqual({ value: 'Iv1.cfg', source: 'config' });
    expect(resolveGithubClientId({ env: undefined, config: null, builtin: 'Iv1.bi' })).toEqual({ value: 'Iv1.bi', source: 'builtin' });
    expect(resolveGithubClientId({ env: undefined, config: null, builtin: '' })).toEqual({ value: null, source: 'none' });
  });

  it('trims, and skips a malformed value to the next source', () => {
    expect(resolveGithubClientId({ env: '  Iv1.env ', config: null, builtin: '' })).toEqual({ value: 'Iv1.env', source: 'env' });
    expect(resolveGithubClientId({ env: 'bad value', config: 'Iv1.cfg', builtin: '' })).toEqual({ value: 'Iv1.cfg', source: 'config' });
    expect(resolveGithubClientId({ env: null, config: 'bad value', builtin: 'Iv1.bi' })).toEqual({ value: 'Iv1.bi', source: 'builtin' });
  });
});
