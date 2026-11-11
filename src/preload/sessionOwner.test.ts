import { describe, expect, it } from 'vitest';
import { githubAvatarUrl, isMine, ownerLabel, ownerName, parseSessionOwner, type SessionOwner } from './sessionOwner';

const W = '01JC0000000000000000000000';
const AV = 'https://avatars.githubusercontent.com/u/7?v=4';
const ann: SessionOwner = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: 'Ann', avatarUrl: AV };

describe('githubAvatarUrl', () => {
  it('passes only GitHub avatar URLs', () => {
    expect(githubAvatarUrl(AV)).toBe(AV);
    expect(githubAvatarUrl('https://avatars.githubusercontent.com/u/7')).toBe('https://avatars.githubusercontent.com/u/7');
    for (const bad of [
      'http://avatars.githubusercontent.com/u/7',
      'https://avatars.githubusercontent.com.evil.io/u/7',
      'https://evil.io/u/7',
      'https://x@avatars.githubusercontent.com/u/7',
      'https://avatars.githubusercontent.com:444/u/7',
      'https://avatars.githubusercontent.com/u/7?v=4&s=1',
      'https://avatars.githubusercontent.com/u/../x',
      'https://avatars.githubusercontent.com/u/0',
      'javascript:alert(1)',
      7,
      null
    ]) {
      expect(githubAvatarUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('ownerName', () => {
  it('one line, no controls or bidi overrides, capped; blank is null', () => {
    expect(ownerName(' Ann‮\n Example ')).toBe('Ann Example');
    expect(ownerName('x'.repeat(100))).toBe('x'.repeat(64));
    expect(ownerName(' ​ ')).toBeNull();
    expect(ownerName(7)).toBeNull();
    expect(ownerName(null)).toBeNull();
  });

  it('C1 and line/paragraph separators become a space; format characters vanish', () => {
    expect(ownerName('A\u0085B')).toBe('A B');
    expect(ownerName('A\u009bB')).toBe('A B');
    expect(ownerName('A\u2028B\u2029C')).toBe('A B C');
    expect(ownerName('a\u200db')).toBe('ab');
    expect(ownerName('a\u00adb\u2066c')).toBe('abc');
    for (const s of ['A\u0085B', 'A\u009bB', 'x\u0080\u009fy']) expect(ownerName(s)).not.toMatch(/[\u0080-\u009f]/);
  });

  it('NFC, capped by code point: an emoji at the boundary stays whole', () => {
    expect(ownerName('Zoe\u0301')).toBe('Zo\u00e9');
    const s = ownerName(`${'x'.repeat(63)}\u{1F600}tail`)!;
    expect(s).toBe(`${'x'.repeat(63)}\u{1F600}`);
    expect(s).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(Array.from(ownerName('a\u{1F600}'.repeat(50))!)).toHaveLength(64);
  });

  it('a name with no letter or digit is null', () => {
    for (const s of ['\u3164', '\u3164\u3164', '\u2800', '   ', '\u115f\u1160\uffa0', '\u0301', '-.-']) expect(ownerName(s), JSON.stringify(s)).toBeNull();
  });
});

describe('parseSessionOwner', () => {
  it('accepts people, bots, automation runs and publishers, dropping extra fields', () => {
    expect(parseSessionOwner({ ...ann, extra: 'x' })).toEqual(ann);
    expect(parseSessionOwner({ kind: 'machine', provider: 'github', id: '9', login: 'acme-reviewer[bot]', name: null, avatarUrl: null }))
      .toEqual({ kind: 'machine', provider: 'github', id: '9', login: 'acme-reviewer[bot]', name: null, avatarUrl: null });
    expect(parseSessionOwner({ kind: 'automation', provider: 'fleet-host', id: W, login: 'automation', name: 'x', avatarUrl: AV }))
      .toEqual({ kind: 'automation', provider: 'fleet-host', id: W, login: 'automation', name: null, avatarUrl: null });
    expect(parseSessionOwner({ ...ann, kind: 'publisher', name: null, avatarUrl: null })).toEqual({ ...ann, kind: 'publisher', name: null, avatarUrl: null });
  });

  it('normalizes text and drops an off-host avatar', () => {
    expect(parseSessionOwner({ ...ann, name: '<b>Ann</b>‮', avatarUrl: 'https://evil.io/a.png' }))
      .toEqual({ ...ann, name: '<b>Ann</b>', avatarUrl: null });
  });

  it('refuses anything else', () => {
    for (const bad of [
      null, 'ann', [], {},
      { ...ann, kind: 'admin' },
      { ...ann, provider: 'gitlab' },
      { ...ann, id: 7 },
      { ...ann, id: '0' },
      { ...ann, id: '1'.repeat(21) },
      { ...ann, login: '-ann' },
      { ...ann, login: 'a'.repeat(40) },
      { ...ann, login: 'ann smith' },
      { ...ann, login: 'ann[bot]' },
      { kind: 'automation', provider: 'github', id: W, login: 'automation' },
      { kind: 'automation', provider: 'fleet-host', id: '7', login: 'automation' },
      { kind: 'automation', provider: 'fleet-host', id: W, login: 'ann' }
    ]) {
      expect(parseSessionOwner(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('isMine / ownerLabel', () => {
  it('mine is a GitHub person with the signed-in account id', () => {
    const me = { provider: 'github', id: 7 };
    expect(isMine(ann, me)).toBe(true);
    expect(isMine({ ...ann, id: '8' }, me)).toBe(false);
    expect(isMine(ann, { provider: 'gitlab', id: 7 })).toBe(false);
    expect(isMine({ ...ann, kind: 'machine' }, me)).toBe(false);
    expect(isMine({ ...ann, kind: 'publisher' }, me)).toBe(false);
    expect(isMine(ann, null)).toBe(false);
    expect(isMine(null, me)).toBe(false);
    expect(isMine(undefined, me)).toBe(false);
  });

  it('labels: the name, else @login; automation runs read "automation"', () => {
    expect(ownerLabel(ann)).toBe('Ann');
    expect(ownerLabel({ ...ann, name: null })).toBe('@ann');
    expect(ownerLabel({ kind: 'automation', provider: 'fleet-host', id: W, login: 'automation', name: null, avatarUrl: null })).toBe('automation');
  });
});
