// Host replies for remote automations, todos, proposals and notices. Untrusted
// like remoteRows.ts: every field checked and allowlisted, strings stripped and
// capped, arrays capped; a bad row is dropped, a bad envelope throws (the
// source is then unavailable). Definitions are re-validated with the desktop
// validator, resolving only the origin's id.
import type {
  AutomationDef, InboxCounts, ParamValue, Proposal, ProposalItem, RunRow, StepRunRow, Todo, TodoEvent, TodoSource
} from '../../preload/inboxTypes.js';
import { NOTICE_KINDS, type HostActionReply, type RemoteAutomation, type RemoteNotice, type RemoteOriginInfo } from '../../preload/remoteAutomations.js';
import { BOT_LOGIN_RE, OWNER_LOGIN_RE } from '../../preload/sessionOwner.js';
import { validateDefinition } from '../automations/definition.js';
import { oneLine } from '../remoteUrl.js';
import { RemoteShapeError } from './remoteRows.js';

export type AutomationCore = Omit<RemoteAutomation, keyof RemoteOriginInfo>;

export const MAX_REMOTE_AUTOMATIONS = 100;
export const MAX_REMOTE_RUNS = 30;
export const MAX_REMOTE_TODOS = 200;
export const MAX_REMOTE_EVENTS = 100;
export const MAX_REMOTE_PROPOSALS = 100;
export const MAX_PROPOSAL_ITEMS = 20;
export const MAX_REMOTE_NOTICES = 100;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const STEP_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'nothing-to-do', 'failed', 'timed-out', 'skipped', 'cancelled', 'interrupted']);
const TRIGGER_KINDS = new Set(['schedule', 'manual', 'catch-up', 'event', 'rescheduled']);
const EVENT_NAMES = new Set(['session.idle', 'todo.created', 'workspace.started']);
const TODO_STATUSES = new Set(['open', 'done', 'dismissed']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TODO_EVENT_KINDS = new Set(['created', 'seen', 'reopened', 'status', 'priority', 'tag_add', 'tag_remove', 'body_append', 'title']);
const PROPOSAL_STATUSES = new Set(['pending', 'approved', 'partial', 'rejected', 'superseded', 'auto-approved']);
const DECISIONS = new Set(['pending', 'accepted', 'declined', 'auto-applied', 'reverted']);

const fail = (what: string): never => { throw new RemoteShapeError(`malformed ${what}`); };
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const natOrNull = (v: unknown): number | null | undefined => (v === null ? null : nat(v) ? v : undefined);
const ulidOrNull = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && ULID_RE.test(v) ? v : undefined);
const line = (v: unknown, max: number): string | null | undefined => (v === null ? null : typeof v === 'string' ? oneLine(v, max) : undefined);
/** Multi-line host text: newlines and tabs kept, every other control or format character a space. */
export const block = (s: string, max: number): string => s.replace(/[\x00-\x08\x0b-\x1f\x7f\p{Cf}]/gu, ' ').slice(0, max);
const blockOrNull = (v: unknown, max: number): string | null | undefined => (v === null ? null : typeof v === 'string' ? block(v, max) : undefined);
const tags = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').slice(0, 20).map((t) => oneLine(t, 64)).filter(Boolean) : undefined;
const lines = (v: unknown, n: number, max: number): string[] | undefined =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').slice(0, n).map((t) => oneLine(t, max)) : undefined;
const rows = (v: unknown, cap: number, what: string): unknown[] => {
  const o = v as { rows?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.rows) || o.rows.length > cap) return fail(what);
  return o.rows;
};

function source(v: unknown, origin: string): TodoSource | null {
  const s = v as { kind?: unknown; id?: unknown } | null;
  if (!s || typeof s !== 'object') return null;
  if (s.kind === 'user') {
    if (s.id === null) return { kind: 'user', id: null };
    return typeof s.id === 'string' && (OWNER_LOGIN_RE.test(s.id) || BOT_LOGIN_RE.test(s.id)) ? { kind: 'user', id: s.id } : null;
  }
  if (s.kind === 'workspace') return s.id === origin ? { kind: 'workspace', id: origin } : null;
  if (s.kind === 'automation') return typeof s.id === 'string' && ULID_RE.test(s.id) ? { kind: 'automation', id: s.id } : null;
  return null;
}

function scrub(v: unknown): unknown {
  if (typeof v === 'string') return block(v, 20_000);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

function definition(v: unknown, origin: string): AutomationDef | null {
  const r = validateDefinition(v, { workspace: (x) => (x === origin ? origin : null) });
  return r.ok ? (scrub(r.value) as AutomationDef) : null;
}

function args(v: unknown): Record<string, ParamValue> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, ParamValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 32)) {
    const key = oneLine(k, 64);
    if (typeof x === 'string') out[key] = oneLine(x, 2000);
    else if (typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) out[key] = x;
  }
  return out;
}

