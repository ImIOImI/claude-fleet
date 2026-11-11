import { describe, expect, it } from 'vitest';
import { makeScrubber, MIN_SECRET_LEN, type ScrubbedLine } from './scrub.js';

const line = (o: unknown): string => JSON.stringify(o);
const text = (out: string): string => JSON.parse(out).t as string;
// Built at runtime so no literal token sits in the source.
const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: '1234567890', name: 'x' })}.${'s'.repeat(20)}A1_-b`;
const slack = (k: string): string => `xox${k}-${'1'.repeat(11)}-${'2'.repeat(12)}-${'a'.repeat(24)}`;

describe('makeScrubber', () => {
  it('replaces secret values with [redacted:<KEY>], longest first, in nested strings', () => {
    const s = makeScrubber([{ key: 'DB_PASS_PREFIX', value: 'hunter2h' }, { key: 'DB_PASS', value: 'hunter2hunter2' }]);
    const out = JSON.parse(s(line({ type: 'user', message: { content: [{ text: 'pw is hunter2hunter2 ok' }] } })));
    expect(out.message.content[0].text).toBe('pw is [redacted:DB_PASS] ok');
  });

  it('ignores values shorter than MIN_SECRET_LEN', () => {
    const short = 'x'.repeat(MIN_SECRET_LEN - 1);
    expect(makeScrubber([{ key: 'SHORT', value: short }])(line({ t: short }))).toBe(line({ t: short }));
    expect(text(makeScrubber([{ key: 'EIGHT', value: 'yyyyyyyy' }])(line({ t: 'yyyyyyyy' })))).toBe('[redacted:EIGHT]');
  });

  it('finds a value that contains JSON-escaped characters', () => {
    const s = makeScrubber([{ key: 'TOK', value: 'abc"def\\ghi' }]);
    expect(text(s(line({ t: 'x abc"def\\ghi y' })))).toBe('x [redacted:TOK] y');
  });

  it('finds a value in a JSON key, through the escaped-form backstop', () => {
    const s = makeScrubber([{ key: 'TOK', value: 'abc"def\\ghi' }]);
    expect(s(line({ ['abc"def\\ghi']: 1 }))).not.toContain('def');
  });

  it.each([
    ['sk-ant-api03-' + 'a'.repeat(30)],
    ['ghp_' + 'A'.repeat(36)],
    ['gho_' + 'A'.repeat(36)],
    ['ghs_' + 'A'.repeat(36)],
    ['github_pat_' + 'A'.repeat(40)],
    ['AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['ASIA' + 'ABCDEFGHIJKLMNOP'],
    ['Bearer abcdefgh12345678xyz'],
    ...['a', 'b', 'p', 'o', 's', 'r'].map((k) => [slack(k)]),
    [jwt]
  ])('redacts the token shape %s', (secret) => {
    const out = text(makeScrubber([])(line({ t: `before ${secret} after` })));
    expect(out).not.toContain(secret);
    expect(out).toBe('before [redacted] after');
  });

  it('redacts a Slack token or JWT at the start of a line after a newline', () => {
    const out = text(makeScrubber([])(line({ t: `a\n${slack('b')}\n${jwt}` })));
    expect(out).toBe('a\n[redacted]\n[redacted]');
  });

  it.each([['xoxo-hugs-and-kisses'], ['eyJ alone'], ['eyJhbGci.notjwt'], ['flexoxb-123456789012']])('leaves the look-alike %s', (s) => {
    expect(text(makeScrubber([])(line({ t: s })))).toBe(s);
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----';
    expect(text(makeScrubber([])(line({ t: `key: ${pem}` })))).not.toContain('MIIEsecret');
  });

  it('redacts *_KEY / *_TOKEN / *_SECRET / *_PASSWORD assignments, quoted or not', () => {
    const out = text(makeScrubber([])(line({ t: `export OPENAI_API_KEY=abc123 MY_TOKEN="q w" app_secret='x' DB_PASSWORD=p FOO=bar` })));
    expect(out).toBe('export OPENAI_API_KEY=[redacted] MY_TOKEN=[redacted] app_secret=[redacted] DB_PASSWORD=[redacted] FOO=bar');
  });

  it('does not re-redact a value already replaced by its key', () => {
    const s = makeScrubber([{ key: 'MY_TOKEN', value: 'tok-123456789' }]);
    expect(text(s(line({ t: 'MY_TOKEN=tok-123456789' })))).toBe('MY_TOKEN=[redacted:MY_TOKEN]');
  });

  it('leaves a clean line byte-identical and keeps a tricky line valid JSON', () => {
    const clean = '{"type":"user","a":"b c"}';
    expect(makeScrubber([])(clean)).toBe(clean);
    const spaced = '{ "type": "user",  "n": 1.50 }';
    expect(makeScrubber([])(spaced)).toBe(spaced);
    const out = makeScrubber([])(line({ a: 'X_TOKEN=', b: 'c' }));
    expect(JSON.parse(out)).toEqual({ a: 'X_TOKEN=', b: 'c' });
  });

  it('scrubs a non-JSON line as text', () => {
    expect(makeScrubber([{ key: 'K', value: 'supersecret1' }])('raw supersecret1')).toBe('raw [redacted:K]');
  });

  it('is the only producer of ScrubbedLine', () => {
    // @ts-expect-error a plain string is not a ScrubbedLine
    const bad: ScrubbedLine = 'raw';
    const good: ScrubbedLine = makeScrubber([])('raw');
    expect([bad, good]).toEqual(['raw', 'raw']);
  });
});
