import { describe, expect, it } from 'vitest';
import {
  parseActionReply, parseAutomationDetail, parseAutomationRows, parseCounts, parseNoticeRows, parseProposalRows, parseTodoDetail, parseTodoRows
} from './remoteAutomationRows.js';
import { RemoteShapeError } from './remoteRows.js';

const O = '01JC0000000000000000000000';
const A = '01JC0000000000000000000001';
const def = { name: 'nightly', triggers: [{ schedule: { cron: '0 3 * * *' } }], steps: [{ id: 'go', prompt: { workspace: O, mode: 'fresh', message: 'review' } }] };
const auto = {
  id: A, name: 'nightly', description: null, enabled: true, version: 2, definition: def, tags: ['ops'],
  createdBy: { kind: 'user', id: null }, createdAt: 1, updatedAt: 2, lastScheduledAt: null, nextFireAt: 3, nextSetByRun: null,
  lastRun: null, weekStats: { runs: 1, nothingToDo: 0, failed: 0 }, triggerSummaries: ['daily at 03:00'], origin: { source: 'host-config' }
};
const todo = {
  id: '01JC0000000000000000000002', title: 'disk\u0007 full', body: 'line1\nline2\u0000', status: 'open', priority: 'high',
  source: { kind: 'user', id: 'ann' }, sourceRunId: null, viaWorkspace: null, dedupeKey: 'disk', seenCount: 1, recurred: false,
  workspaceId: O, sessionId: null, tags: ['ops'], createdAt: 1, updatedAt: 1, firstSeenAt: 1, lastSeenAt: 1, closedAt: null
};

