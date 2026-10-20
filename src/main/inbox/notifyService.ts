// Notification effects (#407 Phase 2) — pure: clock, delivery, timers and the
// user's current view are injected, so the digest and needs-input timing are
// unit-testable. notifyIpc.ts binds it to Electron.
import type {
  EffectiveRule, NotificationKind, NotificationRow, QuietState, RuleScope, Todo, TodoPriority, TodoSource
} from '../../preload/inboxTypes.js';
import { NotifyStore } from './notifyStore.js';
import { activeDowntime, effectiveRule, nextDowntime, pauseActive, resolve, scopesFor, sourceScopeValue } from './notifyPolicy.js';

export interface NotifyDeps {
  store: NotifyStore;
  now(): number;
  /** Show it (OS notification or in-app toast); returns the channel used. */
  deliver(n: NotificationRow): 'os' | 'in-app';
  name(workspaceId: string): string;
  viewing(): { focused: boolean; workspaceId: string | null; inboxOpen: boolean };
  changed(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  priority: TodoPriority;
  source: TodoSource;
  todoId?: string | null;
  workspaceId?: string | null;
  dedupeKey?: string | null;
  tags?: string[];
}

export const INPUT_WAIT_DELAY_MS = 20_000;
export const RETENTION_MS = 30 * 86_400_000;
const HOUR = 3_600_000;

export function createNotifyService(deps: NotifyDeps) {
  const { store } = deps;
  const lastRejection = new Map<string, number>();
  const waitTimers = new Map<string, unknown>();
  const waiting = new Map<string, number>();

  function request(input: NotifyInput): NotificationRow {
    const now = deps.now();
    const tags = input.tags ?? [];
    const res = resolve(
      { kind: input.kind, priority: input.priority, source: input.source, dedupeKey: input.dedupeKey ?? null, tags },
      { rules: store.rules(), defaultLevel: store.getDefaultLevel(), pause: store.getPause(), downtimes: store.downtimes(), now }
    );
    const row = store.insert({
      ts: now, kind: input.kind, title: input.title, body: input.body ?? null, priority: input.priority,
      source: input.source, todoId: input.todoId ?? null, workspaceId: input.workspaceId ?? null,
      dedupeKey: input.dedupeKey ?? null, tags, delivered: res.deliver,
      heldReason: res.deliver ? null : res.heldReason, channel: null
    });
    if (res.deliver) {
      const channel = deps.deliver(row);
      store.setChannel(row.id, channel);
      row.channel = channel;
    }
    deps.changed();
    return row;
  }

  function sourceName(s: TodoSource): string {
    if (s.kind === 'user') return 'You';
    if (s.kind === 'workspace' && s.id) return deps.name(s.id);
    return 'automation';
  }

  return {
    request,

    /** A todo was posted/updated; notify when the poster asked, or when it arrives urgent. */
    onTodoPosted(todo: Todo, action: 'created' | 'updated' | 'reopened', notifyRequested: boolean): NotificationRow | null {
      const urgentArrival = todo.priority === 'urgent' && action !== 'updated';
      if (!notifyRequested && !urgentArrival) return null;
      return request({
        kind: 'todo',
        title: todo.priority === 'urgent' ? `Urgent · ${todo.title}` : todo.title,
        body: [sourceName(todo.source), todo.seenCount > 1 ? `seen ${todo.seenCount}×` : null, action === 'reopened' ? 'reopened' : null]
          .filter(Boolean).join(' · '),
        priority: todo.priority, source: todo.source, todoId: todo.id, workspaceId: todo.workspaceId,
        dedupeKey: todo.dedupeKey, tags: todo.tags
      });
    },

    /** A workspace's post was refused. Tell the user once per workspace per hour. */
    onPostRejected(workspaceId: string, reason: string): NotificationRow | null {
      const now = deps.now();
      const last = lastRejection.get(workspaceId);
      if (last !== undefined && now - last < HOUR) return null;
      lastRejection.set(workspaceId, now);
      const name = deps.name(workspaceId);
      const disabled = reason === 'posting disabled';
      return request({
        kind: 'post-rejected',
        title: disabled ? `${name} tried to post, but posting is off` : `${name} hit its post limit`,
        body: disabled ? 'Turn it on in Edit workspace › Inbox & automations.' : `${reason}. Further posts are rejected until the hour rolls over.`,
        priority: 'normal', source: { kind: 'workspace', id: workspaceId }, workspaceId
      });
    },

    /** The workspace's set of sessions waiting on AskUserQuestion changed. */
    onInputWait(workspaceId: string, waitingIds: string[]): void {
      const key = `input-wait:${workspaceId}`;
      if (waitingIds.length === 0) {
        waiting.delete(workspaceId);
        const t = waitTimers.get(workspaceId);
        if (t !== undefined) deps.clearTimer(t);
        waitTimers.delete(workspaceId);
        if (store.clearByKey(key, deps.now()).length) deps.changed();
        return;
      }
      if (waiting.has(workspaceId)) return; // already waiting: one notification per episode
      waiting.set(workspaceId, deps.now());
      waitTimers.set(workspaceId, deps.setTimer(() => {
        waitTimers.delete(workspaceId);
        if (!waiting.has(workspaceId)) return;
        const v = deps.viewing();
        if (v.focused && !v.inboxOpen && v.workspaceId === workspaceId) return;
        request({
          kind: 'input-wait', title: `${deps.name(workspaceId)} needs your input`,
          body: 'A session is waiting on a question.', priority: 'high',
          source: { kind: 'workspace', id: workspaceId }, workspaceId, dedupeKey: key
        });
      }, INPUT_WAIT_DELAY_MS));
    },

    /** Workspaces currently waiting on input (for the "needs you" count). */
    waitingWorkspaces(): string[] {
      return [...waiting.keys()];
    },

    /** Periodic: expire pauses, track quiet periods, send one digest when quiet ends. */
    tick(): NotificationRow | null {
      const now = deps.now();
      const pause = store.getPause();
      if (pause && !pauseActive(pause, now)) store.clearPause();
      const livePause = pauseActive(pause, now) ? pause : null;
      const dt = activeDowntime(store.downtimes(), now);
      const quiet = !!livePause || !!dt;
      const since = store.getQuietSince();
      if (quiet && since === null) {
        store.setQuietSince(Math.min(livePause?.setAt ?? now, dt?.start ?? now));
        return null;
      }
      if (!quiet && since !== null) {
        store.setQuietSince(null);
        const held = store.heldQuietSince(since);
        if (!held.length) {
          deps.changed();
          return null;
        }
        store.markDigested(held.map((n) => n.id));
        const inputs = held.filter((n) => n.kind === 'input-wait' && n.clearedAt === null).length;
        const todos = held.filter((n) => n.kind === 'todo').length;
        const urgent = held.filter((n) => n.priority === 'urgent').length;
        const other = held.length - inputs - todos;
        const parts = [
          inputs ? `${inputs} needs input` : null,
          todos ? `${todos} todo${todos > 1 ? 's' : ''}${urgent ? '' : ' (none urgent)'}` : null,
          other ? `${other} other` : null
        ].filter(Boolean);
        return request({
          kind: 'digest', title: `Notifications resumed: ${held.length} held`, body: parts.join(' · '),
          priority: urgent ? 'urgent' : 'normal', source: { kind: 'user', id: null }
        });
      }
      return null;
    },

    quietState(): QuietState {
      const now = deps.now();
      const pause = store.getPause();
      const ds = store.downtimes();
      const dt = activeDowntime(ds, now);
      const since = store.getQuietSince();
      return {
        pause: pauseActive(pause, now) ? pause : null,
        activeDowntime: dt?.downtime ?? null,
        nextDowntime: nextDowntime(ds, now),
        heldSinceQuiet: since === null ? 0 : store.heldQuietSince(since).length
      };
    },

    test(): NotificationRow {
      return request({
        kind: 'test', title: 'Test notification', body: 'This is how claude-fleet notifications reach you.',
        priority: 'normal', source: { kind: 'user', id: null }
      });
    },

    prune(): number {
      return store.prune(deps.now() - RETENTION_MS);
    },

    /** Rule scopes the 🔔 popover offers for an item (no global — that lives in Settings). */
    scopesFor(item: { source: TodoSource; dedupeKey: string | null; tags: string[] }): RuleScope[] {
      const src = sourceScopeValue(item.source);
      return [
        ...(item.dedupeKey ? [{ scopeKind: 'key' as const, scopeValue: `${src}:${item.dedupeKey}`, label: 'This item' }] : []),
        { scopeKind: 'source' as const, scopeValue: src, label: sourceName(item.source) },
        ...item.tags.slice(0, 1).map((t) => ({ scopeKind: 'tag' as const, scopeValue: t, label: `#${t}` }))
      ];
    },

    effectiveFor(item: { kind?: NotificationKind; priority: TodoPriority; source: TodoSource; dedupeKey: string | null; tags: string[] }): EffectiveRule {
      return effectiveRule(
        { kind: item.kind ?? 'todo', priority: item.priority, source: item.source, dedupeKey: item.dedupeKey, tags: item.tags },
        store.rules(), store.getDefaultLevel(), deps.now()
      );
    }
  };
}

export type NotifyService = ReturnType<typeof createNotifyService>;
