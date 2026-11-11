import { describe, expect, it } from 'vitest';
import { publishSummary, publishVisibility, togglePublishTarget } from './publishTargets';

describe('publish targets', () => {
  it('toggles a target without duplicates', () => {
    expect(togglePublishTarget(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(togglePublishTarget(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(togglePublishTarget(['a', 'b'], 'a', false)).toEqual(['b']);
  });
  it('summarizes by host name', () => {
    const remotes = [{ id: 'a', name: 'review-bot' }, { id: 'b', name: 'ops' }];
    expect(publishSummary([], remotes)).toBe('off');
    expect(publishSummary(['b', 'a'], remotes)).toBe('on: ops, review-bot');
    expect(publishSummary(['gone'], remotes)).toBe('off');
  });
  it('states who can see published transcripts', () => {
    expect(publishVisibility('review-bot')).toBe('Visible to everyone with read on review-bot and to its sessions.');
  });
});
