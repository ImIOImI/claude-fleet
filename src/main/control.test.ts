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

const { decideControl, assertControl } = await import('./control.js');
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
