// Pure inbox rules (no electron/DB/fs) — priorities, tag normalization and
// post-input validation. Shared by the store, the IPC layer and the MCP tools.
import type { PostTodoInput, TodoPriority } from '../../preload/inboxTypes.js';

export const PRIORITIES: readonly TodoPriority[] = ['low', 'normal', 'high', 'urgent'];

export function priorityRank(p: TodoPriority): number {
  return PRIORITIES.indexOf(p);
}

export function maxPriority(a: TodoPriority, b: TodoPriority): TodoPriority {
  return priorityRank(a) >= priorityRank(b) ? a : b;
}

export function isPriority(v: unknown): v is TodoPriority {
  return typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
}

const TAG_RE = /^[a-z0-9._-]{1,40}$/;
export const MAX_TAGS = 10;

export function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return TAG_RE.test(t) ? t : null;
}

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const t = normalizeTag(r);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

/** Thrown for caller-fixable input problems; the message is shown to the caller. */
export class InboxInputError extends Error {}

const LIMITS = { title: 200, body: 20_000, key: 200, link: 100 } as const;

function optString(raw: Record<string, unknown>, names: string[], field: string, max: number): string | undefined {
  for (const n of names) {
    const v = raw[n];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new InboxInputError(`${field} must be a string`);
    if (v.length > max) throw new InboxInputError(`${field} is longer than ${max} characters`);
    return v;
  }
  return undefined;
}

/** Validate a post from the user (camelCase) or the MCP tool (snake_case). */
export function validatePostInput(raw: Record<string, unknown>): PostTodoInput {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) throw new InboxInputError('title is required');
  if (title.length > LIMITS.title) throw new InboxInputError(`title is longer than ${LIMITS.title} characters`);
  const priority = raw.priority === undefined ? 'normal' : raw.priority;
  if (!isPriority(priority)) throw new InboxInputError('priority must be one of low, normal, high, urgent');
  const out: PostTodoInput = { title, priority, tags: normalizeTags(raw.tags) };
  const body = optString(raw, ['body'], 'body', LIMITS.body);
  if (body !== undefined) out.body = body;
  const key = optString(raw, ['key'], 'key', LIMITS.key);
  if (key !== undefined && key.trim()) out.key = key.trim();
  const ws = optString(raw, ['workspaceLink', 'workspace_link'], 'workspace_link', LIMITS.link);
  if (ws) out.workspaceLink = ws;
  const sess = optString(raw, ['sessionLink', 'session_link'], 'session_link', LIMITS.link);
  if (sess) out.sessionLink = sess;
  return out;
}
