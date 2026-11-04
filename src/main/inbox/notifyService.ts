// Notification effects (#407 Phase 2) — pure: clock, delivery, timers and the
// user's current view are injected, so the digest and needs-input timing are
// unit-testable. notifyIpc.ts binds it to Electron. Async on the store layer;
// tick() is serialized so two overlapping ticks can't both send a digest.
import type {
  EffectiveRule, NotificationKind, NotificationRow, QuietState, RuleScope, Todo, TodoPriority, TodoSource
} from '../../preload/inboxTypes.js';
import { NotifyStore } from './notifyStore.js';
import { activeDowntime, effectiveRule, nextDowntime, pauseActive, resolve, sourceScopeValue } from './notifyPolicy.js';

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
  /** A timer-started notification failed (notifyIpc logs it). */
  onError?(e: unknown): void;
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
  let ticking: Promise<unknown> = Promise.resolve();

  async function request(input: NotifyInput): Promise<NotificationRow> {
    const now = deps.now();
    const tags = input.tags ?? [];
    const [rules, defaultLevel, pause, downtimes] = await Promise.all([store.rules(), store.getDefaultLevel(), store.getPause(), store.downtimes()]);
    const res = resolve(
      { kind: input.kind, priority: input.priority, source: input.source, dedupeKey: input.dedupeKey ?? null, tags },
      { rules, defaultLevel, pause, downtimes, now }
    );
    const row = await store.insert({
      ts: now, kind: input.kind, title: input.title, body: input.body ?? null, priority: input.priority,
      source: input.source, todoId: input.todoId ?? null, workspaceId: input.workspaceId ?? null,
      dedupeKey: input.dedupeKey ?? null, tags, delivered: res.deliver,
      heldReason: res.deliver ? null : res.heldReason, channel: null
    });
    if (res.deliver) {
      const channel = deps.deliver(row);
      await store.setChannel(row.id, channel);
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

  async function tickOnce(): Promise<NotificationRow | null> {
    const now = deps.now();
    const pause = await store.getPause();
    if (pause && !pauseActive(pause, now)) await store.clearPause();
    const livePause = pauseActive(pause, now) ? pause : null;
    const dt = activeDowntime(await store.downtimes(), now);
    const quiet = !!livePause || !!dt;
    const since = await store.getQuietSince();
    if (quiet && since === null) {
      await store.setQuietSince(Math.min(livePause?.setAt ?? now, dt?.start ?? now));
      return null;
    }
    if (!quiet && since !== null) {
      await store.setQuietSince(null);
      const held = await store.heldQuietSince(since);
      if (!held.length) {
        deps.changed();
        return null;
      }
      await store.markDigested(held.map((n) => n.id));
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
  }

  return {
    request,

    /** A todo was posted/updated; notify when the poster asked, or when it arrives urgent. */
    async onTodoPosted(todo: Todo, action: 'created' | 'updated' | 'reopened', notifyRequested: boolean): Promise<NotificationRow | null> {
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
    async onPostRejected(workspaceId: string, reason: string): Promise<NotificationRow | null> {
      const now = deps.now();
      const last = lastRejection.get(workspaceId);
      if (last !== undefined && now - last < HOUR) return null;
      lastRejection.set(workspaceId, now); // claimed before the first await
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
    async onInputWait(workspaceId: string, waitingIds: string[]): Promise<void> {
      const key = `input-wait:${workspaceId}`;
      if (waitingIds.length === 0) {
        waiting.delete(workspaceId);
        const t = waitTimers.get(workspaceId);
        if (t !== undefined) deps.clearTimer(t);
        waitTimers.delete(workspaceId);
        if ((await store.clearByKey(key, deps.now())).length) deps.changed();
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
        }).catch((e) => deps.onError?.(e));
      }, INPUT_WAIT_DELAY_MS));
    },

    /** Workspaces currently waiting on input (for the "needs you" count). */
    waitingWorkspaces(): string[] {
      return [...waiting.keys()];
    },

    /** Periodic: expire pauses, track quiet periods, send one digest when quiet ends. Serialized. */
    tick(): Promise<NotificationRow | null> {
      const run = ticking.then(tickOnce, tickOnce);
      ticking = run.catch(() => undefined);
      return run;
    },

    async quietState(): Promise<QuietState> {
      const now = deps.now();
      const [pause, ds, since] = await Promise.all([store.getPause(), store.downtimes(), store.getQuietSince()]);
      const dt = activeDowntime(ds, now);
      return {
        pause: pauseActive(pause, now) ? pause : null,
        activeDowntime: dt?.downtime ?? null,
        nextDowntime: nextDowntime(ds, now),
        heldSinceQuiet: since === null ? 0 : (await store.heldQuietSince(since)).length
      };
    },

    test(): Promise<NotificationRow> {
      return request({
        kind: 'test', title: 'Test notification', body: 'This is how claude-fleet notifications reach you.',
        priority: 'normal', source: { kind: 'user', id: null }
      });
    },

    prune(): Promise<number> {
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

    async effectiveFor(item: { kind?: NotificationKind; priority: TodoPriority; source: TodoSource; dedupeKey: string | null; tags: string[] }): Promise<EffectiveRule> {
      const [rules, level] = await Promise.all([store.rules(), store.getDefaultLevel()]);
      return effectiveRule(
        { kind: item.kind ?? 'todo', priority: item.priority, source: item.source, dedupeKey: item.dedupeKey, tags: item.tags },
        rules, level, deps.now()
      );
    },

    /** Batched effectiveFor: rules() and getDefaultLevel() are invariant across the whole call, so they're
     *  read once (not once per item) and every item is resolved against that one snapshot. */
    async effectiveForMany(
      items: Array<{ id: string; kind?: NotificationKind; priority: TodoPriority; source: TodoSource; dedupeKey: string | null; tags: string[] }>
    ): Promise<Record<string, EffectiveRule>> {
      if (items.length === 0) return {};
      const [rules, level] = await Promise.all([store.rules(), store.getDefaultLevel()]);
      const now = deps.now();
      const out: Record<string, EffectiveRule> = {};
      for (const item of items) {
        out[item.id] = effectiveRule(
          { kind: item.kind ?? 'todo', priority: item.priority, source: item.source, dedupeKey: item.dedupeKey, tags: item.tags },
          rules, level, now
        );
      }
      return out;
    }
  };
}

export type NotifyService = ReturnType<typeof createNotifyService>;
