import { describe, expect, it } from 'vitest';
import {
  containerPathError,
  defaultContainerPath,
  duplicateContainerPaths,
  normalizeContainerPath,
  sanitizeMounts
} from './extraMounts';

describe('defaultContainerPath', () => {
  it('uses the basename of a Windows path', () => {
    expect(defaultContainerPath('C:\\Users\\troy\\src\\tofumate')).toBe('/mnt/tofumate');
  });
  it('uses the basename of a POSIX path and ignores a trailing slash', () => {
    expect(defaultContainerPath('/home/troy/data/')).toBe('/mnt/data');
  });
  it('replaces characters outside [A-Za-z0-9._-]', () => {
    expect(defaultContainerPath('D:\\My Stuff')).toBe('/mnt/My-Stuff');
  });
  it('falls back to /mnt/folder for a drive root or empty input', () => {
    expect(defaultContainerPath('C:\\')).toBe('/mnt/folder');
    expect(defaultContainerPath('')).toBe('/mnt/folder');
  });
});

describe('normalizeContainerPath', () => {
  it('collapses slashes and strips a trailing slash', () => {
    expect(normalizeContainerPath('/mnt//data/')).toBe('/mnt/data');
  });
  it('resolves dot segments', () => {
    expect(normalizeContainerPath('/mnt/a/../b')).toBe('/mnt/b');
  });
});

describe('containerPathError', () => {
  const host = 'C:\\Users\\troy\\notes';
  it('accepts /mnt and /workspace subpaths', () => {
    expect(containerPathError('/mnt/notes', host)).toBeNull();
    expect(containerPathError('/workspace/tofumate', host)).toBeNull();
  });
  it('requires an absolute path', () => {
    expect(containerPathError('mnt/notes', host)).toBe('Container path must start with /.');
  });
  it('refuses / and /workspace itself', () => {
    expect(containerPathError('/', host)).toBe("/ can't be replaced. Use a path like /mnt/notes.");
    expect(containerPathError('/workspace/', host)).toBe(
      "/workspace is this workspace's private folder. Mount inside it, like /workspace/notes, or use /mnt/notes."
    );
  });
  it('refuses reserved prefixes with the spec copy', () => {
    expect(containerPathError('/shared/notes', host)).toBe(
      "/shared is the fleet's shared folder. Use a path outside it, like /mnt/notes."
    );
    expect(containerPathError('/home/fleet/.claude/x', host)).toBe(
      "/home/fleet/.claude is claude's settings folder. Use a path outside it, like /mnt/notes."
    );
    expect(containerPathError('/etc', host)).toBe(
      '/etc is a system folder. Use a path outside it, like /mnt/notes.'
    );
  });
  it("refuses ancestors of the app's own mount targets", () => {
    expect(containerPathError('/home/fleet', host)).toBe(
      "/home/fleet contains the app's own folders (/home/fleet/.claude). Use a path outside it, like /mnt/notes."
    );
    expect(containerPathError('/home', host)).toBe(
      "/home contains the app's own folders (/home/fleet/.claude). Use a path outside it, like /mnt/notes."
    );
    expect(containerPathError('/run', host)).toBe(
      "/run contains the app's own folders (/run/broker). Use a path outside it, like /mnt/notes."
    );
    expect(containerPathError('/fleet/', host)).toBe(
      "/fleet contains the app's own folders (/fleet/mcp). Use a path outside it, like /mnt/notes."
    );
  });
  it('refuses /var/run and /var/lock as system folders', () => {
    expect(containerPathError('/var/run/broker', host)).toBe(
      '/var/run is a system folder. Use a path outside it, like /mnt/notes.'
    );
    expect(containerPathError('/var/lock', host)).toBe(
      '/var/lock is a system folder. Use a path outside it, like /mnt/notes.'
    );
  });
  it('allows siblings that only share a name prefix with internal targets', () => {
    expect(containerPathError('/home/fleetx', host)).toBeNull();
    expect(containerPathError('/runner', host)).toBeNull();
    expect(containerPathError('/home/fleet/projects', host)).toBeNull();
    expect(containerPathError('/var/data', host)).toBeNull();
  });
  it('does not treat a shared name prefix as a match', () => {
    expect(containerPathError('/shared-data', host)).toBeNull();
    expect(containerPathError('/libs', host)).toBeNull();
  });
});

describe('duplicateContainerPaths', () => {
  it('returns normalized paths used more than once', () => {
    expect(
      duplicateContainerPaths([{ containerPath: '/mnt/a' }, { containerPath: '/mnt/a/' }, { containerPath: '/mnt/b' }])
    ).toEqual(new Set(['/mnt/a']));
  });
});

describe('sanitizeMounts', () => {
  it('keeps well-formed entries and coerces readOnly', () => {
    expect(
      sanitizeMounts([
        { hostPath: '/a', containerPath: '/mnt/a', readOnly: true },
        { hostPath: '/b', containerPath: '/mnt/b' },
        { hostPath: '', containerPath: '/mnt/c', readOnly: false },
        { hostPath: '/d' },
        'junk'
      ])
    ).toEqual([
      { hostPath: '/a', containerPath: '/mnt/a', readOnly: true },
      { hostPath: '/b', containerPath: '/mnt/b', readOnly: false }
    ]);
  });
  it('returns undefined for non-arrays and empty results', () => {
    expect(sanitizeMounts(undefined)).toBeUndefined();
    expect(sanitizeMounts([])).toBeUndefined();
    expect(sanitizeMounts({})).toBeUndefined();
  });
});
