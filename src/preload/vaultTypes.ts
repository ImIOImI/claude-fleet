// Renderer-facing vault:* shapes. `VaultEntry.secret` gates whether `root.value`
// / `VaultLine.value` are ever populated — main never sends a secret's value
// down any list/reveal response path except the explicit reveal-by-key one.
export type VaultLineMode = 'inherit' | 'override';
export interface VaultLine { workspaceId: string; mode: VaultLineMode; value?: string; pending: boolean }
export interface VaultEntry {
  key: string;
  secret: boolean;
  tags: string[];
  fleet: boolean;
  root: { set: boolean; value?: string };
  lines: VaultLine[];
}
export type VaultWorkspaceEdit =
  | { key: string; op: 'inherit' }
  | { key: string; op: 'override'; value: string }
  | { key: string; op: 'remove' }
  | { key: string; op: 'create'; secret: boolean; tags: string[]; value: string; asRoot: boolean };
