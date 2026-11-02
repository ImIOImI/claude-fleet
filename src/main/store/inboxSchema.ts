// Kysely table types for inbox.db (#407). Mirrors MIGRATIONS 1–5 in
// inbox/inboxDb.ts exactly; a migration that changes a table changes it here too.
import type { Generated, Selectable } from 'kysely';
import type {
  DowntimeBypass, NotificationKind, NotifyLevel, ProposalKind, ProposalStatus, RuleScopeKind, RunStatus,
  TodoEventKind, TodoPriority, TodoSource, TodoStatus
} from '../../preload/inboxTypes.js';

type SourceKind = TodoSource['kind'];

export interface TodosTable {
  id: string; title: string; body: string | null; status: TodoStatus; priority: TodoPriority;
  source_kind: SourceKind; source_id: string | null; source_run_id: string | null; via_workspace: string | null;
  dedupe_key: string | null; seen_count: Generated<number>; recurred: Generated<number>;
  workspace_id: string | null; session_id: string | null;
  created_at: number; updated_at: number; first_seen_at: number; last_seen_at: number; closed_at: number | null;
}
export interface TagsTable { entity_kind: string; entity_id: string; tag: string }
export interface TodoEventsTable {
  id: Generated<number>; todo_id: string; ts: number; kind: TodoEventKind; actor_kind: SourceKind;
  actor_id: string | null; run_id: string | null; detail: string | null;
}
export interface NotificationsTable {
  id: string; ts: number; kind: NotificationKind; title: string; body: string | null; priority: TodoPriority;
  source_kind: SourceKind; source_id: string | null; todo_id: string | null; workspace_id: string | null;
  dedupe_key: string | null; tags: string | null; delivered: number; held_reason: string | null;
  channel: 'os' | 'in-app' | null; cleared_at: number | null; digested: Generated<number>;
}
export interface NotificationRulesTable {
  id: string; scope_kind: RuleScopeKind; scope_value: string; level: NotifyLevel; snooze_until: number | null;
  created_at: number; updated_at: number;
}
export interface DowntimesTable {
  id: string; name: string; enabled: number; days_mask: number; start_min: number; end_min: number;
  bypass: DowntimeBypass; created_at: number;
}
export interface NotifyStateTable { k: string; v: string }
export interface AutomationsTable {
  id: string; name: string; enabled: number; version: number; definition: string; created_by_kind: SourceKind;
  created_by_id: string | null; origin: string | null; created_at: number; updated_at: number;
  last_scheduled_at: number | null; next_run_at: number | null; next_run_by: string | null;
}
export interface AutomationVersionsTable {
  automation_id: string; version: number; definition: string; created_at: number; created_by_kind: SourceKind; created_by_id: string | null;
}
export interface AutomationStateTable { automation_id: string; state: string }
export interface RunsTable {
  id: string; automation_id: string; version: number; trigger: string; args: string; status: RunStatus;
  started_at: number; ended_at: number | null; error: string | null; reschedule: string | null;
}
export interface StepRunsTable {
  id: Generated<number>; run_id: string; step_id: string; kind: 'prompt' | 'script'; status: RunStatus;
  workspace_id: string | null; broker_session_id: string | null; started_at: number; ended_at: number | null;
  error: string | null; detail: string | null;
}
export interface ProposalsTable {
  id: string; kind: ProposalKind; proposer_kind: SourceKind; proposer_id: string | null; rationale: string | null;
  status: ProposalStatus; items: string; note: string | null; created_at: number; decided_at: number | null;
}

export interface InboxDb {
  todos: TodosTable;
  tags: TagsTable;
  todo_events: TodoEventsTable;
  notifications: NotificationsTable;
  notification_rules: NotificationRulesTable;
  downtimes: DowntimesTable;
  notify_state: NotifyStateTable;
  automations: AutomationsTable;
  automation_versions: AutomationVersionsTable;
  automation_state: AutomationStateTable;
  runs: RunsTable;
  step_runs: StepRunsTable;
  proposals: ProposalsTable;
}

export type TodoRow = Selectable<TodosTable>;
export type TodoEventRow = Selectable<TodoEventsTable>;
export type NotificationRowSql = Selectable<NotificationsTable>;
export type AutomationRow = Selectable<AutomationsTable>;
export type RunRowSql = Selectable<RunsTable>;
export type StepRunRowSql = Selectable<StepRunsTable>;
export type ProposalRow = Selectable<ProposalsTable>;
