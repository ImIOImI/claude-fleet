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

/** list_events' default projection. */
export const LIST_EVENT_COLS: readonly string[] = [
  'id', 'session_id', 'workspace_id', 'ts', 'type', 'subtype', 'model', 'tool_name', 'tool_use_id', 'tool_input',
  'tool_result_is_error', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'service_tier',
];

/** Columns list_events may project; never raw_jsonl or dedup_key. */
export const LIST_EVENT_COL_ALLOWLIST: ReadonlySet<string> = new Set([...LIST_EVENT_COLS, 'uuid', 'parent_uuid']);

/** Throws on any column outside LIST_EVENT_COL_ALLOWLIST. */
export function checkEventColumns(cols: readonly string[]): void {
  if (cols.length === 0) throw new Error('no columns');
  for (const c of cols) if (!LIST_EVENT_COL_ALLOWLIST.has(c)) throw new Error(`unknown column: ${c}`);
}

export const NOT_AUTHORIZED = 'not authorized to read this session';

/** `query`'s result cap, as JSON bytes. */
export const MAX_QUERY_BYTES = 50_000;

export interface SessionListFilter { workspaceId?: string; since?: number; until?: number; limit: number }
/** `columns`: each source rejects any outside LIST_EVENT_COL_ALLOWLIST. */
export interface EventListFilter { type?: string; toolName?: string; since?: number; limit: number; columns: readonly string[] }
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

/** Every read takes the caller's scope and enforces it itself; session-keyed
 *  reads throw NOT_AUTHORIZED (getSession/sessionWorkspace: null) outside it. */
export interface ReadSource {
  /** Which engine serves `query`; null when `query` is unavailable. */
  readonly queryFlavor: 'sqlite' | 'postgres' | null;
  listSessions(scope: Scope, f: SessionListFilter): Promise<Row[]>;
  getSession(scope: Scope, id: string): Promise<Row | null>;
  sessionWorkspace(scope: Scope, id: string): Promise<string | null>;
  /** Assistant-event token sums per (model, service_tier), NULLs first, then byte order. */
  tokenGroups(scope: Scope, sessionId: string): Promise<TokenGroup[]>;
  listEvents(scope: Scope, sessionId: string, f: EventListFilter): Promise<Row[]>;
  summaryParts(scope: Scope, sessionId: string): Promise<SummaryParts>;
  listErrors(scope: Scope, f: ErrorListFilter): Promise<Row[]>;
  /** An all-zero `qvec` scores 0 everywhere on SQLite and returns [] on Postgres. */
  searchEmbeddings(qvec: Float32Array, scope: Scope, o: { limit: number; kind?: 'turn' | 'summary' }): Promise<EmbeddingHit[]>;
  /** One read-only statement, isolated to `caller.scope` by the dialect's own mechanism. At most maxRows rows. */
  query(caller: QueryCaller, q: QueryArgs): Promise<unknown[]>;
}

/** Lifecycle, for the source's owner; the tools see only ReadSource. */
export interface ReadSourceAdmin {
  /** A removed workspace: drop anything held for it as a caller. */
  forgetCaller(callerId: string): Promise<void>;
  close(): Promise<void>;
}

export type OwnedReadSource = ReadSource & ReadSourceAdmin;
