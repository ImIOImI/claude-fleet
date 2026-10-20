import { describe, it, expect } from 'vitest';
import { groupByPriority, matchesSearch, sourceLabel, chipSubline, chipDot, relativeAgo, eventLabel } from './inboxView';
import type { Todo, TodoEvent } from '../../preload/inboxTypes';

const t = (over: Partial<Todo>): Todo => ({
  id: 'T', title: 'Disk full', body: 'on build-01', status: 'open', priority: 'normal', source: { kind: 'user', id: null },
  sourceRunId: null, viaWorkspace: null, dedupeKey: null, seenCount: 1, recurred: false, workspaceId: null,
  sessionId: null, tags: ['ops'], createdAt: 0, updatedAt: 0, firstSeenAt: 0, lastSeenAt: 0, closedAt: null, ...over
});

describe('inboxView helpers', () => {
  it('groups by priority in severity order and omits empty groups', () => {
    const g = groupByPriority([t({ id: 'a', priority: 'low' }), t({ id: 'b', priority: 'urgent' }), t({ id: 'c', priority: 'low' })]);
    expect(g.map((x) => [x.label, x.todos.length])).toEqual([['Urgent', 1], ['Low', 2]]);
  });
  it('searches title, body and tags case-insensitively', () => {
    expect(matchesSearch(t({}), 'DISK')).toBe(true);
    expect(matchesSearch(t({}), 'build-01')).toBe(true);
    expect(matchesSearch(t({}), 'ops')).toBe(true);
    expect(matchesSearch(t({}), 'nothing')).toBe(false);
    expect(matchesSearch(t({}), '  ')).toBe(true);
  });
  it('labels sources', () => {
    expect(sourceLabel({ kind: 'user', id: null }, {})).toBe('You');
    expect(sourceLabel({ kind: 'workspace', id: 'W1' }, { W1: 'ops-oncall' })).toBe('ops-oncall');
    expect(sourceLabel({ kind: 'workspace', id: 'W9' }, {})).toBe('deleted workspace');
    expect(sourceLabel({ kind: 'automation', id: 'A1' }, {})).toBe('automation');
    expect(sourceLabel({ kind: 'automation', id: 'A1' }, { A1: 'log-watch' })).toBe('log-watch');
  });
  it('builds the chip sub-line and dot', () => {
    expect(chipSubline({ open: 0, urgent: 0, high: 0 })).toBe('nothing open');
    expect(chipSubline({ open: 7, urgent: 1, high: 2 })).toBe('7 open · 1 urgent');
    expect(chipSubline({ open: 3, urgent: 0, high: 1 })).toBe('3 open');
    expect(chipDot({ open: 7, urgent: 1, high: 0 })).toBe('urgent');
    expect(chipDot({ open: 2, urgent: 0, high: 0 })).toBe('open');
    expect(chipDot({ open: 0, urgent: 0, high: 0 })).toBe('none');
    expect(chipDot({ open: 2, urgent: 0, high: 0, approvals: 1 })).toBe('wait');
    expect(chipSubline({ open: 2, urgent: 0, high: 0, approvals: 1 })).toBe('2 open · 1 to approve');
    expect(chipSubline({ open: 0, urgent: 0, high: 0, approvals: 3 })).toBe('3 to approve');
  });
  it('formats relative time', () => {
    expect(relativeAgo(1000, 1000 + 30_000)).toBe('just now');
    expect(relativeAgo(0, 5 * 60_000)).toBe('5m ago');
    expect(relativeAgo(0, 3 * 3_600_000)).toBe('3h ago');
    expect(relativeAgo(0, 2 * 86_400_000)).toBe('2d ago');
  });
  it('describes history events', () => {
    const e = (kind: TodoEvent['kind'], detail: Record<string, unknown> | null, actor = { kind: 'user' as const, id: null }): TodoEvent =>
      ({ id: 1, todoId: 'T', ts: 0, kind, actor, runId: null, detail });
    expect(eventLabel(e('created', null), {})).toBe('Created by You');
    expect(eventLabel(e('seen', null, { kind: 'workspace', id: 'W1' } as never), { W1: 'ops' })).toBe('Seen again by ops');
    expect(eventLabel(e('reopened', { from: 'done' }), {})).toBe('Reopened: it recurred after being marked done');
    expect(eventLabel(e('status', { to: 'done' }), {})).toBe('You marked it done');
    expect(eventLabel(e('tag_add', { tags: ['a', 'b'] }), {})).toBe('You added tags a, b');
    expect(eventLabel(e('priority', { to: 'high' }), {})).toBe('You set priority to high');
  });
});
