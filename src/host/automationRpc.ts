// automations:*, inbox:*, proposals:* and notices:feed for the desktop's
// federated Inbox (remote-workspaces (g)). Reads need `read`; every action
// needs `steer` and runs at most once per request id (D128).
import type { Automation, InboxCounts, NotificationRow, Proposal, RunRow, Todo, TodoEvent, TodoSource, UpdateTodoPatch } from '../preload/inboxTypes.js';
import type { RunRequest } from '../main/automations/automationService.js';
import { actionChannel, ACTION_LIMITS, type ActionLedger } from './hostActions.js';
import type { Principal } from './attachHub.js';
import type { HostAutomations } from './hostAutomations.js';
import { UnauthLimiter } from './rateLimit.js';
import { RpcArgError, RpcUnavailableError, type RpcChannel } from './rpc.js';

export interface AutomationRuntime {
  workspace(): { id: string; name: string };
  ledger: ActionLedger;
  automations: {
    list(): Promise<Automation[]>;
    get(id: string): Promise<{ automation: Automation; runs: RunRow[]; yaml: string; versions: number[] } | null>;
    run(id: string, req: RunRequest): Promise<RunRow>;
  };
  proposals: {
    list(): Promise<Proposal[]>;
    reject(id: string, note: string | null, by: TodoSource): Promise<Proposal>;
  };
  inbox: {
    list(f: { status: 'open' | 'done' | 'dismissed' | 'all'; limit: number }): Promise<Todo[]>;
    get(id: string): Promise<{ todo: Todo; events: TodoEvent[] } | null>;
    counts(): Promise<InboxCounts>;
    create(input: Record<string, unknown>, by: TodoSource): Promise<Todo>;
    update(id: string, patch: UpdateTodoPatch, by: TodoSource): Promise<Todo>;
  };
  notices: { feed(o: { sinceTs: number | null; limit: number }): Promise<NotificationRow[]> };
}

export interface Limiters { run: UnauthLimiter; other: UnauthLimiter }

export function defaultLimiters(): Limiters {
  const mk = (max: number) => new UnauthLimiter({ max, windowMs: 60_000, maxIps: 10_000 });
  return { run: mk(ACTION_LIMITS.run), other: mk(ACTION_LIMITS.other) };
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUSES = new Set(['open', 'done', 'dismissed', 'all']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** D135 caps. */
export const MAX_AUTOMATIONS = 100;
export const MAX_RUNS = 30;
export const MAX_TODOS = 200;
export const MAX_TODO_EVENTS = 100;
export const MAX_PROPOSALS = 100;
export const MAX_NOTICES = 100;

const ulid = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !ULID_RE.test(v)) throw new RpcArgError(`${what} must be an id`);
  return v;
};
const str = (v: unknown, what: string, max: number, min = 0): string => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new RpcArgError(`${what} must be ${min ? `1–${max}` : `at most ${max}`} characters`);
  return v;
};
const tagList = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.length > 20 || !v.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 64)) throw new RpcArgError(`${what} must be up to 20 tags`);
  return v as string[];
};
const plainObject = (v: unknown, what: string): Record<string, unknown> => {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new RpcArgError(`${what} must be an object`);
  return v as Record<string, unknown>;
};
const clampLimit = (v: unknown, max: number): number => (typeof v === 'number' && Number.isSafeInteger(v) ? Math.min(Math.max(v, 1), max) : max);

/** The proposal service's note cap. */
const MAX_NOTE = 2000;

/** Proposals carry no decider column: the note names the person, and the session reads it with get_proposal (D130). */
export function rejectedNote(note: string | null, by: TodoSource): string {
  const head = `Rejected by ${by.id ? `@${by.id}` : 'host operator'}`;
  const text = note?.trim();
  if (!text) return head;
  const prefix = `${head}: `;
  return prefix + text.slice(0, MAX_NOTE - prefix.length).trimEnd();
}

/** The person behind an action, for todo sources, event actors and run triggers (D130). */
export const personOf = (c: Principal): TodoSource => ({ kind: 'user', id: c.identity.login });

