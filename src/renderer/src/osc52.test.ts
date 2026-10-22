import { describe, it, expect } from 'vitest';
import { decodeOsc52, OSC52_MAX_BASE64 } from './osc52';

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

describe('decodeOsc52', () => {
  it('decodes a clipboard write', () => {
    expect(decodeOsc52(`c;${b64('hello world')}`)).toBe('hello world');
  });

  it('accepts an empty or multi-target selector', () => {
    expect(decodeOsc52(`;${b64('a')}`)).toBe('a');
    expect(decodeOsc52(`cp;${b64('b')}`)).toBe('b');
  });

  it('decodes multi-byte UTF-8 and keeps newlines', () => {
    expect(decodeOsc52(`c;${b64('héllo ✳\nline 2')}`)).toBe('héllo ✳\nline 2');
  });

  it('ignores a read query so the host clipboard never leaks', () => {
    expect(decodeOsc52('c;?')).toBeNull();
  });

  it('ignores malformed payloads', () => {
    expect(decodeOsc52('no-separator')).toBeNull();
    expect(decodeOsc52('c;')).toBeNull();
    expect(decodeOsc52('c;not base64!')).toBeNull();
    // valid base64, invalid UTF-8 (lone 0xff byte)
    expect(decodeOsc52('c;/w==')).toBeNull();
  });

  it('ignores an oversized payload', () => {
    expect(decodeOsc52(`c;${'A'.repeat(OSC52_MAX_BASE64 + 4)}`)).toBeNull();
  });
});