function stepDetail(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof d.via === 'string') out.via = oneLine(d.via, 64);
  if (typeof d.exitCode === 'number' && Number.isInteger(d.exitCode)) out.exitCode = d.exitCode;
  if (nat(d.todos)) out.todos = d.todos;
  if (nat(d.notifications)) out.notifications = d.notifications;
  const w = lines(d.warnings, 10, 200);
  if (w?.length) out.warnings = w;
  if (typeof d.stdout === 'string') out.stdout = block(d.stdout, 16_384);
  if (typeof d.stderr === 'string') out.stderr = block(d.stderr, 16_384);
  return Object.keys(out).length ? out : null;
}

function step(v: unknown, origin: string): StepRunRow | null {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || !nat(s.id) || typeof s.runId !== 'string' || !ULID_RE.test(s.runId)) return null;
  if (typeof s.stepId !== 'string' || !STEP_RE.test(s.stepId) || (s.kind !== 'prompt' && s.kind !== 'script') || !RUN_STATUSES.has(s.status as string)) return null;
  const endedAt = natOrNull(s.endedAt), error = line(s.error, 500);
  if (!nat(s.startedAt) || endedAt === undefined || error === undefined) return null;
  return {
    id: s.id, runId: s.runId, stepId: s.stepId, kind: s.kind, status: s.status as StepRunRow['status'],
    workspaceId: s.workspaceId === origin ? origin : null,
    brokerSessionId: typeof s.brokerSessionId === 'string' && SESSION_RE.test(s.brokerSessionId) ? s.brokerSessionId : null,
    startedAt: s.startedAt, endedAt, error, detail: stepDetail(s.detail)
  };
}

function run(v: unknown, origin: string): RunRow | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ULID_RE.test(r.id) || typeof r.automationId !== 'string' || !ULID_RE.test(r.automationId)) return null;
  const t = r.trigger as Record<string, unknown> | null;
  if (!t || typeof t !== 'object' || !TRIGGER_KINDS.has(t.kind as string) || !nat(r.version) || !RUN_STATUSES.has(r.status as string)) return null;
  const a = args(r.args), endedAt = natOrNull(r.endedAt), error = line(r.error, 500);
  if (!a || !nat(r.startedAt) || endedAt === undefined || error === undefined || !Array.isArray(r.steps)) return null;
  const trigger: RunRow['trigger'] = { kind: t.kind as RunRow['trigger']['kind'] };
  if (t.by !== undefined) {
    const by = source(t.by, origin);
    if (by) trigger.by = by;
  }
  if (typeof t.cron === 'string') trigger.cron = oneLine(t.cron, 128);
  const e = t.event as Record<string, unknown> | undefined;
  if (e && typeof e === 'object' && EVENT_NAMES.has(e.on as string) && nat(e.count)) {
    trigger.event = { on: e.on as 'todo.created', count: e.count, ...(typeof e.todoTitle === 'string' ? { todoTitle: oneLine(e.todoTitle, 200) } : {}) };
  }
  const steps = r.steps.slice(0, 10).map((s) => step(s, origin)).filter((s): s is StepRunRow => s !== null);
  const out: RunRow = { id: r.id, automationId: r.automationId, version: r.version, trigger, args: a, status: r.status as RunRow['status'], startedAt: r.startedAt, endedAt, error, steps };
  const rs = r.reschedule as Record<string, unknown> | undefined;
  if (rs && typeof rs === 'object' && nat(rs.requestedAt) && natOrNull(rs.appliedAt) !== undefined && typeof rs.clamped === 'boolean' && typeof rs.by === 'string') {
    out.reschedule = {
      requestedAt: rs.requestedAt, appliedAt: rs.appliedAt as number | null, clamped: rs.clamped, by: oneLine(rs.by, 64),
      ...(typeof rs.reason === 'string' ? { reason: oneLine(rs.reason, 200) } : {})
    };
  }
  return out;
}