export function parseRunArgs(v: unknown): Record<string, string | number | boolean> {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RpcArgError('args must be an object');
  const e = Object.entries(v as Record<string, unknown>);
  if (e.length > 32) throw new RpcArgError('args: at most 32 parameters');
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of e) {
    if (!PARAM_RE.test(k)) throw new RpcArgError(`args.${k.slice(0, 64)}: not a parameter name`);
    if (typeof x === 'string' && x.length <= 2000) out[k] = x;
    else if (typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) out[k] = x;
    else throw new RpcArgError(`args.${k}: a string (≤2000), number or boolean`);
  }
  return out;
}

export function parseTodoPatch(v: unknown): UpdateTodoPatch {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RpcArgError('patch must be an object');
  const o = v as Record<string, unknown>;
  const p: UpdateTodoPatch = {};
  for (const k of Object.keys(o)) if (!['status', 'priority', 'title', 'tagsAdd', 'tagsRemove', 'bodyAppend'].includes(k)) throw new RpcArgError(`patch.${k.slice(0, 32)} is not allowed`);
  if (o.status !== undefined) {
    if (o.status !== 'open' && o.status !== 'done' && o.status !== 'dismissed') throw new RpcArgError('patch.status must be open, done or dismissed');
    p.status = o.status;
  }
  if (o.priority !== undefined) {
    if (typeof o.priority !== 'string' || !PRIORITIES.has(o.priority)) throw new RpcArgError('patch.priority must be low, normal, high or urgent');
    p.priority = o.priority as UpdateTodoPatch['priority'];
  }
  if (o.title !== undefined) p.title = str(o.title, 'patch.title', 200, 1);
  if (o.tagsAdd !== undefined) p.tagsAdd = tagList(o.tagsAdd, 'patch.tagsAdd');
  if (o.tagsRemove !== undefined) p.tagsRemove = tagList(o.tagsRemove, 'patch.tagsRemove');
  if (o.bodyAppend !== undefined) p.bodyAppend = str(o.bodyAppend, 'patch.bodyAppend', 2000, 1);
  if (Object.keys(p).length === 0) throw new RpcArgError('patch is empty');
  return p;
}

