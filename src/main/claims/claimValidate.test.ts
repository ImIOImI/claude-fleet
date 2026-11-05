import { describe, expect, it } from 'vitest';
import { validateClaimInput, findSecret } from './claimValidate.js';

const ok = { text: 'MCP query copies the whole workspace history per call', kind: 'root-cause', topics: ['mcp-query'] };

describe('validateClaimInput', () => {
  it('normalizes a valid claim with defaults', () => {
    expect(validateClaimInput(ok)).toEqual({
      text: ok.text, kind: 'root-cause', topics: ['mcp-query'], refs: [],
      visibility: 'fleet', supersedes: null, captureRun: null
    });
  });
  it('trims text, lowercases and dedupes topics', () => {
    const r = validateClaimInput({ ...ok, text: `  ${ok.text}  `, topics: ['MCP-Query', 'mcp-query', 'state-db'] });
    expect(r.text).toBe(ok.text);
    expect(r.topics).toEqual(['mcp-query', 'state-db']);
  });
  it.each([
    [{ ...ok, text: '' }, /text/],
    [{ ...ok, text: 'x'.repeat(601) }, /600/],
    [{ ...ok, kind: 'opinion' }, /kind/],
    [{ ...ok, topics: [] }, /topics/],
    [{ ...ok, topics: ['a', 'b', 'c', 'd'] }, /topics/],
    [{ ...ok, topics: ['has space'] }, /topic/],
    [{ ...ok, visibility: 'public' }, /visibility/],
    [{ ...ok, refs: 'not-an-array' }, /refs/],
    [{ ...ok, refs: Array(11).fill('#1') }, /refs/]
  ])('rejects %j', (args, msg) => {
    expect(() => validateClaimInput(args as Record<string, unknown>)).toThrow(msg);
  });
  it('accepts supersedes, capture_run and private visibility', () => {
    const r = validateClaimInput({ ...ok, visibility: 'private', supersedes: '01ABC', capture_run: '01RUN', refs: ['#476'] });
    expect(r).toMatchObject({ visibility: 'private', supersedes: '01ABC', captureRun: '01RUN', refs: ['#476'] });
  });
});

describe('findSecret', () => {
  it.each([
    ['ghp_' + 'a'.repeat(36), 'github-token'],
    ['github_pat_' + 'A'.repeat(30), 'github-token'],
    ['AKIA' + 'ABCDEFGHIJKLMNOP', 'aws-access-key'],
    ['sk-ant-api03-' + 'x'.repeat(40), 'anthropic-key'],
    ['sk-' + 'a'.repeat(40), 'openai-key'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key'],
    ['postgres://user:hunter2@db.internal:5432/app', 'credential-url'],
    ['api_key=Zx8vQ2mP9rT4wY7uK1nB5cD3', 'assignment-secret']
  ])('flags %s as %s', (text, cls) => {
    expect(findSecret(`see ${text} here`)).toBe(cls);
  });
  it.each([
    'MCP query copies the whole workspace history per call (#476)',
    'postgres://db.internal:5432/app has no auth in dev',
    'set token=<redacted> in the vault, never in the manifest',
    'src/main/mcpServer.ts:buildSnapshot is O(history)'
  ])('passes %s', (text) => {
    expect(findSecret(text)).toBeNull();
  });
});
