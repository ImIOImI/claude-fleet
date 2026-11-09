// Kysely table types for state.db (the JSONL→SQLite cache). Mirrors migrate()
// v1–v17 in db.ts exactly; a migration that changes a table changes it here too.
import type { Generated, Selectable } from 'kysely';

export interface EventsTable {
  id: Generated<number>;
  session_id: string;
  workspace_id: string;
  ts: number | null;
  type: string;
  subtype: string | null;
  uuid: string | null;
  parent_uuid: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  service_tier: string | null;
  tool_name: string | null;
  raw_jsonl: string;
  dedup_key: string;
  tool_use_id: string | null;
  tool_input: string | null;
  tool_result_is_error: number | null;
  /** zlib-deflated line when compressed (raw_jsonl is then ''); SQLite only. */
  raw_z: Buffer | null;
  /** event_blobs hash when the line's attachment value is a fleetRef marker; SQLite only. */
  att_ref: string | null;
}
export interface SessionsTable {
  id: string;
  workspace_id: string;
  cwd: string | null;
  started_at: number | null;
  last_active_at: number | null;
  ai_title: string | null;
  first_user_message: string | null;
  user_set_name: string | null;
}
export interface BrokerSessionsTable {
  workspace_id: string;
  broker_session_id: string;
  claude_session_id: string;
  learned_at: number;
  verified: Generated<number>;
  pending_claude_session_id: string | null;
}
export interface ErrorsTable {
  id: Generated<number>;
  ts: number;
  workspace_id: string | null;
  session_id: string | null;
  source: string;
  level: string;
  type: string;
  message: string;
  stack: string | null;
  extra: string | null;
}
export interface EmbeddingsTable {
  id: Generated<number>;
  workspace_id: string;
  session_id: string;
  kind: 'turn' | 'summary';
  ref_event_id: number | null;
  ts: number | null;
  text: string;
  model_id: string;
  dim: number;
  /** int8 or float32 bytes (vectors.ts); empty (SQLite) or NULL (Postgres) for a placeholder. */
  vec: Buffer | null;
  dedup_key: string;
}
export interface SessionSummariesTable {
  id: Generated<number>;
  session_id: string;
  workspace_id: string;
  summary: string;
  tags: string | null;
  source_max_event_id: number;
  from_ts: number | null;
  to_ts: number | null;
  model: string | null;
  generated_at: number;
}
export interface SessionTagsTable { workspace_id: string; session_id: string; tag: string }
export interface UsageEventsTable {
  id: Generated<number>;
  ts: number;
  workspace_id: string;
  session_id: string | null;
  kind: string;
  detail: string | null;
}
export interface UsageAnchorsTable {
  id: Generated<number>;
  ts: number;
  workspace_id: string | null;
  session_id: string | null;
  kind: string;
  http_status: number | null;
  scope: string | null;
  reset_at: number | null;
  window_start: number | null;
  message: string | null;
  rate_limits: string | null;
  dedup_key: string;
}
export interface PerfEventsTable {
  id: Generated<number>;
  ts: number;
  kind: string;
  workspace_id: string | null;
  session_id: string | null;
  name: string | null;
  dur_ms: number | null;
  trace_id: string | null;
  span_id: string | null;
  meta: string | null;
}
/** Key columns hold '' for a NULL model/service_tier (v13). */
export interface SessionCostsTable {
  session_id: string;
  workspace_id: string;
  model: string;
  service_tier: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  event_count: number;
}
export interface SessionStatsTable { session_id: string; max_context_tokens: number }
export interface SessionToolCountsTable { session_id: string; tool_name: string; count: number }

export interface PortExposuresTable {
  id: string;
  workspace_id: string;
  session_id: string | null;
  port: number;
  cmdline: string | null;
  label: string | null;
  reason: string | null;
  source: string;
  first_scanned_at: number | null;
  declared_at: number | null;
  popup_shown_at: number | null;
  outcome: string | null;
  opened_via: string | null;
  open_count: Generated<number>;
  ended_at: number | null;
}

export interface EventRetentionTable {
  session_id: string;
  workspace_id: string;
  compressed_before: Generated<number>;
  stripped_before: Generated<number>;
}
export interface MaintenanceTable { key: string; value: string }

/** A deduped attachment payload (zlib) and how many events reference it. */
export interface EventBlobsTable {
  hash: string;
  body_z: Buffer;
  bytes: number;
  refs: number;
}

export interface StateDb {
  events: EventsTable;
  sessions: SessionsTable;
  broker_sessions: BrokerSessionsTable;
  errors: ErrorsTable;
  embeddings: EmbeddingsTable;
  session_summaries: SessionSummariesTable;
  session_tags: SessionTagsTable;
  usage_events: UsageEventsTable;
  usage_anchors: UsageAnchorsTable;
  perf_events: PerfEventsTable;
  session_costs: SessionCostsTable;
  session_stats: SessionStatsTable;
  session_tool_counts: SessionToolCountsTable;
  port_exposures: PortExposuresTable;
  event_retention: EventRetentionTable;
  maintenance: MaintenanceTable;
  event_blobs: EventBlobsTable;
}

export type EventRowSel = Selectable<EventsTable>;
export type BrokerSessionRow = Selectable<BrokerSessionsTable>;
