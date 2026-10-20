// Inbox types shared by main (type-only import) and the renderer (via preload).
// Pure declarations — no runtime code — so either side can import them.

export type TodoStatus = 'open' | 'done' | 'dismissed';
export type TodoPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SourceKind = 'user' | 'workspace' | 'automation';

/** Who an item (or an event) came from. `id` is null for the user. */
export interface TodoSource {
  kind: SourceKind;
  id: string | null;
}

export interface Todo {
  id: string;
  title: string;
  body: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  source: TodoSource;
  sourceRunId: string | null;
  viaWorkspace: string | null;
  dedupeKey: string | null;
  seenCount: number;
  recurred: boolean;
  workspaceId: string | null;
  sessionId: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  closedAt: number | null;
}

export type TodoEventKind =
  | 'created'
  | 'seen'
  | 'reopened'
  | 'status'
  | 'priority'
  | 'tag_add'
  | 'tag_remove'
  | 'body_append'
  | 'title';

export interface TodoEvent {
  id: number;
  todoId: string;
  ts: number;
  kind: TodoEventKind;
  actor: TodoSource;
  runId: string | null;
  detail: Record<string, unknown> | null;
}

export interface PostTodoInput {
  title: string;
  body?: string;
  priority?: TodoPriority;
  key?: string;
  tags?: string[];
  workspaceLink?: string;
  sessionLink?: string;
}

export interface UpdateTodoPatch {
  status?: TodoStatus;
  priority?: TodoPriority;
  title?: string;
  tagsAdd?: string[];
  tagsRemove?: string[];
  bodyAppend?: string;
}

export interface TodoFilter {
  /** Default 'open'. */
  status?: TodoStatus | 'all';
  /** Every tag listed must be present. */
  tags?: string[];
  /** Restrict to what one workspace may see (own-sourced, linked, or via). */
  visibleTo?: string;
  /** Default 200, max 500. */
  limit?: number;
}

export interface InboxCounts {
  open: number;
  urgent: number;
  high: number;
}

/** Host-private per-workspace inbox permissions (workspace manifest `inbox`). */
export interface InboxConfig {
  /** Default true. */
  canPost?: boolean;
  /** Default 60. */
  maxPostsPerHour?: number;
  /** Default false. */
  canReadAll?: boolean;
}
