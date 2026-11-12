// Remote automations, todos and proposals for the Inbox. Reads fan out
// (live-only, validated); each action is one RPC to the host that owns the
// row, which tier-checks it. Main checks shapes and forwards only known fields.
import type { IpcMain } from 'electron';
import type { TodoEvent, UpdateTodoPatch } from '../../preload/inboxTypes.js';
import type {
  Federated, RemoteAutomation, RemoteAutomationDetail, RemoteCounts, RemoteOriginInfo, RemoteProposal, RemoteTodo
} from '../../preload/remoteAutomations.js';
import { REQUEST_ID_RE } from '../../preload/remoteAutomations.js';
import type { RemoteSourceInfo } from '../remote.js';
import { oneLine } from '../remoteUrl.js';
import type { FederatedReader } from './federatedReader.js';
import { parseAutomationDetail, parseAutomationRows, parseCounts, parseProposalRows, parseTodoDetail, parseTodoRows } from './remoteAutomationRows.js';

export { actionError } from './actionError.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const LIST_STATUSES = new Set(['open', 'done', 'dismissed', 'all']);
const TODO_STATUSES = new Set(['open', 'done', 'dismissed']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const PATCH_KEYS = new Set(['status', 'priority', 'title', 'tagsAdd', 'tagsRemove', 'bodyAppend']);

const originInfo = (s: RemoteSourceInfo): RemoteOriginInfo => ({ origin: s.id, workspaceName: s.name, workspaceColorHue: s.hue, tier: s.tier });

function origin(v: unknown): string {
  if (typeof v !== 'string' || !ULID_RE.test(v)) throw new Error('origin must be a remote workspace id');
  return v;
}
function id(v: unknown): string {
  if (typeof v !== 'string' || !ULID_RE.test(v)) throw new Error('id must be an id');
  return v;
}
function requestId(v: unknown): string {
  if (typeof v !== 'string' || !REQUEST_ID_RE.test(v)) throw new Error('requestId must be a lowercase UUID v4');
  return v;
}
function title(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 200) throw new Error(`${what} must be 1–200 characters`);
  return v.trim();
}
function priority(v: unknown, what: string): UpdateTodoPatch['priority'] {
  if (typeof v !== 'string' || !PRIORITIES.has(v)) throw new Error(`${what} must be low, normal, high or urgent`);
  return v as UpdateTodoPatch['priority'];
}
function tagList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length > 20 || !v.every((t) => typeof t === 'string' && t.length >= 1 && t.length <= 64)) {
    throw new Error(`${what} must be up to 20 tags of 1–64 characters`);
  }
  return [...v] as string[];
}
function runArgs(v: unknown): Record<string, string | number | boolean> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('args must be an object');
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 32)) {
    if (k.length > 64) throw new Error(`args key must be at most 64 characters: "${oneLine(k, 80)}"`);
    if (!((typeof x === 'string' && x.length <= 2000) || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)))) {
      throw new Error(`args.${k} must be a string ≤2000, number or boolean`);
    }
    out[k] = x;
  }
  return out;
}
function patch(v: unknown): UpdateTodoPatch {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('patch must be an object');
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (!keys.length || !keys.every((k) => PATCH_KEYS.has(k))) throw new Error('patch may set status, priority, title, tagsAdd, tagsRemove or bodyAppend');
  const p: UpdateTodoPatch = {};
  if (o.status !== undefined) {
    if (typeof o.status !== 'string' || !TODO_STATUSES.has(o.status)) throw new Error('patch.status must be open, done or dismissed');
    p.status = o.status as UpdateTodoPatch['status'];
  }
  if (o.priority !== undefined) p.priority = priority(o.priority, 'patch.priority');
  if (o.title !== undefined) p.title = title(o.title, 'patch.title');
  if (o.tagsAdd !== undefined) p.tagsAdd = tagList(o.tagsAdd, 'patch.tagsAdd');
  if (o.tagsRemove !== undefined) p.tagsRemove = tagList(o.tagsRemove, 'patch.tagsRemove');
  if (o.bodyAppend !== undefined) {
    if (typeof o.bodyAppend !== 'string' || !o.bodyAppend || o.bodyAppend.length > 20_000) throw new Error('patch.bodyAppend must be 1–20000 characters');
    p.bodyAppend = o.bodyAppend;
  }
  return p;
}

