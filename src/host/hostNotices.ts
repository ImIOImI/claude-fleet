// The host's notices (D131): written undelivered on the holder's fenced inbox
// store; desktops fetch them (notices:feed) and apply their own policy.
import type { NotificationRow, Todo, TodoSource } from '../preload/inboxTypes.js';
import type { NotifyStore } from '../main/inbox/notifyStore.js';
import { todoNoticeInput, type NotifyInput } from '../main/inbox/notifyService.js';
import { oneLine } from '../main/remoteUrl.js';

export const NOTICE_HELD = 'remote';
export const NOTICE_RETENTION_MS = 7 * 86_400_000;
export const MAX_NOTICE_TITLE = 200;
export const MAX_NOTICE_BODY = 2000;
export const MAX_NOTICES_KEPT = 5000;

export interface HostNotices {
  request(n: NotifyInput): Promise<NotificationRow>;
  onTodoPosted(todo: Todo, action: 'created' | 'updated' | 'reopened', notifyRequested: boolean): Promise<NotificationRow | null>;
  /** sinceTs null: the newest `limit`, oldest first. */
  feed(o: { sinceTs: number | null; limit: number }): Promise<NotificationRow[]>;
  prune(): Promise<number>;
}

export function hostNotices(o: {
  store: NotifyStore;
  /** Every notice is about the hosted workspace; the feed serves only its rows. */
  workspaceId(): string;
  now(): number;
  /** Publish the data-free notices:changed hint. */
  changed(): void;
  sourceName(s: TodoSource): string;
  keep?: number;
}): HostNotices {
  async function request(n: NotifyInput): Promise<NotificationRow> {
    const body = n.body ? oneLine(n.body, MAX_NOTICE_BODY) : '';
    const key = n.dedupeKey ? oneLine(n.dedupeKey, 200) : '';
    const row = await o.store.insert({
      ts: o.now(), kind: n.kind, title: oneLine(n.title, MAX_NOTICE_TITLE) || '(untitled)', body: body || null, priority: n.priority, source: n.source,
      todoId: n.todoId ?? null, workspaceId: o.workspaceId(), dedupeKey: key || null,
      tags: (n.tags ?? []).slice(0, 20).map((t) => oneLine(t, 64)).filter(Boolean),
      delivered: false, heldReason: NOTICE_HELD, channel: null
    });
    o.changed();
    return row;
  }
  return {
    request,
    async onTodoPosted(todo, action, notifyRequested) {
      const n = todoNoticeInput(todo, action, notifyRequested, o.sourceName(todo.source));
      return n ? request(n) : null;
    },
    async feed({ sinceTs, limit }) {
      if (sinceTs !== null) return o.store.since(sinceTs, limit, o.workspaceId());
      return (await o.store.list({ filter: 'all', limit, workspaceId: o.workspaceId() })).reverse();
    },
    async prune() {
      const old = await o.store.prune(o.now() - NOTICE_RETENTION_MS);
      return old + await o.store.keepNewest(o.workspaceId(), o.keep ?? MAX_NOTICES_KEPT);
    }
  };
}
