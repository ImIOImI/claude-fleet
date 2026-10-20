import { describe, it, expect } from 'vitest';
import { canPost, postLimit, PostRateLimiter, canUpdate, canSee, sanitizeInboxConfig, DEFAULT_MAX_POSTS_PER_HOUR } from './inboxPolicy.js';
import type { Todo } from '../../preload/inboxTypes.js';

const todo = (over: Partial<Todo>): Todo => ({
  id: 'T', title: 't', body: null, status: 'open', priority: 'normal', source: { kind: 'workspace', id: 'W1' },
  sourceRunId: null, viaWorkspace: null, dedupeKey: null, seenCount: 1, recurred: false, workspaceId: null,
  sessionId: null, tags: [], createdAt: 0, updatedAt: 0, firstSeenAt: 0, lastSeenAt: 0, closedAt: null, ...over
});

describe('post permission', () => {
  it('defaults to allowed with a 60/hour cap', () => {
    expect(canPost(undefined)).toBe(true);
    expect(postLimit(undefined)).toBe(DEFAULT_MAX_POSTS_PER_HOUR);
    expect(canPost({ canPost: false })).toBe(false);
    expect(postLimit({ maxPostsPerHour: 5 })).toBe(5);
  });
});

describe('PostRateLimiter', () => {
  it('rejects over the cap within an hour and reports when to retry', () => {
    const rl = new PostRateLimiter();
    expect(rl.take('W', 2, 0)).toEqual({ ok: true });
    expect(rl.take('W', 2, 1000)).toEqual({ ok: true });
    expect(rl.take('W', 2, 2000)).toEqual({ ok: false, retryAfterMs: 3_600_000 - 2000 });
    expect(rl.take('OTHER', 2, 2000)).toEqual({ ok: true });
    expect(rl.take('W', 2, 3_600_001)).toEqual({ ok: true });
  });
});

describe('visibility and update rights', () => {
  it('a workspace may update only what it sourced or did the work for', () => {
    expect(canUpdate('W1', todo({}))).toBe(true);
    expect(canUpdate('W2', todo({}))).toBe(false);
    expect(canUpdate('W2', todo({ viaWorkspace: 'W2' }))).toBe(true);
    expect(canUpdate('W2', todo({ workspaceId: 'W2' }))).toBe(false);
  });
  it('a workspace sees own, linked and via todos; everything with canReadAll', () => {
    expect(canSee('W2', todo({ workspaceId: 'W2' }))).toBe(true);
    expect(canSee('W2', todo({}))).toBe(false);
    expect(canSee('W2', todo({}), { canReadAll: true })).toBe(true);
  });
});

describe('sanitizeInboxConfig', () => {
  it('keeps valid fields, drops junk, returns undefined when empty', () => {
    expect(sanitizeInboxConfig({ canPost: false, maxPostsPerHour: 10, canReadAll: true, trusted: true, x: 1 }))
      .toEqual({ canPost: false, maxPostsPerHour: 10, canReadAll: true, trusted: true });
    expect(sanitizeInboxConfig({ canPost: 'no', maxPostsPerHour: -3 })).toBeUndefined();
    expect(sanitizeInboxConfig({ maxPostsPerHour: 99999 })).toEqual({ maxPostsPerHour: 10000 });
    expect(sanitizeInboxConfig(null)).toBeUndefined();
  });
});
