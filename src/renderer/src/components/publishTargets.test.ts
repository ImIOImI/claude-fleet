import { describe, expect, it } from 'vitest';
import { ipcErrorText, backfillConfirmText, backfillFrom, backfillNote, canBackfill, publishPayload, publishSummary, publishVisibility, togglePublishTarget, unpublishConfirmText, unpublishNote, withoutPublish } from './publishTargets';

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

describe('unpublishConfirmText', () => {
  it('names the hosts and says the session is never published again', () => {
    expect(unpublishConfirmText(['review-bot', 'ops'])).toBe('Remove this session from review-bot, ops? It will never be published again.');
    expect(unpublishConfirmText([])).toBe('Remove this session from the host? It will never be published again.');
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

describe('backfill (Also publish existing sessions…)', () => {
  it('names the count and the host in the confirm text', () => {
    expect(backfillConfirmText(12, 'review-bot')).toBe('This will scrub and upload 12 existing sessions to review-bot.');
    expect(backfillConfirmText(1, 'ops')).toBe('This will scrub and upload 1 existing session to ops.');
    expect(backfillConfirmText(0, 'ops')).toBe('No existing sessions to add for ops.');
  });
  it('turns the choice into what main accepts: all, or local midnight of a valid date', () => {
    expect(backfillFrom('all', '')).toBe('all');
    expect(backfillFrom('date', '2026-03-04')).toBe(new Date(2026, 2, 4).getTime());
    for (const bad of ['', '2026-13-01', '2026-02-30', 'yesterday', '1969-12-31']) expect(backfillFrom('date', bad)).toBeNull();
  });
  it('offers the action only for a target that is saved as on and still ticked', () => {
    expect(canBackfill(['a'], ['a', 'b'], 'a')).toBe(true);
    expect(canBackfill(['a'], ['a', 'b'], 'b')).toBe(false);
    expect(canBackfill(['a'], ['b'], 'a')).toBe(false);
    expect(canBackfill(undefined, ['a'], 'a')).toBe(false);
  });
  it('shows main’s refusal without the IPC prefix', () => {
    expect(ipcErrorText(new Error("Error invoking remote method 'publish:backfill': Error: only earlier sessions can be added"))).toBe('only earlier sessions can be added');
  });
  it('reports what was queued', () => {
    expect(backfillNote(3, 'ops')).toBe('Publishing 3 existing sessions to ops in the background.');
    expect(backfillNote(0, 'ops')).toBe('No existing sessions to add for ops.');
  });
});
