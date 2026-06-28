// Truth table for the committee control gate (#118). decideControl is pure, so
// the bulk of the matrix needs no I/O; assertControl is exercised against a
// mocked manifest loader to prove the load → decide → throw wiring.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WorkspaceSpec } from './workspaces.js';

// Partial mock: keep the real types/sanitizers, stub only the disk read.
vi.mock('./workspaces.js', async (orig) => ({
  ...(await orig<typeof import('./workspaces.js')>()),
  readWorkspaceManifest: vi.fn()
}));

const { decideControl, assertControl, decideRoster, buildRoster, ROSTER_TITLE_MAX } =
  await import('./control.js');
const { readWorkspaceManifest } = await import('./workspaces.js');
const mockRead = vi.mocked(readWorkspaceManifest);

/** Minimal container manifest; override the bits a case cares about. */
function ws(id: string, over: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    id,
    name: id,
    labels: [],
    workspaceRoot: '/w',
    workspaceSubdir: '',
    kind: 'container',
    authMode: 'oauth',
    env: { plain: {}, secretKeys: [] },
    mirror: { default: 'on', cleanup: 'delete' },
    createdAt: 0,
    lastUsedAt: 0,
    ...over
  };
}

const MGR = '01MANAGER';
const EXP = '01EXPERT';

/** A manager that may `post` to the expert, and an expert that opted in. */
function granted(): { manager: WorkspaceSpec; expert: WorkspaceSpec } {
  return {
    manager: ws(MGR, { control: { canControl: [{ id: EXP, verbs: ['read', 'post'] }] } }),
    expert: ws(EXP, { accessibility: { reachable: true } })
  };
}

describe('decideControl (#118 truth table)', () => {
  it('permits when the caller holds the verb and the target opted in', () => {
    const { manager, expert } = granted();
    expect(decideControl(manager, expert, MGR, EXP, 'post')).toEqual({ ok: true });
    expect(decideControl(manager, expert, MGR, EXP, 'read')).toEqual({ ok: true });
  });

  it('default-denies a verb the caller was not granted', () => {
    const { manager, expert } = granted(); // only read + post granted
    expect(decideControl(manager, expert, MGR, EXP, 'pause').ok).toBe(false);
  });

  it('default-denies when the caller holds no control block at all', () => {
    const expert = ws(EXP, { accessibility: { reachable: true } });
    expect(decideControl(ws(MGR), expert, MGR, EXP, 'read').ok).toBe(false);
  });

  it('denies when the target has not opted in (missing / reachable:false)', () => {
    const manager = granted().manager;
    expect(decideControl(manager, ws(EXP), MGR, EXP, 'post').ok).toBe(false);
    expect(
      decideControl(manager, ws(EXP, { accessibility: { reachable: false } }), MGR, EXP, 'post').ok
    ).toBe(false);
  });

  it('honors acceptFrom: allows a named caller, denies an unnamed one', () => {
    const manager = granted().manager;
    const accepting = ws(EXP, { accessibility: { reachable: true, acceptFrom: [MGR] } });
    const rejecting = ws(EXP, { accessibility: { reachable: true, acceptFrom: ['01SOMEONE_ELSE'] } });
    expect(decideControl(manager, accepting, MGR, EXP, 'post').ok).toBe(true);
    expect(decideControl(manager, rejecting, MGR, EXP, 'post').ok).toBe(false);
  });

  it('denies a self-call even when self-reachable + self-granted', () => {
    const selfish = ws(MGR, {
      control: { canControl: [{ id: MGR, verbs: ['post'] }] },
      accessibility: { reachable: true }
    });
    expect(decideControl(selfish, selfish, MGR, MGR, 'post').ok).toBe(false);
  });

  it('denies when either manifest is missing', () => {
    const { manager, expert } = granted();
    expect(decideControl(null, expert, MGR, EXP, 'post').ok).toBe(false);
    expect(decideControl(manager, null, MGR, EXP, 'post').ok).toBe(false);
  });

  it('refuses to control a target that is itself a manager (no manager-of-managers)', () => {
    const manager = granted().manager;
    // The target opted in AND is granted by the caller — but it holds its own
    // outbound grant, making it a manager, so it must still be refused.
    const targetMgr = ws(EXP, {
      accessibility: { reachable: true },
      control: { canControl: [{ id: '01SUBEXPERT', verbs: ['post'] }] }
    });
    const decision = decideControl(manager, targetMgr, MGR, EXP, 'post');
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/manager/);
  });

  it('refuses if either side is a LOCAL workspace (container-only)', () => {
    const { manager, expert } = granted();
    const localMgr = ws(MGR, { ...manager, kind: 'local' });
    const localExp = ws(EXP, { ...expert, kind: 'local' });
    expect(decideControl(localMgr, expert, MGR, EXP, 'post').ok).toBe(false);
    expect(decideControl(manager, localExp, MGR, EXP, 'post').ok).toBe(false);
  });
});