export function automationRpcChannels(rt: () => AutomationRuntime | null, o: { limiters?: Limiters } = {}): Map<string, RpcChannel> {
  const lim = o.limiters ?? defaultLimiters();
  const need = (): AutomationRuntime => {
    const r = rt();
    if (!r) throw new RpcUnavailableError('automations unavailable');
    return r;
  };
  const ledger = () => rt()?.ledger ?? null;
  const read = (handle: RpcChannel['handle']): RpcChannel => ({ tier: 'read', handle });

  return new Map<string, RpcChannel>([
    ['automations:list', read(async () => ({ rows: (await need().automations.list()).slice(0, MAX_AUTOMATIONS) }))],
    ['automations:get', read(async ([id]) => {
      const d = await need().automations.get(ulid(id, 'id'));
      return d ? { automation: d.automation, runs: d.runs.slice(0, MAX_RUNS), yaml: d.yaml } : null;
    })],
    ['inbox:list', read(async ([f]) => {
      const x = plainObject(f, 'filter');
      const status = x.status ?? 'open';
      if (typeof status !== 'string' || !STATUSES.has(status)) throw new RpcArgError('status must be open, done, dismissed or all');
      const limit = clampLimit(x.limit, MAX_TODOS);
      return { rows: (await need().inbox.list({ status: status as 'open', limit })).slice(0, limit) };
    })],
    ['inbox:get', read(async ([id]) => {
      const d = await need().inbox.get(ulid(id, 'id'));
      return d ? { todo: d.todo, events: d.events.slice(-MAX_TODO_EVENTS) } : null;
    })],
    ['inbox:counts', read(async () => need().inbox.counts())],
    ['proposals:list', read(async () => ({ rows: (await need().proposals.list()).slice(0, MAX_PROPOSALS) }))],
    ['notices:feed', read(async ([q]) => {
      const x = plainObject(q, 'query');
      let sinceTs: number | null = null;
      if (x.sinceTs !== undefined && x.sinceTs !== null) {
        if (typeof x.sinceTs !== 'number' || !Number.isSafeInteger(x.sinceTs) || x.sinceTs < 0) throw new RpcArgError('sinceTs must be epoch ms');
        sinceTs = x.sinceTs;
      }
      const limit = clampLimit(x.limit, MAX_NOTICES);
      return { rows: (await need().notices.feed({ sinceTs, limit })).slice(0, limit) };
    })],

    ['automations:run', actionChannel({
      tier: 'steer', channel: 'automations:run', ledger, limit: { key: 'run', limiter: lim.run },
      parse: (x) => ({ id: ulid(x.id, 'id'), args: parseRunArgs(x.args) }),
      run: async ({ id, args }, caller) => {
        const r = need();
        const d = await r.automations.get(id);
        if (!d) throw new Error('automation not found');
        // D125: the run-time origin gate inside run() refuses anything not from the host config.
        if (!d.automation.enabled) throw new Error(`${d.automation.name} is disabled in the host config`);
        const run = await r.automations.run(id, { kind: 'manual', by: personOf(caller), args, coerce: true });
        return { runId: run.id, status: run.status };
      }
    })],
    ['inbox:create', actionChannel({
      tier: 'steer', channel: 'inbox:create', ledger, limit: { key: 'other', limiter: lim.other },
      parse: (x) => {
        const i = x.input;
        if (!i || typeof i !== 'object' || Array.isArray(i)) throw new RpcArgError('input must be an object');
        const v = i as Record<string, unknown>;
        const out: Record<string, unknown> = { title: str(v.title, 'input.title', 200, 1) };
        if (v.priority !== undefined) {
          if (typeof v.priority !== 'string' || !PRIORITIES.has(v.priority)) throw new RpcArgError('input.priority must be low, normal, high or urgent');
          out.priority = v.priority;
        }
        if (v.body !== undefined) out.body = str(v.body, 'input.body', 20_000);
        if (v.tags !== undefined) out.tags = tagList(v.tags, 'input.tags');
        return out;
      },
      run: async (input, caller) => {
        const t = await need().inbox.create(input, personOf(caller));
        return { id: t.id };
      }
    })],
    ['inbox:update', actionChannel({
      tier: 'steer', channel: 'inbox:update', ledger, limit: { key: 'other', limiter: lim.other },
      parse: (x) => ({ id: ulid(x.id, 'id'), patch: parseTodoPatch(x.patch) }),
      run: async ({ id, patch }, caller) => {
        const t = await need().inbox.update(id, patch, personOf(caller));
        return { id: t.id, status: t.status };
      }
    })],
    ['proposals:reject', actionChannel({
      tier: 'steer', channel: 'proposals:reject', ledger, limit: { key: 'other', limiter: lim.other },
      parse: (x) => ({ id: ulid(x.id, 'id'), note: x.note === undefined || x.note === null ? null : str(x.note, 'note', 2000) }),
      run: async ({ id, note }, caller) => {
        const p = await need().proposals.reject(id, note, personOf(caller));
        return { id: p.id, status: p.status };
      }
    })]
  ]);
}

/** The holder's automation services as the RPC runtime. */
export function runtimeOf(h: HostAutomations, workspace: () => { id: string; name: string }): AutomationRuntime {
  return {
    workspace,
    ledger: h.ledger,
    automations: { list: () => h.automations.list(), get: (id) => h.automations.get(id), run: (id, req) => h.automations.run(id, req) },
    proposals: { list: () => h.proposals.list(), reject: (id, note, by) => h.proposals.reject(id, rejectedNote(note, by)) },
    inbox: {
      list: (f) => h.inbox.ipc.list(f),
      get: (id) => h.inbox.ipc.get(id),
      counts: () => h.inbox.ipc.counts(),
      create: (input, by) => h.inbox.ipc.create(input, by),
      update: (id, patch, by) => h.inbox.ipc.update(id, patch as Record<string, unknown>, by)
    },
    notices: h.notices
  };
}
