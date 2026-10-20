import { describe, it, expect } from 'vitest';
import {
  PRIORITIES,
  priorityRank,
  maxPriority,
  normalizeTag,
  normalizeTags,
  validatePostInput,
  InboxInputError
} from './inboxCore.js';

describe('priorities', () => {
  it('ranks low < normal < high < urgent', () => {
    expect(PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent']);
    expect(priorityRank('low')).toBeLessThan(priorityRank('urgent'));
  });
  it('maxPriority keeps the more severe', () => {
    expect(maxPriority('normal', 'urgent')).toBe('urgent');
    expect(maxPriority('high', 'low')).toBe('high');
  });
});

describe('normalizeTag', () => {
  it('lowercases, trims, and dashes spaces', () => {
    expect(normalizeTag('  Prod Alerts ')).toBe('prod-alerts');
  });
  it('rejects invalid characters and overlong tags', () => {
    expect(normalizeTag('a/b')).toBeNull();
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('x'.repeat(41))).toBeNull();
  });
  it('normalizeTags dedupes, drops junk and caps at 10', () => {
    expect(normalizeTags(['Ops', 'ops', 'bad/tag', 3])).toEqual(['ops']);
    const many = Array.from({ length: 15 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toHaveLength(10);
    expect(normalizeTags('nope')).toEqual([]);
  });
});

describe('validatePostInput', () => {
  it('accepts a minimal post and defaults priority to normal', () => {
    expect(validatePostInput({ title: '  Disk full ' })).toEqual({ title: 'Disk full', priority: 'normal', tags: [] });
  });
  it('maps snake_case MCP args', () => {
    const v = validatePostInput({
      title: 't', body: 'b', priority: 'urgent', key: 'k1', tags: ['Ops'],
      workspace_link: 'W1', session_link: 'S1'
    });
    expect(v).toEqual({ title: 't', body: 'b', priority: 'urgent', key: 'k1', tags: ['ops'], workspaceLink: 'W1', sessionLink: 'S1' });
  });
  it('rejects a missing or overlong title, bad priority, overlong body/key', () => {
    expect(() => validatePostInput({})).toThrow(InboxInputError);
    expect(() => validatePostInput({ title: 'x'.repeat(201) })).toThrow(/title/);
    expect(() => validatePostInput({ title: 't', priority: 'meh' })).toThrow(/priority/);
    expect(() => validatePostInput({ title: 't', body: 'x'.repeat(20_001) })).toThrow(/body/);
    expect(() => validatePostInput({ title: 't', key: 'x'.repeat(201) })).toThrow(/key/);
  });
});
