// Keys the app itself understands and offers to configure, even before a
// user has stored anything under them — `vault:list` appends any missing one
// as an unset entry so Settings → Vault can always show the row.
export interface FleetKey { key: string; label: string; description: string; secret: boolean }
export const FLEET_KEYS: readonly FleetKey[] = [
  { key: 'GITHUB_TOKEN', label: 'GitHub login (PAT)', description: 'Signs Settings → Account in with this personal access token instead of the device flow.', secret: true }
];
export const FLEET_KEY_NAMES: ReadonlySet<string> = new Set(FLEET_KEYS.map((k) => k.key));