function automation(v: unknown, origin: string): AutomationCore | null {
  const a = v as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !ULID_RE.test(a.id) || typeof a.enabled !== 'boolean' || !nat(a.version)) return null;
  const def = definition(a.definition, origin);
  if (!def || def.name !== a.name) return null;
  const createdBy = source(a.createdBy, origin);
  const lastScheduledAt = natOrNull(a.lastScheduledAt), nextFireAt = natOrNull(a.nextFireAt), nextSetByRun = ulidOrNull(a.nextSetByRun);
  const w = a.weekStats as Record<string, unknown> | null;
  const t = tags(a.tags), summaries = lines(a.triggerSummaries, 10, 200);
  if (!createdBy || !nat(a.createdAt) || !nat(a.updatedAt) || lastScheduledAt === undefined || nextFireAt === undefined || nextSetByRun === undefined) return null;
  if (!w || typeof w !== 'object' || !nat(w.runs) || !nat(w.nothingToDo) || !nat(w.failed) || !t || !summaries) return null;
  const rawLastRun = a.lastRun === null ? null : run(a.lastRun, origin);
  if (a.lastRun !== null && !rawLastRun) return null;
  // A lastRun filed under another automation is a host bug, not a reason to drop the automation itself.
  const lastRun = rawLastRun && rawLastRun.automationId === a.id ? rawLastRun : null;
  const managedBy = (a.origin as { source?: unknown } | null)?.source === 'host-config' ? 'host-config' as const : null;
  return {
    id: a.id, name: def.name, description: def.description ? oneLine(def.description, 500) : null, enabled: a.enabled, version: a.version,
    definition: def, tags: t, createdBy, createdAt: a.createdAt, updatedAt: a.updatedAt, lastScheduledAt, nextFireAt, nextSetByRun,
    lastRun, weekStats: { runs: w.runs, nothingToDo: w.nothingToDo, failed: w.failed }, triggerSummaries: summaries, managedBy
  };
}

export function parseAutomationRows(v: unknown, origin: string): AutomationCore[] {
  return rows(v, MAX_REMOTE_AUTOMATIONS, 'automations').map((x) => automation(x, origin)).filter((x): x is AutomationCore => x !== null);
}

export function parseAutomationDetail(v: unknown, origin: string): { automation: AutomationCore; runs: RunRow[]; yaml: string } | null {
  if (v === null) return null;
  const d = v as { automation?: unknown; runs?: unknown; yaml?: unknown } | null;
  if (!d || typeof d !== 'object' || !Array.isArray(d.runs) || typeof d.yaml !== 'string') return fail('automation detail');
  const a = automation(d.automation, origin);
  if (!a) return fail('automation');
  return {
    automation: a,
    runs: d.runs.slice(0, MAX_REMOTE_RUNS).map((r) => run(r, origin)).filter((r): r is RunRow => r !== null && r.automationId === a.id),
    yaml: block(d.yaml, 64 * 1024)
  };
}

function todoRow(v: unknown, origin: string): Todo | null {
  const t = v as Record<string, unknown> | null;
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ULID_RE.test(t.id) || typeof t.title !== 'string') return null;
  const src = source(t.source, origin);
  const body = blockOrNull(t.body, 20_000), dedupeKey = line(t.dedupeKey, 200), closedAt = natOrNull(t.closedAt), sourceRunId = ulidOrNull(t.sourceRunId);
  const tg = tags(t.tags);
  if (!src || body === undefined || dedupeKey === undefined || closedAt === undefined || sourceRunId === undefined || !tg) return null;
  if (!TODO_STATUSES.has(t.status as string) || !PRIORITIES.has(t.priority as string) || !nat(t.seenCount) || typeof t.recurred !== 'boolean') return null;
  for (const k of ['createdAt', 'updatedAt', 'firstSeenAt', 'lastSeenAt']) if (!nat(t[k])) return null;
  return {
    id: t.id, title: oneLine(t.title, 200), body, status: t.status as Todo['status'], priority: t.priority as Todo['priority'], source: src,
    sourceRunId, viaWorkspace: t.viaWorkspace === origin ? origin : null, dedupeKey, seenCount: t.seenCount, recurred: t.recurred,
    workspaceId: t.workspaceId === origin ? origin : null,
    sessionId: typeof t.sessionId === 'string' && SESSION_RE.test(t.sessionId) ? t.sessionId : null,
    tags: tg, createdAt: t.createdAt as number, updatedAt: t.updatedAt as number, firstSeenAt: t.firstSeenAt as number, lastSeenAt: t.lastSeenAt as number, closedAt
  };
}

export function parseTodoRows(v: unknown, origin: string): Todo[] {
  return rows(v, MAX_REMOTE_TODOS, 'todos').map((x) => todoRow(x, origin)).filter((x): x is Todo => x !== null);
}

