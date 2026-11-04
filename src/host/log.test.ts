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
    'sk-ant-api03-' + 'e'.repeat(20)
  ])('redacts %s', (s) => {
    expect(redactSecrets(s)).toContain('[redacted]');
    expect(redactSecrets(s)).not.toMatch(/[a-e]{16}/);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('GET /whoami 200 @alice')).toBe('GET /whoami 200 @alice');
  });
});

describe('createLogger', () => {
  it('redacts the message and every string field', () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l), () => 0).log('warn', `failed with ${GHO}`, { error: `Bearer ${GHO}`, n: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(GHO);
    expect(JSON.parse(lines[0])).toEqual({ ts: '1970-01-01T00:00:00.000Z', level: 'warn', msg: 'failed with [redacted]', error: '[redacted]', n: 1 });
  });
});
