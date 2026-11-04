import { describe, expect, it } from 'vitest';
import { createLogger, redactSecrets } from './log.js';

const GHO = 'gho_' + 'a'.repeat(36);

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

  it('serializes an Error as name and redacted message', () => {
    const line = one({ err: new TypeError(`fetch failed\nBearer ${GHO}`) });
    expect(JSON.parse(line).err).toEqual({ name: 'TypeError', message: 'fetch failed\n[redacted]' });
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
