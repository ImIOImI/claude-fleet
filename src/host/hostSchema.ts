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

export const HOST_TRACK: PgTrack = {
  track: 'host', baselineVersion: HOST_PG_BASELINE_VERSION, baseline: HOST_PG_BASELINE,
  steps: [{ version: 2, postgres: HOST_PUBLISH_V2 }, { version: 3, postgres: HOST_SESSION_OWNERS_V3 }]
};
