import { describe, expect, it } from 'vitest';
import { publishPayload, publishSummary, publishVisibility, togglePublishTarget, unpublishNote, withoutPublish } from './publishTargets';

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

  it('a manifest write that is not the Edit form carries no publish key', () => {
    const spec = { id: 'W', name: 'w', publish: { to: ['R'], since: { R: 5 } } };
    const out = withoutPublish(spec);
    expect(out).toEqual({ id: 'W', name: 'w' });
    expect('publish' in out).toBe(false);
  });

  it('sends publish only when the form has targets state', () => {
    expect(publishPayload(undefined)).toEqual({});
    expect('publish' in publishPayload(undefined)).toBe(false);
    expect(publishPayload([])).toEqual({ publish: { to: [] } });
    expect(publishPayload(['R'])).toEqual({ publish: { to: ['R'] } });
  });
});

describe('unpublishNote', () => {
  it('says what happened', () => {
    expect(unpublishNote({ removed: 1, failed: [] })).toBe('Unpublished. This session won’t be published again.');
    expect(unpublishNote({ removed: 0, failed: [] })).toBe('Nothing of this session was published. It won’t be published.');
    expect(unpublishNote({ removed: 0, failed: [{ remoteId: 'r', name: 'ops', error: 'ops is not reachable' }] }))
      .toBe('Not yet removed from ops (ops is not reachable). It won’t be published again; try Unpublish once the host is reachable.');
  });
});
