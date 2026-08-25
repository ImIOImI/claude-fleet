// #268: the edit form must round-trip a per-workspace terminal renderer.
//
// Three separate projections between the manifest and this form build their
// objects field by field — the create path, the live-workspace merge in
// fetchAllWorkspaces, and this mapper. Each silently drops anything not
// listed, and typechecking passes either way, so the failure mode is a saved
// override that shows as "Default" in the form and is then wiped on save.

import { describe, it, expect } from 'vitest';
import { workspaceToFormInitial } from './formInitial';

const base = {
  id: 'ws1',
  name: 'local-wsl',
  labels: [],
  workspaceRoot: '/home/u/proj',
  workspaceSubdir: '',
  kind: 'local' as const,
  authMode: 'oauth' as const,
  env: { plain: {}, secretKeys: [] },
  mirror: { default: 'on' as const, cleanup: 'delete' as const },
  state: 'running' as const
};

describe('workspaceToFormInitial — terminalRenderer (#268)', () => {
  it('carries a saved override into the form', () => {
    for (const r of ['dom', 'canvas', 'webgl'] as const) {
      const initial = workspaceToFormInitial({
        ...base,
        terminalRenderer: r
      } as unknown as Parameters<typeof workspaceToFormInitial>[0]);
      expect(initial.terminalRenderer).toBe(r);
    }
  });

  it('leaves it undefined (inherit) when the workspace has no override', () => {
    const initial = workspaceToFormInitial(
      base as unknown as Parameters<typeof workspaceToFormInitial>[0]
    );
    expect(initial.terminalRenderer).toBeUndefined();
  });
});
