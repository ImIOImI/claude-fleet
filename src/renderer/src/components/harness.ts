import type { AuthMode, Harness } from '../../../main/workspaces.js';

export function validateHarnessSelection(authMode: AuthMode, harness: Harness | undefined): string | null {
  if (authMode === 'endpoint' && !harness) return 'Pick a harness (Claude Code or Qwen Code) for endpoint workspaces.';
  return null;
}
