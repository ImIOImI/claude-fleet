import { describe, expect, it } from 'vitest';
import type { WorkspaceSpec } from '../workspaces.js';
import { revokePublishTarget } from './revoke.js';

const R1 = '01JC00000000000000000000R1';
const R2 = '01JC00000000000000000000R2';
const ws = (id: string, publish?: WorkspaceSpec['publish'], kind: WorkspaceSpec['kind'] = 'local') => ({ id, name: id, kind, publish }) as WorkspaceSpec;

describe('revokePublishTarget', () => {
  it('strips the target from every local manifest and drops the cursors towards it', async () => {
    let manifests = [
      ws('A', { to: [R1, R2], since: { [R1]: 5, [R2]: 6 }, from: { [R1]: 0, [R2]: 1 } }),
      ws('B', { to: [R1], since: { [R1]: 7 } }),
      ws('C', { to: [R2], since: { [R2]: 8 } }),
      ws(R1, undefined, 'remote')
    ];
    const writes: string[] = [];
    const dropped: string[] = [];
    await revokePublishTarget(R1, {
      listManifests: async () => manifests,
      writeManifest: async (s) => {
        writes.push(s.id);
        manifests = manifests.map((m) => (m.id === s.id ? s : m));
      },
      deleteCursorsTo: async (t) => void dropped.push(t)
    });
    expect(writes).toEqual(['A', 'B']);
    expect(manifests.map((m) => m.publish)).toEqual([{ to: [R2], since: { [R2]: 6 }, from: { [R2]: 1 } }, undefined, { to: [R2], since: { [R2]: 8 } }, undefined]);
    expect(dropped).toEqual([R1]);
  });
});