export function registerRemoteAutomationsIpc(ipc: Pick<IpcMain, 'handle'>, reader: FederatedReader): void {
  ipc.handle('remoteAutomations:list', async (): Promise<Federated<RemoteAutomation>> => {
    const r = await reader.each('automations:list', [], (v, s) => parseAutomationRows(v, s.id));
    return { items: r.values.flatMap(({ src, value }) => value.map((a) => ({ ...a, ...originInfo(src) }))), unavailable: r.unavailable };
  });
  ipc.handle('remoteAutomations:get', async (_e, o: unknown, a: unknown): Promise<RemoteAutomationDetail | null> => {
    const r = await reader.one(origin(o), 'automations:get', [id(a)], (v, s) => {
      const d = parseAutomationDetail(v, s.id);
      return d ? { ...d, automation: { ...d.automation, ...originInfo(s) } } : null;
    });
    return r?.ok ? r.value : null;
  });
  ipc.handle('remoteAutomations:run', async (_e, o: unknown, a: unknown, args: unknown, rid: unknown) =>
    reader.act(origin(o), 'automations:run', { requestId: requestId(rid), id: id(a), args: runArgs(args) }));

  ipc.handle('remoteInbox:list', async (_e, f: unknown): Promise<Federated<RemoteTodo>> => {
    if (f !== undefined && f !== null && (typeof f !== 'object' || Array.isArray(f))) throw new Error('filter must be an object');
    const status = (f as { status?: unknown } | null | undefined)?.status ?? 'open';
    if (typeof status !== 'string' || !LIST_STATUSES.has(status)) throw new Error('status must be open, done, dismissed or all');
    const r = await reader.each('inbox:list', [{ status, limit: 200 }], (v, s) => parseTodoRows(v, s.id));
    return { items: r.values.flatMap(({ src, value }) => value.map((t) => ({ ...t, ...originInfo(src) }))), unavailable: r.unavailable };
  });
  ipc.handle('remoteInbox:get', async (_e, o: unknown, t: unknown): Promise<{ todo: RemoteTodo; events: TodoEvent[] } | null> => {
    const r = await reader.one(origin(o), 'inbox:get', [id(t)], (v, s) => {
      const d = parseTodoDetail(v, s.id);
      return d ? { todo: { ...d.todo, ...originInfo(s) }, events: d.events } : null;
    });
    return r?.ok ? r.value : null;
  });
  ipc.handle('remoteInbox:counts', async (): Promise<RemoteCounts> => {
    const r = await reader.each('inbox:counts', [], (v) => parseCounts(v));
    const sum = { open: 0, urgent: 0, high: 0, approvals: 0 };
    for (const { value } of r.values) for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += value[k];
    return { ...sum, unavailable: r.unavailable };
  });
  ipc.handle('remoteInbox:create', async (_e, o: unknown, input: unknown, rid: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object');
    const i = input as { title?: unknown; priority?: unknown };
    const out: { title: string; priority?: UpdateTodoPatch['priority'] } = { title: title(i.title, 'input.title') };
    if (i.priority !== undefined) out.priority = priority(i.priority, 'input.priority');
    return reader.act(origin(o), 'inbox:create', { requestId: requestId(rid), input: out });
  });
  ipc.handle('remoteInbox:update', async (_e, o: unknown, t: unknown, p: unknown, rid: unknown) =>
    reader.act(origin(o), 'inbox:update', { requestId: requestId(rid), id: id(t), patch: patch(p) }));

  ipc.handle('remoteProposals:list', async (): Promise<Federated<RemoteProposal>> => {
    const r = await reader.each('proposals:list', [], (v, s) => parseProposalRows(v, s.id));
    return { items: r.values.flatMap(({ src, value }) => value.map((p) => ({ ...p, ...originInfo(src) }))), unavailable: r.unavailable };
  });
  ipc.handle('remoteProposals:reject', async (_e, o: unknown, p: unknown, note: unknown, rid: unknown) => {
    if (note !== null && note !== undefined && (typeof note !== 'string' || note.length > 2000)) throw new Error('note must be at most 2000 characters');
    return reader.act(origin(o), 'proposals:reject', { requestId: requestId(rid), id: id(p), note: note ?? null });
  });
}
