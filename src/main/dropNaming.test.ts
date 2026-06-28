import { describe, it, expect } from 'vitest';
import {
  candidateName,
  extFromMime,
  fileStamp,
  filenameFromDisposition,
  sniffExtension,
  splitName
} from './dropNaming.js';

describe('sniffExtension', () => {
  const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);
  it('recognizes PNG / JPEG / GIF / PDF magic numbers', () => {
    expect(sniffExtension(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('.png');
    expect(sniffExtension(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('.jpg');
    expect(sniffExtension(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('.gif');
    expect(sniffExtension(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe('.pdf');
  });
  it('recognizes WEBP (RIFF…WEBP)', () => {
    const b = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
    expect(sniffExtension(b)).toBe('.webp');
  });
  it('returns null for unrecognized / too-short input', () => {
    expect(sniffExtension(bytes(0x00, 0x01, 0x02))).toBeNull();
    expect(sniffExtension(bytes())).toBeNull();
  });
});

describe('extFromMime', () => {
  it('maps known types and tolerates parameters/casing', () => {
    expect(extFromMime('image/png')).toBe('.png');
    expect(extFromMime('image/jpeg')).toBe('.jpg');
    expect(extFromMime('TEXT/HTML; charset=utf-8')).toBe('.html');
  });
  it('returns null for unknown or missing types', () => {
    expect(extFromMime('application/octet-stream')).toBeNull();
    expect(extFromMime(undefined)).toBeNull();
  });
});

describe('splitName / candidateName', () => {
  it('splits stem and extension', () => {
    expect(splitName('foo.png')).toEqual({ stem: 'foo', ext: '.png' });
    expect(splitName('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' });
    expect(splitName('noext')).toEqual({ stem: 'noext', ext: '' });
  });
  it('suffixes collisions: n=1 bare, n>=2 -N', () => {
    expect(candidateName('foo', '.png', 1)).toBe('foo.png');
    expect(candidateName('foo', '.png', 2)).toBe('foo-2.png');
    expect(candidateName('foo', '', 3)).toBe('foo-3');
  });
});

describe('fileStamp', () => {
  it('produces a filesystem-safe stamp (no colons or dots)', () => {
    const s = fileStamp(new Date('2026-06-16T18:50:00.123Z'));
    expect(s).toBe('2026-06-16T18-50-00-123Z');
    expect(s).not.toMatch(/[:.]/);
  });
});

describe('filenameFromDisposition', () => {
  it('parses plain and extended (filename*) forms, stripping paths', () => {
    expect(filenameFromDisposition('attachment; filename="report.pdf"')).toBe('report.pdf');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''na%C3%AFve%20file.png")).toBe(
      'naïve file.png'
    );
    expect(filenameFromDisposition('inline; filename=/etc/passwd')).toBe('passwd');
  });
  it('returns null when absent', () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition('inline')).toBeNull();
  });
});