describe('remote automation rows', () => {
  it('keeps a valid automation, marks host-config, and re-validates its definition against the origin only', () => {
    const [a] = parseAutomationRows({ rows: [auto] }, O);
    expect(a).toMatchObject({ id: A, name: 'nightly', managedBy: 'host-config', tags: ['ops'] });
    const elsewhere = { ...auto, definition: { ...def, steps: [{ id: 'go', prompt: { workspace: '01JC000000000000000000000Z', mode: 'fresh', message: 'x' } }] } };
    expect(parseAutomationRows({ rows: [elsewhere] }, O)).toEqual([]);
    expect(parseAutomationRows({ rows: [{ ...auto, name: 'other' }] }, O)).toEqual([]);
  });

  it('throws on a bad envelope or more than 100 rows', () => {
    expect(() => parseAutomationRows({ rows: 'x' }, O)).toThrow(RemoteShapeError);
    expect(() => parseAutomationRows({ rows: Array(101).fill(auto) }, O)).toThrow(RemoteShapeError);
  });

  it('caps runs at 30 and keeps only known step detail keys', () => {
    const run = {
      id: '01JC00000000000000000000R1', automationId: A, version: 2, trigger: { kind: 'manual', by: { kind: 'user', id: 'ann' } }, args: {},
      status: 'failed', startedAt: 1, endedAt: 2, error: 'boom',
      steps: [{ id: 1, runId: '01JC00000000000000000000R1', stepId: 'go', kind: 'prompt', status: 'failed', workspaceId: O, brokerSessionId: 'auto-x', startedAt: 1, endedAt: 2, error: null, detail: { via: 'fresh', secret: 'x', stdout: 'a\u0000b' } }]
    };
    const d = parseAutomationDetail({ automation: auto, runs: Array(40).fill(run), yaml: 'name: nightly\n' }, O)!;
    expect(d.runs).toHaveLength(30);
    expect(d.runs[0].steps[0].detail).toEqual({ via: 'fresh', stdout: 'a b' });
    expect(parseAutomationDetail(null, O)).toBeNull();
  });

  it('detail runs filed under another automation are dropped; a mismatched lastRun is nulled, not rejected', () => {
    const run = (id: string, automationId: string) => ({
      id, automationId, version: 2, trigger: { kind: 'manual' }, args: {}, status: 'failed', startedAt: 1, endedAt: 2, error: null, steps: []
    });
    const OTHER = '01JC0000000000000000000009';
    const d = parseAutomationDetail({ automation: auto, runs: [run('01JC00000000000000000000R1', A), run('01JC00000000000000000000R2', OTHER)], yaml: '' }, O)!;
    expect(d.runs.map((r) => r.id)).toEqual(['01JC00000000000000000000R1']);
    const [a] = parseAutomationRows({ rows: [{ ...auto, lastRun: run('01JC00000000000000000000R3', OTHER) }] }, O);
    expect(a.lastRun).toBeNull();
    const [a2] = parseAutomationRows({ rows: [{ ...auto, lastRun: run('01JC00000000000000000000R4', A) }] }, O);
    expect(a2.lastRun?.id).toBe('01JC00000000000000000000R4');
  });

  it('todos: strings stripped and capped, sources checked against the origin, user ids as logins', () => {
    const [t] = parseTodoRows({ rows: [todo] }, O);
    expect(t.title).toBe('disk  full');
    expect(t.body).toBe('line1\nline2 ');
    expect(parseTodoRows({ rows: [{ ...todo, source: { kind: 'workspace', id: 'other' } }] }, O)).toEqual([]);
    expect(parseTodoRows({ rows: [{ ...todo, source: { kind: 'user', id: 'not a login!' } }] }, O)).toEqual([]);
    expect(parseTodoRows({ rows: [{ ...todo, workspaceId: 'elsewhere' }] }, O)[0].workspaceId).toBeNull();
    const d = parseTodoDetail({ todo, events: Array(150).fill({ id: 1, todoId: todo.id, ts: 1, kind: 'created', actor: { kind: 'user', id: 'ann' }, runId: null, detail: { x: { deep: 1 } } }) }, O)!;
    expect(d.events).toHaveLength(100);
    expect(d.events[0].detail).toBeNull();
  });

  it('proposals: capture-settings dropped, items capped at 20 with re-validated definitions', () => {
    const p = {
      id: '01JC0000000000000000000003', kind: 'new', proposer: { kind: 'workspace', id: O }, rationale: 'r', status: 'pending',
      items: [{ automationId: null, name: 'nightly', baseVersion: null, before: null, after: def, lowRisk: false, reasons: ['new automation'], flags: ['runs daily'], decision: 'pending' }],
      note: null, createdAt: 1, decidedAt: null
    };
    expect(parseProposalRows({ rows: [p, { ...p, id: '01JC0000000000000000000004', kind: 'capture-settings', items: [] }] }, O)).toHaveLength(1);
    expect(parseProposalRows({ rows: [{ ...p, items: Array(21).fill(p.items[0]) }] }, O)).toEqual([]);
  });

  it('counts, notices and action replies', () => {
    expect(parseCounts({ open: 1, urgent: 0, high: 2, approvals: 3 })).toEqual({ open: 1, urgent: 0, high: 2, approvals: 3 });
    expect(() => parseCounts({ open: -1 })).toThrow(RemoteShapeError);
    expect(() => parseCounts({ open: -1, urgent: 0, high: 0 })).toThrow(RemoteShapeError);
    expect(parseCounts({ open: 1, urgent: 0, high: 0, approvals: 'x' }).approvals).toBe(0);
    const n = { id: '01JC0000000000000000000005', ts: 9, kind: 'run-failed', title: 't', body: 'b', priority: 'high', dedupeKey: null, tags: ['x'] };
    expect(parseNoticeRows({ rows: [n, { ...n, id: '01JC0000000000000000000006', kind: 'input-wait' }] })).toEqual([{ id: n.id, ts: 9, kind: 'run-failed', title: 't', body: 'b', priority: 'high', dedupeKey: null }]);
    expect(parseActionReply({ replayed: true, result: { runId: 'R' }, error: null })).toEqual({ replayed: true, result: { runId: 'R' }, error: null });
    expect(() => parseActionReply({ replayed: 'yes' })).toThrow(RemoteShapeError);
  });

  it('rows are allowlisted: unknown host fields never reach the renderer', () => {
    const [a] = parseAutomationRows({ rows: [{ ...auto, secret: 'x', __proto__x: 1 }] }, O);
    expect(Object.keys(a)).not.toContain('secret');
    expect(Object.keys(a)).not.toContain('origin');
    const [t] = parseTodoRows({ rows: [{ ...todo, html: '<b>x</b>' }] }, O);
    expect(Object.keys(t)).not.toContain('html');
  });

  it('a bad row is dropped while its siblings survive', () => {
    expect(parseAutomationRows({ rows: [auto, { ...auto, id: 'nope' }, { ...auto, enabled: 'yes' }] }, O)).toHaveLength(1);
    expect(parseTodoRows({ rows: [todo, { ...todo, priority: 'meh' }, null, 7] }, O)).toHaveLength(1);
  });

  it('definition text is scrubbed of control and bidi characters', () => {
    const evil = { ...def, steps: [{ id: 'go', prompt: { workspace: O, mode: 'fresh', message: 'a\u202eb\nc' } }] };
    const [a] = parseAutomationRows({ rows: [{ ...auto, definition: evil }] }, O);
    expect((a.definition.steps[0] as { prompt: { message: string } }).prompt.message).toBe('a b\nc');
  });

  it('detail envelopes: null is "not found", a malformed envelope throws, events for another todo are dropped', () => {
    expect(() => parseAutomationDetail({ automation: auto, runs: 'x', yaml: '' }, O)).toThrow(RemoteShapeError);
    expect(() => parseAutomationDetail({ automation: { ...auto, id: 'x' }, runs: [], yaml: '' }, O)).toThrow(RemoteShapeError);
    expect(parseTodoDetail(null, O)).toBeNull();
    expect(() => parseTodoDetail({ todo, events: {} }, O)).toThrow(RemoteShapeError);
    const ev = { id: 1, todoId: 'OTHER', ts: 1, kind: 'created', actor: { kind: 'user', id: 'ann' }, runId: null, detail: null };
    expect(parseTodoDetail({ todo, events: [ev] }, O)!.events).toEqual([]);
  });

  it('caps every list envelope', () => {
    expect(() => parseTodoRows({ rows: Array(201).fill(todo) }, O)).toThrow(RemoteShapeError);
    expect(() => parseProposalRows({ rows: Array(101).fill({}) }, O)).toThrow(RemoteShapeError);
    expect(() => parseNoticeRows({ rows: Array(101).fill({}) })).toThrow(RemoteShapeError);
  });

  it('action replies: an unsettled replay stays result null; results keep only known string fields', () => {
    expect(parseActionReply({ replayed: true, result: null, error: null })).toEqual({ replayed: true, result: null, error: null });
    expect(parseActionReply({ replayed: false, result: { id: 'T', status: 'done', extra: { deep: 1 }, runId: 5 }, error: null }).result).toEqual({ id: 'T', status: 'done' });
    expect(parseActionReply({ replayed: false, result: 'x', error: null }).result).toBeNull();
    expect(parseActionReply({ replayed: false, result: null, error: 'a\u0007b' }).error).toBe('a b');
    expect(() => parseActionReply({ replayed: false, result: null })).toThrow(RemoteShapeError);
    expect(() => parseActionReply({ replayed: 'yes', result: null, error: null })).toThrow(RemoteShapeError);
    expect(() => parseActionReply({ replayed: false, result: null, error: 5 })).toThrow(RemoteShapeError);
  });
});
