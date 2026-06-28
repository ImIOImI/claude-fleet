// Candidate filter for the "Accept from" manager multiselect: only other
// container workspaces that are currently managers are eligible.

import { describe, expect, it } from 'vitest';
import { eligibleAcceptFromManagers, type CommitteeFields } from './committee';

function ws(id: string, over: Partial<CommitteeFields> = {}): CommitteeFields {
  return { id, kind: 'container', ...over };
}

const grant = { canControl: [{ id: '01EXPERT', verbs: ['read' as const] }] };

describe('eligibleAcceptFromManagers', () => {
  it('includes other container workspaces that hold grants (managers)', () => {
    const mgr = ws('01MGR', { control: grant });
    expect(eligibleAcceptFromManagers([mgr], '01SELF')).toEqual([mgr]);
  });

  it('excludes the workspace being edited (self), even if it is a manager', () => {
    const self = ws('01SELF', { control: grant });
    const other = ws('01MGR', { control: grant });
    expect(eligibleAcceptFromManagers([self, other], '01SELF')).toEqual([other]);
  });

  it('excludes non-manager workspaces (no outbound grants)', () => {
    const plain = ws('01PLAIN');
    const reachableOnly = ws('01EXP', { accessibility: { reachable: true } });
    expect(eligibleAcceptFromManagers([plain, reachableOnly], '01SELF')).toEqual([]);
  });

  it('excludes local (non-container) managers — committee control is container-only', () => {
    const localMgr = ws('01LOCAL', { kind: 'local', control: grant });
    expect(eligibleAcceptFromManagers([localMgr], '01SELF')).toEqual([]);
  });

  it('returns empty for an empty fleet', () => {
    expect(eligibleAcceptFromManagers([], '01SELF')).toEqual([]);
  });
});
