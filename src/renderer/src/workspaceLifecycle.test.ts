import { describe, it, expect } from 'vitest';
import { applyContainerEdit, type WorkspaceLifecycleApi, type WorkspaceManifest } from './workspaceLifecycle';

/** A fake api that records the ordered sequence of lifecycle calls. */
function makeFakeApi(manifest: WorkspaceManifest | null): {
  api: WorkspaceLifecycleApi;
  calls: string[];
  createInput: () => unknown;
} {
  const calls: string[] = [];
  let createInput: unknown = null;
  const api: WorkspaceLifecycleApi = {
    async getManifest() {
      calls.push('getManifest');
      return manifest;
    },
    async ensureImage(_cb, image) {
      calls.push(`ensureImage:${image ?? ''}`);
    },
    async stop() {
      calls.push('stop');
    },
    async start() {
      calls.push('start');
      return null;
    },
    async remove(_c, opts) {
      calls.push(`remove:deleteState=${opts?.deleteState}`);
    },
    async create(input) {
      calls.push('create');
      createInput = input;
      return {};
    }
  };
  return { api, calls, createInput: () => createInput };
}

const manifest: WorkspaceManifest = {
  id: 'ws-1',
  name: 'demo',
  labels: [],
  workspaceSubdir: '',
  kind: 'container',
  workspaceRoot: '/fleet/ws-1',
  image: 'ghcr.io/imioimi/claude-fleet/runner-dev:latest',
  authMode: 'oauth',
  env: { plain: {}, secretKeys: [] },
  mirror: 'on'
};

describe('applyContainerEdit', () => {
  it('recreates the container from the saved manifest so image/env edits take effect', async () => {
    const { api, calls, createInput } = makeFakeApi(manifest);

    await applyContainerEdit(api, { id: 'ws-1', containerId: 'c-1' });

    // Pull the (possibly new) image, then replace the container: stop → remove
    // (keeping state) → create. A plain `start` would reuse the old container.
    expect(calls).toEqual([
      'getManifest',
      'ensureImage:ghcr.io/imioimi/claude-fleet/runner-dev:latest',
      'stop',
      'remove:deleteState=false',
      'create'
    ]);
    expect(calls).not.toContain('start');
    // Recreated from the manifest, reusing the same id and the new image.
    expect(createInput()).toMatchObject({
      id: 'ws-1',
      image: 'ghcr.io/imioimi/claude-fleet/runner-dev:latest'
    });
  });

  it('skips the image pull for local workspaces (no image to fetch)', async () => {
    const { api, calls } = makeFakeApi({ ...manifest, kind: 'local', image: undefined });

    await applyContainerEdit(api, { id: 'ws-1', containerId: 'c-1' });

    expect(calls.some((c) => c.startsWith('ensureImage'))).toBe(false);
    expect(calls).toEqual(['getManifest', 'stop', 'remove:deleteState=false', 'create']);
  });
});
