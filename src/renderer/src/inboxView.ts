// Pure helpers for the Inbox view (#407) — grouping, search, and labels.
import type { InboxCounts, Todo, TodoEvent, TodoPriority, TodoSource } from '../../preload/inboxTypes';

const GROUPS: Array<[TodoPriority, string]> = [['urgent', 'Urgent'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];

export function groupByPriority(todos: Todo[]): Array<{ priority: TodoPriority; label: string; todos: Todo[] }> {
  return GROUPS.map(([priority, label]) => ({ priority, label, todos: todos.filter((t) => t.priority === priority) }))
    .filter((g) => g.todos.length > 0);
}

export function matchesSearch(t: Todo, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [t.title, t.body ?? '', ...t.tags].some((s) => s.toLowerCase().includes(needle));
}

export function sourceLabel(s: TodoSource, names: Record<string, string>): string {
  if (s.kind === 'user') return 'You';
  if (s.kind === 'workspace') return (s.id && names[s.id]) || 'deleted workspace';
  return 'automation';
}

export function chipSubline(c: InboxCounts): string {
  if (c.open === 0) return 'nothing open';
  return c.urgent > 0 ? `${c.open} open · ${c.urgent} urgent` : `${c.open} open`;
}

export function chipDot(c: InboxCounts): 'urgent' | 'open' | 'none' {
  if (c.urgent > 0) return 'urgent';
  return c.open > 0 ? 'open' : 'none';
}

export function relativeAgo(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function eventLabel(e: TodoEvent, names: Record<string, string>): string {
  const who = sourceLabel(e.actor, names);
  const d = e.detail ?? {};
  switch (e.kind) {
    case 'created': return `Created by ${who}`;
    case 'seen': return `Seen again by ${who}`;
    case 'reopened': return `Reopened: it recurred after being marked ${String(d.from ?? 'closed')}`;
    case 'status': return `${who} marked it ${String(d.to)}`;
    case 'priority': return `${who} set priority to ${String(d.to)}`;
    case 'title': return `${who} renamed it`;
    case 'tag_add': return `${who} added tag${(d.tags as string[]).length > 1 ? 's' : ''} ${(d.tags as string[]).join(', ')}`;
    case 'tag_remove': return `${who} removed tag${(d.tags as string[]).length > 1 ? 's' : ''} ${(d.tags as string[]).join(', ')}`;
    case 'body_append': return `${who} added detail`;
  }
}
