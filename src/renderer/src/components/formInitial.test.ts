// Regression tests for the workspace → form-initial mapping shared by the
// Saved-tab Resume flow (WorkspaceModal) and the live Edit modal
// (EditWorkspaceModal). Any field the form manages but the mapper omits is
// silently RESET on save — the form falls back to its default and the
// writeManifest handler treats submitted fields as authoritative. That's how
// resuming a saved WSL workspace wiped its launcher (distro/shell/home/
// claudePath) from the manifest, and how both flows factory-reset mirror.

import { describe, expect, it } from 'vitest';
import type { WorkspaceSummary } from '../App';
import { workspaceToFormInitial } from './formInitial';

function fixture(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: '01JWORKSPACEULID0000000000',
    name: 'wsl-box',
    description: 'a wsl local workspace',
    labels: ['wsl'],
    color: { hue: 180 },
    state: 'stopped',
    workspaceRoot: '/home/troy/projects/app',
    workspaceSubdir: '',
    kind: 'local',
    authMode: 'oauth',
    env: { plain: { FOO: 'bar' }, secretKeys: ['MY_TOKEN'] },
    mirror: { default: 'off', cleanup: 'preserve' },
    createdAt: 1,
    lastUsedAt: 2,
    ...overrides
  };
}

describe('workspaceToFormInitial', () => {
  it('carries the launcher through so resuming a saved WSL workspace keeps distro/shell', () => {
    const launcher = {
      mode: 'wsl' as const,
      distro: 'Ubuntu-24.04',
      shell: '/bin/bash',
      home: '/home/troy',
      claudePath: '/home/troy/.local/bin/claude'
    };
    const initial = workspaceToFormInitial(fixture({ launcher }));
    expect(initial.launcher).toEqual(launcher);
  });

  it('carries mirror defaults through (edit/resume must not factory-reset them)', () => {
    const initial = workspaceToFormInitial(fixture());
    expect(initial.mirror).toEqual({ default: 'off', cleanup: 'preserve' });
  });

  it('carries the committee accessibility opt-in through', () => {
    const accessibility = { reachable: true, roleHint: 'security' };
    const initial = workspaceToFormInitial(fixture({ accessibility }));
    expect(initial.accessibility).toEqual(accessibility);
  });

  it('maps env onto the form initial shape (plainEnv + secretKeys)', () => {
    const initial = workspaceToFormInitial(fixture());
    expect(initial.plainEnv).toEqual({ FOO: 'bar' });
    expect(initial.secretKeys).toEqual(['MY_TOKEN']);
  });

  it('keeps identity and user-facing fields', () => {
    const initial = workspaceToFormInitial(fixture());
    expect(initial.id).toBe('01JWORKSPACEULID0000000000');
    expect(initial.name).toBe('wsl-box');
    expect(initial.kind).toBe('local');
    expect(initial.workspaceRoot).toBe('/home/troy/projects/app');
    expect(initial.color).toEqual({ hue: 180 });
  });
});
