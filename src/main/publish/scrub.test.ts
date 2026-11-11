import { describe, expect, it, vi } from 'vitest';
import { makeScrubber, MAX_SCRUB_DEPTH, MIN_SECRET_LEN, UnpublishableLineError, type ScrubbedLine } from './scrub.js';

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

  it('leaves a canonical clean line byte-identical and keeps a tricky line valid JSON', () => {
    const clean = '{"type":"user","a":"b c"}';
    expect(makeScrubber([])(clean)).toBe(clean);
    const out = makeScrubber([])(line({ a: 'X_TOKEN=', b: 'c' }));
    expect(JSON.parse(out)).toEqual({ a: 'X_TOKEN=', b: 'c' });
  });

  it('emits a non-canonical clean line in canonical form', () => {
    expect(makeScrubber([])('{ "type": "user",  "n": 1.50 }')).toBe('{"type":"user","n":1.5}');
  });

  it('does not leak a secret held by a duplicate key that JSON.parse drops', () => {
    const s = makeScrubber([{ key: 'K', value: 'supersecret1' }]);
    expect(s('{"a":"supersecret1","a":"x"}')).toBe('{"a":"x"}');
    // The escape hides the token from the text backstop; only the dropped value held it.
    const pattern = s(`{"t":"${'ghp_' + 'A'.repeat(36)}","t":"x"}`.replace('ghp_', 'gh\\u0070_'));
    expect(pattern).toBe('{"t":"x"}');
  });

  it('scrubs a secret inside a \\u-escaped object key', () => {
    const esc = (v: string): string => [...v].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const out = makeScrubber([{ key: 'K', value: 'supersecret1' }])(`{"${esc('supersecret1')}":1}`);
    expect(out).toBe('{"[redacted:K]":1}');
    const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    expect(makeScrubber([])(`{"${esc(aws)}":1}`)).toBe('{"[redacted]":1}');
    // A quoted assignment is only recognised decoded; the serialized backstop sees `\\"`.
    expect(makeScrubber([])(line({ ['MY_TOKEN="q w"']: 1 }))).toBe(line({ ['MY_TOKEN=[redacted]']: 1 }));
  });

  it('wraps an unexpected failure in UnpublishableLineError', () => {
    const spy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new RangeError('boom');
    });
    try {
      expect(() => makeScrubber([])('{"a":1}')).toThrow(UnpublishableLineError);
    } finally {
      spy.mockRestore();
    }
  });

  it('is deterministic, so a re-sent line keeps its dedup key', () => {
    const s = makeScrubber([{ key: 'K', value: 'supersecret1' }]);
    for (const l of ['{ "a" : "supersecret1",\t"a":"y" }', line({ t: `x supersecret1 ${slack('b')}` }), 'not json supersecret1']) {
      expect(s(l)).toBe(s(l));
      expect(s(s(l))).toBe(s(l));
    }
  });

  it(`refuses a line nested deeper than ${MAX_SCRUB_DEPTH} with UnpublishableLineError`, () => {
    const nest = (n: number): string => '['.repeat(n) + '"x"' + ']'.repeat(n);
    expect(makeScrubber([])(nest(MAX_SCRUB_DEPTH))).toBe(nest(MAX_SCRUB_DEPTH));
    expect(() => makeScrubber([])(nest(MAX_SCRUB_DEPTH + 1))).toThrow(UnpublishableLineError);
    const objs = (n: number): string => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
    expect(() => makeScrubber([])(objs(5000))).toThrow(UnpublishableLineError);
    expect(() => makeScrubber([])(nest(100_000))).toThrow(UnpublishableLineError);
  });

  it('replaces secret values in one pass, never rewriting a label', () => {
    const s = makeScrubber([{ key: 'A', value: 'aaaaaaaaaaaa' }, { key: 'B', value: 'redacted' }]);
    expect(text(s(line({ t: 'aaaaaaaaaaaa redacted' })))).toBe('[redacted:A] [redacted:B]');
    expect(s(line({ ['aaaaaaaaaaaa']: 'redacted' }))).toBe(line({ ['[redacted:A]']: '[redacted:B]' }));
  });

  it('redacts a Slack token after a hyphen', () => {
    expect(text(makeScrubber([])(line({ t: `token-${slack('b')}` })))).toBe('token-[redacted]');
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
