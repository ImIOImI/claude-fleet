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
  /** Host-set only (never from the wire): automation attribution (#407 Phase 3). */
  viaWorkspace?: string;
  sourceRunId?: string;
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

// --- Notifications (#407 Phase 2) -------------------------------------------

/** Rule / default level: all · high and up · urgent only · off. */
export type NotifyLevel = 'all' | 'high' | 'urgent' | 'off';
export type NotificationKind = 'post' | 'todo' | 'input-wait' | 'post-rejected' | 'digest' | 'test' | 'run-failed';
export type RuleScopeKind = 'key' | 'source' | 'tag' | 'global';
export type DowntimeBypass = 'none' | 'urgent' | 'urgent+input';

export interface NotificationRow {
  id: string;
  ts: number;
  kind: NotificationKind;
  title: string;
  body: string | null;
  priority: TodoPriority;
  source: TodoSource;
  todoId: string | null;
  workspaceId: string | null;
  dedupeKey: string | null;
  tags: string[];
  delivered: boolean;
  /** 'rule:<id>' | 'default-level' | 'pause' | 'downtime:<id>' when held. */
  heldReason: string | null;
  channel: 'os' | 'in-app' | null;
  clearedAt: number | null;
}

export interface NotifyRule {
  id: string;
  scopeKind: RuleScopeKind;
  /** key: `<sourceKind>:<sourceId>:<key>` · source: `user` | `workspace:<id>` | `automation:<id>` · tag: the tag · global: '' */
  scopeValue: string;
  level: NotifyLevel;
  snoozeUntil: number | null;
}

export interface Downtime {
  id: string;
  name: string;
  enabled: boolean;
  /** 0 = Monday … 6 = Sunday. */
  days: number[];
  /** Minutes after local midnight. end ≤ start wraps past midnight. */
  startMin: number;
  endMin: number;
  bypass: DowntimeBypass;
}

export interface PauseState {
  /** Epoch ms; null = until resumed. */
  until: number | null;
  letUrgent: boolean;
  setAt: number;
}

export interface QuietState {
  pause: PauseState | null;
  activeDowntime: Downtime | null;
  nextDowntime: { downtime: Downtime; startsAt: number } | null;
  /** Notifications held since the current quiet period began (0 when not quiet). */
  heldSinceQuiet: number;
}

export interface RuleScope {
  scopeKind: RuleScopeKind;
  scopeValue: string;
  label: string;
}

export interface EffectiveRule {
  level: NotifyLevel;
  snoozeUntil: number | null;
  ruleId: string | null;
  scopeKind: RuleScopeKind;
}

export interface NotifySettings {
  defaultLevel: NotifyLevel;
  pause: PauseState | null;
  downtimes: Downtime[];
  rules: NotifyRule[];
}

// --- Automations (#407 Phase 3) ---------------------------------------------

export type ParamType = 'string' | 'number' | 'boolean' | 'enum';
export type ParamValue = string | number | boolean;

export interface ParamDef {
  name: string;
  type: ParamType;
  required?: boolean;
  default?: ParamValue;
  /** enum only */
  values?: string[];
  description?: string;
}

export interface ScheduleTrigger {
  schedule: { cron: string; tz?: string; args?: Record<string, ParamValue> };
}
export interface ManualTrigger {
  /** allowFrom: workspace ids (or names, resolved at save) that may run it over MCP. */
  manual: { allowFrom?: string[] };
}
export type EventName = 'session.idle' | 'todo.created' | 'workspace.started';
export interface EventTrigger {
  /** Fire when something happens in the fleet (#407 Phase 4). workspace/tag narrow it; debounce coalesces bursts. */
  event: { on: EventName; workspace?: string; tag?: string; debounce?: string };
}
export type TriggerDef = ScheduleTrigger | ManualTrigger | EventTrigger;

export interface PromptStepDef {
  id: string;
  prompt: {
    /** Workspace id (names are resolved to ids at save). */
    workspace: string;
    /** live: inject into the open session · fresh: a new headless `claude -p` session (#407 Phase 4). */
    mode: 'live' | 'fresh';
    message: string;
    wait?: boolean;
    ensureRunning?: boolean;
    timeout?: string;
    /** fresh only: extra tools the unattended session may use (the inbox tools are always allowed). */
    allowedTools?: string[];
  };
}
export type StepDef = PromptStepDef;

export interface AutomationDef {
  name: string;
  description?: string;
  tags?: string[];
  triggers: TriggerDef[];
  concurrency?: 'skip' | 'queue';
  timeout?: string;
  params?: ParamDef[];
  steps: StepDef[];
}

export type RunStatus =
  | 'queued' | 'running' | 'succeeded' | 'nothing-to-do' | 'failed' | 'timed-out' | 'skipped' | 'cancelled' | 'interrupted';
export type RunTriggerKind = 'schedule' | 'manual' | 'catch-up' | 'event';

export interface StepRunRow {
  id: number;
  runId: string;
  stepId: string;
  kind: 'prompt' | 'script';
  status: RunStatus;
  workspaceId: string | null;
  brokerSessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  detail: Record<string, unknown> | null;
}

export interface RunRow {
  id: string;
  automationId: string;
  version: number;
  trigger: { kind: RunTriggerKind; by?: TodoSource; cron?: string; event?: { on: EventName; workspaceId?: string; todoId?: string; todoTitle?: string; count: number } };
  args: Record<string, ParamValue>;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  steps: StepRunRow[];
}

export interface Automation {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  definition: AutomationDef;
  tags: string[];
  createdBy: TodoSource;
  createdAt: number;
  updatedAt: number;
  lastScheduledAt: number | null;
  nextFireAt: number | null;
  lastRun: RunRow | null;
  weekStats: { runs: number; nothingToDo: number; failed: number };
  /** One plain-language line per trigger ("every 30 min · 08–18 · weekdays", "by hand"). */
  triggerSummaries: string[];
}
