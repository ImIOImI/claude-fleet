import { describe, expect, it } from 'vitest';
import {
  hostPlaceholder,
  mountRowErrors,
  mountsEqual,
  mountsFromRows,
  mountsSummary,
  rowsFromMounts
} from './mountRows';
import { containerLevelChanged } from './EditWorkspaceModal';

describe('mountsFromRows', () => {
  it('drops rows without a host path and fills the default container path', () => {
    expect(
      mountsFromRows([
        { hostPath: '  ', containerPath: '/mnt/x', readOnly: false },
        { hostPath: 'C:\\data\\play-cards', containerPath: '', readOnly: true },
        { hostPath: '/srv/a', containerPath: '/mnt/a/', readOnly: false }
      ])
    ).toEqual([
      { hostPath: 'C:\\data\\play-cards', containerPath: '/mnt/play-cards', readOnly: true },
      { hostPath: '/srv/a', containerPath: '/mnt/a', readOnly: false }
    ]);
  });
  it('returns undefined when nothing survives', () => {
    expect(mountsFromRows([])).toBeUndefined();
  });
});

describe('mountRowErrors', () => {
  it('flags reserved and duplicate paths per row, skipping blank rows', () => {
    expect(
      mountRowErrors([
        { hostPath: 'C:\\notes', containerPath: '/shared/notes', readOnly: false },
        { hostPath: '/a', containerPath: '/mnt/a', readOnly: false },
        { hostPath: '/b', containerPath: '/mnt/a', readOnly: false },
        { hostPath: '', containerPath: '', readOnly: false }
      ])
    ).toEqual([
      "/shared is the fleet's shared folder. Use a path outside it, like /mnt/notes.",
      null,
      '/mnt/a is already used by another mount.',
      null
    ]);
  });
  it('checks the default path when the container path is empty', () => {
    expect(mountRowErrors([{ hostPath: '/x/etc', containerPath: '', readOnly: false }])).toEqual([null]);
  });
});

describe('mountsSummary', () => {
  it('describes counts', () => {
    expect(mountsSummary(undefined)).toBe('(none)');
    expect(mountsSummary([{ hostPath: '/a', containerPath: '/mnt/a', readOnly: false }])).toBe('1 folder');
    expect(
      mountsSummary([
        { hostPath: '/a', containerPath: '/mnt/a', readOnly: true },
        { hostPath: '/b', containerPath: '/mnt/b', readOnly: false }
      ])
    ).toBe('2 folders · 1 read-only');
  });
});

describe('hostPlaceholder', () => {
  it('is platform-specific', () => {
    expect(hostPlaceholder('win32')).toBe('C:\\path\\to\\folder');
    expect(hostPlaceholder('linux')).toBe('/home/you/folder');
  });
});

describe('rowsFromMounts / mountsEqual', () => {
  it('round-trips and compares by value', () => {
    const m = [{ hostPath: '/a', containerPath: '/mnt/a', readOnly: true }];
    expect(mountsFromRows(rowsFromMounts(m))).toEqual(m);
    expect(mountsEqual(m, [{ ...m[0] }])).toBe(true);
    expect(mountsEqual(m, undefined)).toBe(false);
    expect(mountsEqual(undefined, [])).toBe(true);
  });
});

describe('containerLevelChanged (mounts)', () => {
  it('treats a mounts change as container-level', () => {
    const before = {
      authMode: 'oauth',
      image: 'img',
      env: { plain: {}, secretKeys: [] },
      mounts: undefined
    } as never;
    const after = {
      authMode: 'oauth',
      image: 'img',
      plainEnv: {},
      secretKeys: [],
      secrets: {},
      mounts: [{ hostPath: '/a', containerPath: '/mnt/a', readOnly: false }]
    } as never;
    expect(containerLevelChanged(before, after)).toBe(true);
  });
});