function todoEvent(v: unknown, origin: string): TodoEvent | null {
  const e = v as Record<string, unknown> | null;
  if (!e || typeof e !== 'object' || !nat(e.id) || typeof e.todoId !== 'string' || !nat(e.ts) || !TODO_EVENT_KINDS.has(e.kind as string)) return null;
  const actor = source(e.actor, origin), runId = ulidOrNull(e.runId);
  if (!actor || runId === undefined) return null;
  let detail: Record<string, unknown> | null = null;
  if (e.detail && typeof e.detail === 'object' && !Array.isArray(e.detail)) {
    const flat = Object.entries(e.detail as Record<string, unknown>).slice(0, 10);
    if (flat.every(([, x]) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) {
      detail = Object.fromEntries(flat.map(([k, x]) => [oneLine(k, 64), typeof x === 'string' ? oneLine(x, 200) : x]));
    }
  }
  return { id: e.id, todoId: e.todoId, ts: e.ts, kind: e.kind as TodoEvent['kind'], actor, runId, detail };
}

export function parseTodoDetail(v: unknown, origin: string): { todo: Todo; events: TodoEvent[] } | null {
  if (v === null) return null;
  const d = v as { todo?: unknown; events?: unknown } | null;
  if (!d || typeof d !== 'object' || !Array.isArray(d.events)) return fail('todo detail');
  const todo = todoRow(d.todo, origin);
  if (!todo) return fail('todo');
  return { todo, events: d.events.slice(-MAX_REMOTE_EVENTS).map((e) => todoEvent(e, origin)).filter((e): e is TodoEvent => e !== null && e.todoId === todo.id) };
}

function proposalItem(v: unknown, origin: string): ProposalItem | null {
  const i = v as Record<string, unknown> | null;
  if (!i || typeof i !== 'object' || typeof i.lowRisk !== 'boolean' || !DECISIONS.has(i.decision as string)) return null;
  const after = definition(i.after, origin);
  const before = i.before === null ? null : definition(i.before, origin);
  const automationId = ulidOrNull(i.automationId), baseVersion = natOrNull(i.baseVersion);
  const reasons = lines(i.reasons, 10, 200), flags = lines(i.flags, 10, 200);
  if (!after || (i.before !== null && !before) || automationId === undefined || baseVersion === undefined || !reasons || !flags) return null;
  return { automationId, name: after.name, baseVersion, before, after, lowRisk: i.lowRisk, reasons, flags, decision: i.decision as ProposalItem['decision'] };
}

function proposal(v: unknown, origin: string): Proposal | null {
  const p = v as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ULID_RE.test(p.id)) return null;
  if ((p.kind !== 'new' && p.kind !== 'change' && p.kind !== 'batch') || !PROPOSAL_STATUSES.has(p.status as string)) return null;
  if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > MAX_PROPOSAL_ITEMS) return null;
  const proposer = source(p.proposer, origin), rationale = blockOrNull(p.rationale, 2000), note = blockOrNull(p.note, 2000), decidedAt = natOrNull(p.decidedAt);
  if (!proposer || rationale === undefined || note === undefined || decidedAt === undefined || !nat(p.createdAt)) return null;
  const items = p.items.map((x) => proposalItem(x, origin));
  if (items.some((x) => x === null)) return null;
  return { id: p.id, kind: p.kind, proposer, rationale, status: p.status as Proposal['status'], items: items as ProposalItem[], note, createdAt: p.createdAt, decidedAt };
}

export function parseProposalRows(v: unknown, origin: string): Proposal[] {
  return rows(v, MAX_REMOTE_PROPOSALS, 'proposals').map((x) => proposal(x, origin)).filter((x): x is Proposal => x !== null);
}

export function parseCounts(v: unknown): Required<InboxCounts> {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || !nat(c.open) || !nat(c.urgent) || !nat(c.high)) return fail('counts');
  return { open: c.open, urgent: c.urgent, high: c.high, approvals: nat(c.approvals) ? c.approvals : 0 };
}

export function parseNoticeRows(v: unknown): RemoteNotice[] {
  const out: RemoteNotice[] = [];
  for (const x of rows(v, MAX_REMOTE_NOTICES, 'notices')) {
    const n = x as Record<string, unknown> | null;
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !ULID_RE.test(n.id) || !nat(n.ts) || typeof n.title !== 'string') continue;
    if (!NOTICE_KINDS.includes(n.kind as RemoteNotice['kind']) || !PRIORITIES.has(n.priority as string)) continue;
    const body = blockOrNull(n.body, 2000), dedupeKey = line(n.dedupeKey, 200);
    if (body === undefined || dedupeKey === undefined) continue;
    out.push({ id: n.id, ts: n.ts, kind: n.kind as RemoteNotice['kind'], title: oneLine(n.title, 200), body, priority: n.priority as RemoteNotice['priority'], dedupeKey: dedupeKey || null });
  }
  return out;
}

const RESULT_KEYS = ['runId', 'id', 'status', 'sessionId'] as const;

/** Only the action results' known string fields; anything else is dropped. */
function actionResult(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of RESULT_KEYS) if (typeof o[k] === 'string') out[k] = oneLine(o[k] as string, 128);
  return out;
}

export function parseActionReply(v: unknown): HostActionReply {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.replayed !== 'boolean' || (r.error !== null && typeof r.error !== 'string')) return fail('action reply');
  return { replayed: r.replayed, result: actionResult(r.result), error: r.error === null ? null : oneLine(r.error, 500) };
}
