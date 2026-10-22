import { describe, it, expect } from 'vitest';
import { linkify } from './linkify';

describe('linkify', () => {
  it('leaves text without links alone', () => {
    expect(linkify('no links here\nsecond line')).toEqual([{ kind: 'text', text: 'no links here\nsecond line' }]);
  });

  it('turns bare http(s) URLs into links, keeping the text around them', () => {
    expect(linkify('PR: https://github.com/o/r/pull/7 now')).toEqual([
      { kind: 'text', text: 'PR: ' },
      { kind: 'link', text: 'https://github.com/o/r/pull/7', href: 'https://github.com/o/r/pull/7' },
      { kind: 'text', text: ' now' }
    ]);
  });

  it('keeps trailing sentence punctuation and unbalanced parens out of the link', () => {
    const segs = linkify('See https://x.test/a. Or (https://x.test/b) or https://x.test/wiki/A_(b).');
    expect(segs.filter((s) => s.kind === 'link').map((s) => s.text)).toEqual(['https://x.test/a', 'https://x.test/b', 'https://x.test/wiki/A_(b)']);
    expect(segs.map((s) => s.text).join('')).toBe('See https://x.test/a. Or (https://x.test/b) or https://x.test/wiki/A_(b).');
  });

  it('renders markdown links with their label', () => {
    expect(linkify('GitHub review: [#5616606686](https://github.com/o/r/pull/7#pullrequestreview-1)')).toEqual([
      { kind: 'text', text: 'GitHub review: ' },
      { kind: 'link', text: '#5616606686', href: 'https://github.com/o/r/pull/7#pullrequestreview-1' }
    ]);
  });

  it('never links other schemes', () => {
    for (const t of ['javascript:alert(1)', '[x](javascript:alert(1))', 'file:///etc/passwd', 'webexteams://im?space=1']) {
      expect(linkify(t).every((s) => s.kind === 'text')).toBe(true);
    }
  });

  it('handles several links on several lines', () => {
    const segs = linkify('a https://a.test\nb [b](https://b.test/x)\n');
    expect(segs.filter((s) => s.kind === 'link').map((s) => s.kind === 'link' && s.href)).toEqual(['https://a.test/', 'https://b.test/x']);
    expect(segs[segs.length - 1]).toEqual({ kind: 'text', text: '\n' });
  });
});
