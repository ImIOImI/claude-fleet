// The MCP history read seam: the fleet-state typed tools, search and `query`
// read through a ReadSource, one per dialect (SPEC §11). Data access only:
// argument validation, scope narrowing and result shaping stay in the tools.
import type { EmbeddingHit } from '../db.js';

export type Row = Record<string, unknown>;
export type Scope = ReadonlySet<string>;

/** The tables `query` exposes, on both dialects. */
export const MCP_QUERY_TABLES = [
  'events', 'sessions', 'broker_sessions', 'session_summaries', 'session_tags', 'usage_events', 'perf_events',
  'port_exposures',
] as const;

/** `events` columns `query` exposes (raw_jsonl only with include_raw; dedup_key never). */
export const SNAPSHOT_EVENT_COLS =
  'id, session_id, workspace_id, ts, type, subtype, uuid, parent_uuid, model, ' +
  'input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, ' +
  'service_tier, tool_name, tool_use_id, tool_input, tool_result_is_error';

export interface SessionListFilter { workspaceId?: string; since?: number; until?: number; limit: number }
/** `columns` is a comma list already checked against the tool's allowlist. */
export interface EventListFilter { type?: string; toolName?: string; since?: number; limit: number; columns: string }
export interface ErrorListFilter { workspaceId?: string; sessionId?: string; level?: string; type?: string; since?: number; limit: number }

export interface TokenGroup {
  model: string | null;
  service_tier: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface SummaryParts {
  files: string[];
  commands: string[];
  tokens: TokenGroup[];
  span: { started_at: number | null; last_active_at: number | null };
}

export interface QueryArgs { sql: string; params: unknown[]; includeRaw: boolean; maxRows: number }
export interface QueryCaller { callerId: string; scope: Scope }

/** Runs `query` for a dialect that isolates by connection (Postgres: pgQueryIsolation.ts). */
export interface QueryRunner {
  query(caller: QueryCaller, q: QueryArgs): Promise<unknown[]>;
  forgetCaller(callerId: string): Promise<void>;
  end(): Promise<void>;
}

export interface ReadSource {
  readonly dialect: 'sqlite' | 'postgres';
  listSessions(scope: Scope, f: SessionListFilter): Promise<Row[]>;
  /** Unscoped: the tool checks the row's workspace against the caller's scope. */
  getSession(id: string): Promise<Row | null>;
  sessionWorkspace(id: string): Promise<string | null>;
  /** Assistant-event token sums per (model, service_tier), NULLs first. */
  tokenGroups(sessionId: string): Promise<TokenGroup[]>;
  listEvents(sessionId: string, f: EventListFilter): Promise<Row[]>;
  summaryParts(sessionId: string): Promise<SummaryParts>;
  listErrors(scope: Scope, f: ErrorListFilter): Promise<Row[]>;
  searchEmbeddings(qvec: Float32Array, scope: Scope, o: { limit: number; kind?: 'turn' | 'summary' }): Promise<EmbeddingHit[]>;
  /** One read-only statement, isolated to `caller.scope` by the dialect's own mechanism. At most maxRows rows. */
  query(caller: QueryCaller, q: QueryArgs): Promise<unknown[]>;
  /** A removed workspace: drop anything held for it as a caller. */
  forgetCaller(callerId: string): Promise<void>;
  close(): Promise<void>;
}
