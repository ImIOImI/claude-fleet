import { describe, expect, it } from 'vitest';
import { createLogger, redactJsonLine, redactSecrets } from './log.js';

const GHO = 'gho_' + 'a'.repeat(36);
const GHS = 'ghs_' + 'A1b2C3d4E5'.repeat(3) + 'abcdef';
const BEARER = 'Bearer abcDEF123.xyz-TOKEN';
/** Escapes and ANSI codes whose last character is alphanumeric, so a plain word-boundary check misses them. */
const PREFIXES = ['\n', '\t', '\u001b[0m'];
const AFTER_ESCAPES = PREFIXES.flatMap((p) => [GHS, BEARER].map((secret) => [JSON.stringify(p), secret, p] as const));

describe('redactSecrets', () => {
  it.each([
    `Authorization: Bearer ${GHO}`,
    `token=${GHO}`,
    'ghp_' + 'b'.repeat(36),
    'ghs_' + 'c'.repeat(36),
    'github_pat_' + 'd'.repeat(40),
    'sk-ant-api03-' + 'e'.repeat(20),
    'ghr_' + 'a'.repeat(36),
    'x_gho_' + 'b'.repeat(36),
    'Authorization: Basic ' + Buffer.from('cccccccccccccccc:dddddddddddddddd').toString('base64'),
    'Authorization: token ' + 'abcdef0123456789'.repeat(2) + 'abcdef01',
    'https://x-access-token:' + 'e'.repeat(20) + '@github.com/acme/repo.git'
  ])('redacts %s', (s) => {
    expect(redactSecrets(s)).toContain('[redacted]');
    expect(redactSecrets(s)).not.toMatch(/[a-e]{16}/);
  });

  it('redacts a PEM private key block, even a truncated one', () => {
    const body = 'MIIEow' + 'a'.repeat(64);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    expect(redactSecrets(`key: ${pem} done`)).toBe('key: [redacted] done');
    expect(redactSecrets(`-----BEGIN PRIVATE KEY-----\n${body}`)).not.toContain(body);
  });

  it('keeps the scheme of a credentialed URL', () => {
    expect(redactSecrets('clone https://user:hunter2@example.com/r failed')).toBe('clone https://[redacted]@example.com/r failed');
  });

  it.each(AFTER_ESCAPES)('redacts a secret after %s, raw or JSON-escaped (%s)', (_label, secret, prefix) => {
    const raw = `done${prefix}${secret} ok`;
    expect(redactSecrets(raw)).toBe(`done${prefix}[redacted] ok`);
    expect(redactSecrets(JSON.stringify({ t: raw }))).not.toContain(secret.split(' ').pop());
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('GET /whoami 200 @alice')).toBe('GET /whoami 200 @alice');
  });
});

describe('createLogger', () => {
  const one = (fields: Record<string, unknown>): string => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l), () => 0).log('info', 'x', fields);
    expect(lines).toHaveLength(1);
    return lines[0];
  };

  it.each(['\n', '\t', '\r'])('redacts a token after an escaped %j at depth', (esc) => {
    const line = one({ a: { b: [`line1${esc}Bearer ${GHO}`, `x${esc}${GHO}`] } });
    expect(line).not.toContain(GHO);
    expect(line).not.toContain('a'.repeat(36));
  });

  it('a nested PEM followed by a quote yields valid, redacted JSON', () => {
    const body = 'MIIEow' + 'b'.repeat(64);
    const line = one({ cfg: { key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----"tail"` } });
    expect(line).not.toContain(body);
    expect(JSON.parse(line).cfg.key).toBe('[redacted]"tail"');
  });

  it('serializes an Error as name, redacted message and redacted stack', () => {
    const line = one({ err: new TypeError(`fetch failed\nBearer ${GHO}`) });
    const err = JSON.parse(line).err;
    expect(err).toMatchObject({ name: 'TypeError', message: 'fetch failed\n[redacted]' });
    expect(err.stack).toMatch(/^TypeError: fetch failed\n\[redacted\]\n\s+at /);
    expect(line).not.toContain(GHO);
  });

  it('the line pass catches a token used as an object key', () => {
    expect(one({ seen: { [GHO]: true } })).not.toContain(GHO);
  });

  it('turns a BigInt into a string', () => {
    expect(JSON.parse(one({ n: 10n })).n).toBe('10');
  });

  it('falls back to a fixed record for circular fields', () => {
    const c: Record<string, unknown> = { token: GHO };
    c.self = c;
    const line = one({ c });
    expect(line).not.toContain(GHO);
    expect(JSON.parse(line)).toEqual({ ts: '1970-01-01T00:00:00.000Z', level: 'info', msg: 'x', error: 'unserializable fields' });
  });

  it('redacts nested objects and arrays, and the line stays valid JSON', () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l), () => 0).log('info', 'x', { req: { headers: [`Bearer ${GHO}`] }, err: { detail: `see ${GHO}` } });
    expect(lines[0]).not.toContain(GHO);
    expect(JSON.parse(lines[0])).toMatchObject({ req: { headers: ['[redacted]'] }, err: { detail: 'see [redacted]' } });
  });


  it('redacts the message and every string field', () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l), () => 0).log('warn', `failed with ${GHO}`, { error: `Bearer ${GHO}`, n: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(GHO);
    expect(JSON.parse(lines[0])).toEqual({ ts: '1970-01-01T00:00:00.000Z', level: 'warn', msg: 'failed with [redacted]', error: '[redacted]', n: 1 });
  });
});

const AFTER_ANY_ESCAPE = [...AFTER_ESCAPES, ...[GHS, BEARER].map((secret) => [JSON.stringify('\u0007'), secret, '\u0007'] as const)];

describe('redactJsonLine', () => {
  it.each(AFTER_ANY_ESCAPE)('redacts a secret after %s inside any nested string (%s)', (_label, secret, prefix) => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ text: `x${prefix}${secret}` }] } });
    const out = redactJsonLine(line);
    expect(out).not.toContain(secret.split(' ').pop());
    expect(JSON.parse(out).message.content[0].text).toBe(`x${prefix}[redacted]`);
  });

  it('keeps a line without secrets byte for byte', () => {
    const line = '{"type":"user",  "uuid":"u1","message":{"content":"caf\\u00e9"}}';
    expect(redactJsonLine(line)).toBe(line);
  });

  it('falls back to the text pass for a line that is not JSON', () => {
    expect(redactJsonLine(`{"partial ${GHS}`)).toBe('{"partial [redacted]');
  });
});
