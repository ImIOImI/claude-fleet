// The host's own tables (migration track 'host'), in the store's schema beside 'state' and 'inbox'.
import type { PgTrack } from '../main/store/pgMigrate.js';

export interface HostDb {
  host_meta: { singleton: boolean; workspace_id: string; created_at: number };
  host_lease: { workspace_id: string; holder: string | null; epoch: number; expires_at: Date };
  host_ingest_offsets: { path: string; byte_offset: number; ino: string | null; updated_at: number };
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

export const HOST_TRACK: PgTrack = { track: 'host', baselineVersion: HOST_PG_BASELINE_VERSION, baseline: HOST_PG_BASELINE, steps: [] };
