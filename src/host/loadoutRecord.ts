// /workspace/.claude/fleet-loadouts.json: what the pinned-loadout sync installed, for an exact revert.

export interface PinnedRecord {
  id: string;
  version: string;
  /** owner/repo the pin came from. */
  repo: string;
  commit: string;
  /** Workspace-relative paths applyLoadoutFiles wrote. */
  files: string[];
  claudeMd: boolean;
  settingsKeys: string[];
  mcpServers: string[];
  hooks: { event: string; entry: unknown }[];
  installedAt: number;
}

export interface RecordFile {
  version: 1;
  loadouts: PinnedRecord[];
}
