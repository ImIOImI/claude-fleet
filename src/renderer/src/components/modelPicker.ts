// Pure mapping between the workspace form's Model/Auth controls and the
// unchanged wire shape (authMode + endpointId) — spec
// docs/superpowers/specs/2026-08-06-model-picker-form-ux-design.md (#256).
// Kept free of React so every WorkspaceForm consumer derives identically
// and the mapping is unit-testable.

import type { AuthMode } from '../App';

export type ClaudeAuth = 'oauth' | 'apikey';

export type ModelSelection =
  | { kind: 'claude' }
  | { kind: 'endpoint'; endpointId: string };

export function modelFromInitial(
  authMode?: AuthMode,
  endpointId?: string
): ModelSelection {
  // 'endpoint' without an id can only come from a hand-edited manifest —
  // degrade to claude rather than carrying an unusable selection.
  if (authMode === 'endpoint' && endpointId) return { kind: 'endpoint', endpointId };
  return { kind: 'claude' };
}

export function claudeAuthFromInitial(authMode?: AuthMode): ClaudeAuth {
  return authMode === 'apikey' ? 'apikey' : 'oauth';
}

export function deriveAuthFields(
  model: ModelSelection,
  claudeAuth: ClaudeAuth
): { authMode: AuthMode; endpointId: string | undefined } {
  if (model.kind === 'endpoint') {
    return { authMode: 'endpoint', endpointId: model.endpointId };
  }
  return { authMode: claudeAuth, endpointId: undefined };
}
