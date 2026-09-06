import { describe, expect, it } from 'vitest';
import { isDaemonConnectError, mergeWorkspaces } from './workspaceMerge.js';
import type { Workspace, WorkspaceSpec, WorkspaceState } from './workspaces.js';

const MIRROR = { default: 'off' } as never; // shape only matters to passthrough

function spec(id: string, kind: 'container' | 'local'): WorkspaceSpec {
  return {
    id, name: `ws-${id}`, labels: [], workspaceRoot: `/root/${id}`, workspaceSubdir: '',
    kind, authMode: 'oauth', env: { plain: {}, secretKeys: [] }
  } as unknown as WorkspaceSpec;
}
function live(id: string, kind: 'container' | 'local', state: WorkspaceState): Workspace {
  return { ...spec(id, kind), state, containerId: `c-${id}`, status: 'Up' } as Workspace;
}
const privateDir = async (id: string): Promise<string> => `/fleet/${id}`;
const down = (): PromiseSettledResult<Workspace[]> => ({
  status: 'rejected',
  reason: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
});
const up = (ws: Workspace[]): PromiseSettledResult<Workspace[]> => ({ status: 'fulfilled', value: ws });

describe('isDaemonConnectError', () => {
  it('matches daemon-connect codes', () => {
    for (const code of ['ECONNREFUSED', 'ENOENT', 'ENOTFOUND', 'EPIPE', 'ECONNRESET']) {
      expect(isDaemonConnectError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });
  it('rejects everything else', () => {
    expect(isDaemonConnectError(new Error('boom'))).toBe(false);
    expect(isDaemonConnectError(Object.assign(new Error('x'), { code: 'EAUTH' }))).toBe(false);
    expect(isDaemonConnectError(undefined)).toBe(false);
    expect(isDaemonConnectError({ code: 404 })).toBe(false);
  });
});

describe('mergeWorkspaces', () => {
  it('daemon up: merges live + manifests and repopulates lastKnown', async () => {
    const lastKnown = new Map<string, WorkspaceState>([['stale-id', 'running']]);
    const out = await mergeWorkspaces({
      dockerResult: up([live('a', 'container', 'running')]),
      localLive: [live('l', 'local', 'running')],
      manifests: [spec('a', 'container'), spec('b', 'container'), spec('l', 'local')],
      lastKnown, privateDir, factoryMirror: MIRROR
    });
    const byId = new Map(out.map((w) => [w.id, w]));
    expect(byId.get('a')?.state).toBe('running');
    expect(byId.get('a')?.workspaceRoot).toBe('/fleet/a'); // container root is canonical
    expect(byId.get('b')?.state).toBe('deleted');          // manifest with no live entry
    expect(byId.get('l')?.state).toBe('running');
    expect(byId.get('l')?.workspaceRoot).toBe('/root/l');  // local keeps manifest root
    // map repopulated from merged container states, stale ids dropped
    expect(lastKnown.get('a')).toBe('running');
    expect(lastKnown.get('b')).toBe('deleted');
    expect(lastKnown.has('stale-id')).toBe(false);
    expect(lastKnown.has('l')).toBe(false);                // container-kind only
  });

  // The live-workspace overlay is field-by-field, so a manifest-only field is
  // dropped unless it is listed explicitly (#358 moved `harness` here when
  // workspace:list stopped inlining its own overlay).
  it('carries manifest-only `harness` onto a LIVE workspace', async () => {
    const m = { ...spec('q', 'container'), authMode: 'endpoint', harness: 'qwen-code' } as WorkspaceSpec;
    const out = await mergeWorkspaces({
      dockerResult: up([live('q', 'container', 'running')]),
      localLive: [],
      manifests: [m],
      lastKnown: new Map(), privateDir, factoryMirror: MIRROR
    });
    expect(out.find((w) => w.id === 'q')?.harness).toBe('qwen-code');
  });

  it('leaves `harness` undefined for a claude-code workspace (absent ⇒ default)', async () => {
    const out = await mergeWorkspaces({
      dockerResult: up([live('c', 'container', 'running')]),
      localLive: [],
      manifests: [spec('c', 'container')],
      lastKnown: new Map(), privateDir, factoryMirror: MIRROR
    });
    expect(out.find((w) => w.id === 'c')?.harness).toBeUndefined();
  });

  it('daemon down: container manifests become unreachable with lastKnownState', async () => {
    const lastKnown = new Map<string, WorkspaceState>([['a', 'running'], ['p', 'paused']]);
    const out = await mergeWorkspaces({
      dockerResult: down(),
      localLive: [live('l', 'local', 'running')],
      manifests: [spec('a', 'container'), spec('p', 'container'), spec('l', 'local')],
      lastKnown, privateDir, factoryMirror: MIRROR
    });
    const byId = new Map(out.map((w) => [w.id, w]));
    expect(byId.get('a')).toMatchObject({ state: 'unreachable', lastKnownState: 'running' });
    expect(byId.get('a')?.containerId).toBeUndefined();
    expect(byId.get('p')).toMatchObject({ state: 'unreachable', lastKnownState: 'paused' });
    expect(byId.get('l')?.state).toBe('running');          // local unaffected
    expect(lastKnown.get('a')).toBe('running');            // map NOT clobbered while down
  });

  it('daemon down: deleted stays deleted; unknown ids get no lastKnownState', async () => {
    const lastKnown = new Map<string, WorkspaceState>([['gone', 'deleted']]);
    const out = await mergeWorkspaces({
      dockerResult: down(), localLive: [],
      manifests: [spec('gone', 'container'), spec('mystery', 'container')],
      lastKnown, privateDir, factoryMirror: MIRROR
    });
    const byId = new Map(out.map((w) => [w.id, w]));
    expect(byId.get('gone')?.state).toBe('deleted');
    expect(byId.get('gone')?.lastKnownState).toBeUndefined();
    expect(byId.get('mystery')).toMatchObject({ state: 'unreachable' });
    expect(byId.get('mystery')?.lastKnownState).toBeUndefined();
  });

  it('non-connect docker errors rethrow', async () => {
    const boom = new Error('label filter exploded');
    await expect(
      mergeWorkspaces({
        dockerResult: { status: 'rejected', reason: boom }, localLive: [],
        manifests: [], lastKnown: new Map(), privateDir, factoryMirror: MIRROR
      })
    ).rejects.toBe(boom);
  });

  it('recovery: an up-merge after a down-merge restores real states', async () => {
    const lastKnown = new Map<string, WorkspaceState>();
    const args = { localLive: [], manifests: [spec('a', 'container')], lastKnown, privateDir, factoryMirror: MIRROR };
    await mergeWorkspaces({ ...args, dockerResult: up([live('a', 'container', 'running')]) });
    const during = await mergeWorkspaces({ ...args, dockerResult: down() });
    expect(during[0]).toMatchObject({ state: 'unreachable', lastKnownState: 'running' });
    const after = await mergeWorkspaces({ ...args, dockerResult: up([live('a', 'container', 'paused')]) });
    expect(after[0].state).toBe('paused');
    expect(after[0].lastKnownState).toBeUndefined();
    expect(lastKnown.get('a')).toBe('paused');
  });

  it('manifest-only terminalRenderer overlay: live workspace inherits manifest override (#268)', async () => {
    const spec_a = { ...spec('a', 'container'), terminalRenderer: 'webgl' as const };
    const live_a = { ...live('a', 'container', 'running') }; // no terminalRenderer
    const out = await mergeWorkspaces({
      dockerResult: up([live_a]),
      localLive: [],
      manifests: [spec_a],
      lastKnown: new Map(),
      privateDir, factoryMirror: MIRROR
    });
    expect(out[0]).toMatchObject({ id: 'a', terminalRenderer: 'webgl' });
  });
});
