// The host's own tables (migration track 'host'), in the store's schema beside 'state' and 'inbox'.
import type { PgTrack } from '../main/store/pgMigrate.js';

export interface HostDb {
  host_meta: { singleton: boolean; workspace_id: string; created_at: number };
  host_lease: { workspace_id: string; holder: string | null; epoch: number; expires_at: Date };
  host_ingest_offsets: { path: string; byte_offset: number; ino: string | null; updated_at: number };
  publish_partitions: { partition_id: string; owner_provider: string; owner_id: string; owner_login: string; source_workspace_id: string; created_at: number };
  publish_sessions: { session_id: string; partition_id: string; source_session_id: string; first_published_at: number; last_published_at: number };
  session_owners: {
    broker_session_id: string; session_id: string; workspace_id: string; kind: string; provider: string;
    account_id: string; login: string; name: string | null; avatar_url: string | null; started_at: number;
  };
  host_action_requests: {
    actor: string; request_id: string; channel: string; created_at: number;
    settled_at: number | null; result: string | null; error: string | null;
  };
  host_run_retries: {
    run_id: string; automation_id: string; state: 'pending' | 'started' | 'skipped'; retry_run_id: string | null;
    created_at: number; settled_at: number | null; note: string | null;
  };
  host_drained_sessions: { instance: string; broker_session_id: string; session_id: string; reason: string | null; drained_at: number };
}

export const HOST_PG_BASELINE_VERSION = 1;

export const HOST_PG_BASELINE = `
CREATE TABLE host_meta (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  workspace_id TEXT COLLATE "C" NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE host_lease (
  workspace_id TEXT COLLATE "C" PRIMARY KEY,
  holder TEXT COLLATE "C",
  epoch BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE host_ingest_offsets (
  path TEXT COLLATE "C" PRIMARY KEY,
  byte_offset BIGINT NOT NULL,
  ino TEXT COLLATE "C",
  updated_at BIGINT NOT NULL
);
`;

// Transcript publish: who owns each partition, and which source session each stored session came from.
const HOST_PUBLISH_V2 = `
CREATE TABLE publish_partitions (
  partition_id TEXT COLLATE "C" PRIMARY KEY,
  owner_provider TEXT COLLATE "C" NOT NULL,
  owner_id TEXT COLLATE "C" NOT NULL,
  owner_login TEXT COLLATE "C" NOT NULL,
  source_workspace_id TEXT COLLATE "C" NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (owner_provider, owner_id, source_workspace_id)
);
CREATE TABLE publish_sessions (
  session_id TEXT COLLATE "C" PRIMARY KEY,
  partition_id TEXT COLLATE "C" NOT NULL REFERENCES publish_partitions (partition_id),
  source_session_id TEXT COLLATE "C" NOT NULL,
  first_published_at BIGINT NOT NULL,
  last_published_at BIGINT NOT NULL,
  UNIQUE (partition_id, source_session_id)
);
CREATE INDEX idx_publish_sessions_source ON publish_sessions (source_session_id);
`;

// A claude session's owner is its earliest row (D115).
const HOST_SESSION_OWNERS_V3 = `
CREATE TABLE session_owners (
  broker_session_id TEXT COLLATE "C" NOT NULL,
  session_id TEXT COLLATE "C" NOT NULL,
  workspace_id TEXT COLLATE "C" NOT NULL,
  kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('user', 'machine', 'automation')),
  provider TEXT COLLATE "C" NOT NULL,
  account_id TEXT COLLATE "C" NOT NULL,
  login TEXT COLLATE "C" NOT NULL,
  name TEXT,
  avatar_url TEXT,
  started_at BIGINT NOT NULL,
  PRIMARY KEY (broker_session_id, session_id)
);
CREATE INDEX idx_session_owners_session ON session_owners (session_id, started_at);
`;

// At-most-once host actions (D128): one row per (actor, request id), kept 24 h.
const HOST_ACTION_REQUESTS_V4 = `
CREATE TABLE host_action_requests (
  actor TEXT COLLATE "C" NOT NULL,
  request_id TEXT COLLATE "C" NOT NULL,
  channel TEXT COLLATE "C" NOT NULL,
  created_at BIGINT NOT NULL,
  settled_at BIGINT,
  result TEXT,
  error TEXT,
  PRIMARY KEY (actor, request_id)
);
CREATE INDEX idx_host_action_requests_created ON host_action_requests (created_at);
`;

// Graceful drain (D150, D151): one re-run per cut-off automation run; interactive sessions to resume.
const HOST_DRAIN_V5 = `
CREATE TABLE host_run_retries (
  run_id TEXT COLLATE "C" PRIMARY KEY,
  automation_id TEXT COLLATE "C" NOT NULL,
  state TEXT COLLATE "C" NOT NULL CHECK (state IN ('pending', 'started', 'skipped')),
  retry_run_id TEXT COLLATE "C" UNIQUE,
  created_at BIGINT NOT NULL,
  settled_at BIGINT,
  note TEXT
);
CREATE TABLE host_drained_sessions (
  instance TEXT COLLATE "C" NOT NULL,
  broker_session_id TEXT COLLATE "C" NOT NULL,
  session_id TEXT COLLATE "C" NOT NULL,
  reason TEXT COLLATE "C",
  drained_at BIGINT NOT NULL,
  PRIMARY KEY (instance, broker_session_id)
);
CREATE INDEX idx_host_drained_sessions_at ON host_drained_sessions (drained_at);
`;

export const HOST_TRACK: PgTrack = {
  track: 'host', baselineVersion: HOST_PG_BASELINE_VERSION, baseline: HOST_PG_BASELINE,
  steps: [
    { version: 2, postgres: HOST_PUBLISH_V2 }, { version: 3, postgres: HOST_SESSION_OWNERS_V3 }, { version: 4, postgres: HOST_ACTION_REQUESTS_V4 },
    { version: 5, postgres: HOST_DRAIN_V5 }
  ]
};
