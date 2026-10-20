// Inbox effects shared by the renderer IPC and the workspace MCP tools (#407).
// The MCP caller id is host-stamped by mcpServer (ambient socket identity).
import type { InboxConfig, Todo, TodoEvent, TodoFilter, UpdateTodoPatch, InboxCounts } from '../../preload/inboxTypes.js';
import { InboxStore } from './inboxDb.js';
import { validatePostInput, isPriority, InboxInputError } from './inboxCore.js';
import { canPost, postLimit, PostRateLimiter, canUpdate, canSee } from './inboxPolicy.js';

export interface InboxServiceDeps {
  manifest(id: string): Promise<{ inbox?: InboxConfig } | null>;
  notifyChanged(): void;
  now?: () => number;
  onPostRejected?(workspaceId: string, reason: string): void;
}

const STATUSES = new Set(['open', 'done', 'dismissed']);

function toPatch(a: Record<string, unknown>): UpdateTodoPatch {
  const p: UpdateTodoPatch = {};
  if (a.status !== undefined) {
    if (typeof a.status !== 'string' || !STATUSES.has(a.status)) throw new InboxInputError('status must be open, done or dismissed');
    p.status = a.status as UpdateTodoPatch['status'];
  }
  if (a.priority !== undefined) {
    if (!isPriority(a.priority)) throw new InboxInputError('priority must be one of low, normal, high, urgent');
    p.priority = a.priority;
  }
  if (typeof a.title === 'string') p.title = a.title;
  const add = a.tags_add ?? a.tagsAdd;
  const rm = a.tags_remove ?? a.tagsRemove;
  if (Array.isArray(add)) p.tagsAdd = add as string[];
  if (Array.isArray(rm)) p.tagsRemove = rm as string[];
  const body = a.body_append ?? a.bodyAppend;
  if (typeof body === 'string') p.bodyAppend = body;
  return p;
}

function toFilter(a: Record<string, unknown>): TodoFilter {
  const f: TodoFilter = {};
  if (typeof a.status === 'string' && (STATUSES.has(a.status) || a.status === 'all')) f.status = a.status as TodoFilter['status'];
  if (Array.isArray(a.tags)) f.tags = a.tags.filter((t): t is string => typeof t === 'string');
  if (typeof a.limit === 'number') f.limit = a.limit;
  return f;
}

export function createInboxService(store: InboxStore, deps: InboxServiceDeps) {
  const limiter = new PostRateLimiter();
  const now = deps.now ?? Date.now;

  async function callerConfig(callerId: string): Promise<InboxConfig | undefined> {
    const m = await deps.manifest(callerId);
    if (!m) throw new Error(`unknown workspace ${callerId}`);
    return m.inbox;
  }

  const mcp = {
    async post(callerId: string, args: Record<string, unknown>): Promise<unknown> {
      const cfg = await callerConfig(callerId);
      if (!canPost(cfg)) {
        deps.onPostRejected?.(callerId, 'posting disabled');
        throw new Error('this workspace is not allowed to post to the inbox (Edit workspace › Inbox & automations)');
      }
      const input = validatePostInput(args);
      const max = postLimit(cfg);
      const gate = limiter.take(callerId, max, now());
      if (!gate.ok) {
        deps.onPostRejected?.(callerId, `post limit ${max}/hour`);
        throw new Error(`post limit (${max}/hour) reached; retryAfterMs=${gate.retryAfterMs}`);
      }
      const { todo, action } = store.post(
        { kind: 'workspace', id: callerId },
        { ...input, workspaceLink: input.workspaceLink ?? callerId },
        now()
      );
      deps.notifyChanged();
      return { id: todo.id, action, status: todo.status, seenCount: todo.seenCount };
    },
    async update(callerId: string, args: Record<string, unknown>): Promise<unknown> {
      await callerConfig(callerId);
      const id = typeof args.id === 'string' ? args.id : '';
      const cur = id ? store.get(id) : null;
      if (!cur) throw new Error(`todo ${id || '(missing id)'} not found`);
      if (!canUpdate(callerId, cur)) throw new Error('not permitted: a workspace can only update todos it posted');
      const todo = store.update({ kind: 'workspace', id: callerId }, id, toPatch(args), now());
      deps.notifyChanged();
      return todo;
    },
    async list(callerId: string, args: Record<string, unknown>): Promise<unknown> {
      const cfg = await callerConfig(callerId);
      const f = toFilter(args);
      const todos = store.list({ ...f, limit: Math.min(f.limit ?? 50, 200), ...(cfg?.canReadAll ? {} : { visibleTo: callerId }) });
      return todos.filter((t) => canSee(callerId, t, cfg));
    }
  };

  const ipc = {
    async list(filter: TodoFilter = {}): Promise<Todo[]> {
      return store.list(filter);
    },
    async get(id: string): Promise<{ todo: Todo; events: TodoEvent[] } | null> {
      const todo = store.get(id);
      return todo ? { todo, events: store.events(id) } : null;
    },
    async create(input: Record<string, unknown>): Promise<Todo> {
      const { todo } = store.post({ kind: 'user', id: null }, validatePostInput(input), now());
      deps.notifyChanged();
      return todo;
    },
    async update(id: string, patch: Record<string, unknown>): Promise<Todo> {
      const todo = store.update({ kind: 'user', id: null }, id, toPatch(patch), now());
      deps.notifyChanged();
      return todo;
    },
    async counts(): Promise<InboxCounts> {
      return store.counts();
    }
  };

  return { mcp, ipc };
}