describe('decideRoster (acceptFrom-gated discoverability)', () => {
  it('lists a reachable expert whose acceptFrom names the caller, no grant needed', () => {
    // Caller holds NO outbound grant — discovery must not require one.
    const expert = ws(EXP, { accessibility: { reachable: true, acceptFrom: [MGR] } });
    expect(decideRoster(ws(MGR), expert, MGR, EXP)).toEqual({ ok: true });
  });

  it('excludes a reachable expert with open/empty acceptFrom (not advertised)', () => {
    const open = ws(EXP, { accessibility: { reachable: true } });
    const empty = ws(EXP, { accessibility: { reachable: true, acceptFrom: [] } });
    expect(decideRoster(ws(MGR), open, MGR, EXP).ok).toBe(false);
    expect(decideRoster(ws(MGR), empty, MGR, EXP).ok).toBe(false);
  });

  it('excludes an expert whose acceptFrom names someone else', () => {
    const other = ws(EXP, { accessibility: { reachable: true, acceptFrom: ['01SOMEONE'] } });
    expect(decideRoster(ws(MGR), other, MGR, EXP).ok).toBe(false);
  });

  it('excludes a target that is not reachable', () => {
    const notReachable = ws(EXP, { accessibility: { reachable: false, acceptFrom: [MGR] } });
    expect(decideRoster(ws(MGR), notReachable, MGR, EXP).ok).toBe(false);
    expect(decideRoster(ws(MGR), ws(EXP), MGR, EXP).ok).toBe(false);
  });

  it('excludes a self-entry and a missing manifest', () => {
    const self = ws(MGR, { accessibility: { reachable: true, acceptFrom: [MGR] } });
    expect(decideRoster(self, self, MGR, MGR).ok).toBe(false);
    expect(decideRoster(ws(MGR), null, MGR, EXP).ok).toBe(false);
    expect(decideRoster(null, ws(EXP, { accessibility: { reachable: true, acceptFrom: [MGR] } }), MGR, EXP).ok).toBe(false);
  });

  it('excludes a target that is itself a manager (no manager-of-managers visibility)', () => {
    const targetMgr = ws(EXP, {
      accessibility: { reachable: true, acceptFrom: [MGR] },
      control: { canControl: [{ id: '01SUB', verbs: ['post'] }] }
    });
    expect(decideRoster(ws(MGR), targetMgr, MGR, EXP).ok).toBe(false);
  });

  it('excludes when either side is a LOCAL workspace (container-only)', () => {
    const expert = ws(EXP, { accessibility: { reachable: true, acceptFrom: [MGR] } });
    expect(decideRoster(ws(MGR, { kind: 'local' }), expert, MGR, EXP).ok).toBe(false);
    expect(decideRoster(ws(MGR), ws(EXP, { ...expert, kind: 'local' }), MGR, EXP).ok).toBe(false);
  });
});

describe('buildRoster (shaping)', () => {
  const status = () => ({ paused: false, busy: true, stalled: false, lastActiveAt: 42 });

  it('includes only discoverable experts and maps their metadata + status', () => {
    const caller = ws(MGR, { control: { canControl: [{ id: EXP, verbs: ['read', 'post'] }] } });
    const visible = ws(EXP, {
      name: 'sec-expert',
      description: 'reviews auth',
      labels: ['security'],
      accessibility: { reachable: true, acceptFrom: [MGR], roleHint: 'security' },
      installedLoadouts: [
        { id: 'committee-expert-security', title: 'Security reviewer', files: [], installedAt: 0 }
      ]
    });
    const hidden = ws('01OPEN', { accessibility: { reachable: true } }); // open acceptFrom

    const roster = buildRoster(caller, MGR, [caller, visible, hidden], status);

    expect(roster).toHaveLength(1);
    expect(roster[0]).toEqual({
      id: EXP,
      name: 'sec-expert',
      description: 'reviews auth',
      labels: ['security'],
      roleHint: 'security',
      installedLoadouts: [{ id: 'committee-expert-security', title: 'Security reviewer' }],
      status: { paused: false, busy: true, stalled: false, lastActiveAt: 42 },
      grant: { controllable: true, verbs: ['read', 'post'] }
    });
  });

  it('marks a discoverable-but-ungranted expert controllable:false', () => {
    const caller = ws(MGR); // no grants
    const expert = ws(EXP, { accessibility: { reachable: true, acceptFrom: [MGR] } });
    const roster = buildRoster(caller, MGR, [expert], status);
    expect(roster[0].grant).toEqual({ controllable: false, verbs: [] });
  });

  it('caps loadout titles to ROSTER_TITLE_MAX (untrusted OCI text)', () => {
    const caller = ws(MGR);
    const longTitle = 'x'.repeat(ROSTER_TITLE_MAX + 50);
    const expert = ws(EXP, {
      accessibility: { reachable: true, acceptFrom: [MGR] },
      installedLoadouts: [{ id: 'l', title: longTitle, files: [], installedAt: 0 }]
    });
    const roster = buildRoster(caller, MGR, [expert], status);
    expect(roster[0].installedLoadouts[0].title.length).toBe(ROSTER_TITLE_MAX);
  });
});

describe('assertControl (load → decide → throw)', () => {
  beforeEach(() => mockRead.mockReset());

  it('resolves (no throw) on a permitted call', async () => {
    const { manager, expert } = granted();
    mockRead.mockImplementation(async (id: string) => (id === MGR ? manager : expert));
    await expect(assertControl(MGR, EXP, 'post')).resolves.toBeUndefined();
  });

  it('throws with the denial reason on a denied call', async () => {
    const { manager, expert } = granted();
    mockRead.mockImplementation(async (id: string) => (id === MGR ? manager : expert));
    // 'pause' was never granted.
    await expect(assertControl(MGR, EXP, 'pause')).rejects.toThrow(/control denied/);
  });

  it('re-reads both manifests on every call (instant revocation)', async () => {
    const { manager, expert } = granted();
    mockRead.mockImplementation(async (id: string) => (id === MGR ? manager : expert));
    await assertControl(MGR, EXP, 'post');
    await assertControl(MGR, EXP, 'post');
    // 2 calls × 2 manifests each = 4 fresh reads, never cached.
    expect(mockRead).toHaveBeenCalledTimes(4);
  });
});
