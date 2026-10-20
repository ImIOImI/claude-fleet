// Inbox effects shared by the renderer IPC and the workspace MCP tools (#407).
// The MCP caller id is host-stamped by mcpServer (ambient socket identity).
import type { InboxConfig, Todo, TodoEvent, TodoFilter, UpdateTodoPatch, InboxCounts } from '../../preload/inboxTypes.js';
import { InboxStore } from './inboxDb.js';
import { validatePostInput, isPriority, InboxInputError, normalizeTags } from './inboxCore.js';
import { canPost, postLimit, PostRateLimiter, canUpdate, canSee } from './inboxPolicy.js';
import type { NotifyService } from './notifyService.js';

export interface InboxServiceDeps {
  manifest(id: string): Promise<{ inbox?: InboxConfig } | null>;
  notifyChanged(): void;
  now?: () => number;
  onPostRejected?(workspaceId: string, reason: string): void;
  /** Phase 2: notification side-effects of posts. Optional so Phase 1 tests stay unwired. */
  notifications?: Pick<NotifyService, 'onTodoPosted' | 'request'>;
  /** Phase 3: a run_id names a live automation run that targets the caller. */
  attribution?(runId: string, callerId: string): { automationId: string } | null;
  /** Phase 4: a todo was created (event triggers). */
  onTodoCreated?(todo: Todo): void;
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

  /** A post naming run_id is attributed to that automation, if the run is live and targets the caller. */
  function runSource(callerId: string, raw: unknown): { automationId: string; runId: string } | null {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') throw new InboxInputError('run_id must be a string');
    const at = deps.attribution?.(raw, callerId);
    if (!at) throw new InboxInputError(`run_id ${raw} is not an active automation run that prompted this workspace`);
    return { automationId: at.automationId, runId: raw };
  }

  /** Phase 1 gate shared by post_todo and notify: permission, then the hourly cap. */
  async function gatePost(callerId: string): Promise<void> {
    const cfg = await callerConfig(callerId);
    if (!canPost(cfg)) {
      deps.onPostRejected?.(callerId, 'posting disabled');
      throw new Error('this workspace is not allowed to post to the inbox (Edit workspace › Inbox & automations)');
    }
    const max = postLimit(cfg);
    const gate = limiter.take(callerId, max, now());
    if (!gate.ok) {
      deps.onPostRejected?.(callerId, `post limit ${max}/hour`);
      throw new Error(`post limit (${max}/hour) reached; retryAfterMs=${gate.retryAfterMs}`);
    }
  }

  async function callerConfig(callerId: string): Promise<InboxConfig | undefined> {
    const m = await deps.manifest(callerId);
    if (!m) throw new Error(`unknown workspace ${callerId}`);
    return m.inbox;
  }

  const mcp = {
    async post(callerId: string, args: Record<string, unknown>): Promise<unknown> {
      const input = validatePostInput(args);
      const run = runSource(callerId, args.run_id);
      await gatePost(callerId);
      const { todo, action } = store.post(
        run ? { kind: 'automation', id: run.automationId } : { kind: 'workspace', id: callerId },
        { ...input, workspaceLink: input.workspaceLink ?? callerId, ...(run ? { viaWorkspace: callerId, sourceRunId: run.runId } : {}) },
        now()
      );
      deps.notifyChanged();
      deps.notifications?.onTodoPosted(todo, action, args.notify === true);
      if (action === 'created') deps.onTodoCreated?.(todo);
      return { id: todo.id, action, status: todo.status, seenCount: todo.seenCount };
    },
    async notify(callerId: string, args: Record<string, unknown>): Promise<unknown> {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) throw new InboxInputError('title is required');
      if (title.length > 200) throw new InboxInputError('title is longer than 200 characters');
      const priority = args.priority === undefined ? 'normal' : args.priority;
      if (!isPriority(priority)) throw new InboxInputError('priority must be one of low, normal, high, urgent');
      const body = typeof args.body === 'string' ? args.body.slice(0, 2000) : null;
      const todoId = typeof args.todo_id === 'string' ? args.todo_id : null;
      if (todoId) {
        const t = store.get(todoId);
        if (!t || !canSee(callerId, t)) throw new Error(`todo ${todoId} not found`);
      }
      const run = runSource(callerId, args.run_id);
      await gatePost(callerId);
      if (!deps.notifications) throw new Error('notifications are unavailable');
      const n = deps.notifications.request({
        kind: 'post', title, body, priority,
        source: run ? { kind: 'automation', id: run.automationId } : { kind: 'workspace', id: callerId }, todoId, workspaceId: callerId,
        dedupeKey: typeof args.key === 'string' && args.key.trim() ? args.key.trim().slice(0, 200) : null,
        tags: normalizeTags(args.tags)
      });
      return { id: n.id, delivered: n.delivered, heldReason: n.heldReason };
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
      const { todo, action } = store.post({ kind: 'user', id: null }, validatePostInput(input), now());
      deps.notifyChanged();
      if (action === 'created') deps.onTodoCreated?.(todo);
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

  /** Host-trusted posts from automation script steps (#407 Phase 7): no workspace gate, attributed to the automation and run. */
  const host = {
    async todoFromAutomation(automationId: string, runId: string, args: Record<string, unknown>): Promise<void> {
      const input = validatePostInput(args);
      const { todo, action } = store.post({ kind: 'automation', id: automationId }, { ...input, sourceRunId: runId }, now());
      deps.notifyChanged();
      deps.notifications?.onTodoPosted(todo, action, args.notify === true);
      if (action === 'created') deps.onTodoCreated?.(todo);
    },
    async notifyFromAutomation(automationId: string, _runId: string, args: Record<string, unknown>): Promise<void> {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) throw new InboxInputError('title is required');
      if (title.length > 200) throw new InboxInputError('title is longer than 200 characters');
      const priority = args.priority === undefined ? 'normal' : args.priority;
      if (!isPriority(priority)) throw new InboxInputError('priority must be one of low, normal, high, urgent');
      if (!deps.notifications) throw new Error('notifications are unavailable');
      deps.notifications.request({
        kind: 'post', title, body: typeof args.body === 'string' ? args.body.slice(0, 2000) : null, priority,
        source: { kind: 'automation', id: automationId }, todoId: null, workspaceId: null,
        dedupeKey: typeof args.key === 'string' && args.key.trim() ? args.key.trim().slice(0, 200) : null,
        tags: normalizeTags(args.tags)
      });
    }
  };

  return { mcp, ipc, host };
}
