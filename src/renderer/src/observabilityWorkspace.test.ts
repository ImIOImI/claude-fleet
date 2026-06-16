import { describe, it, expect } from 'vitest';
import {
  workspaceHostPath,
  workspacePathLabel,
  formatResourceLimits
} from './observabilityWorkspace';

describe('workspaceHostPath', () => {
  it('joins root and subdir', () => {
    expect(
      workspaceHostPath({ workspaceRoot: '/home/troy/code/app', workspaceSubdir: 'services/api' })
    ).toBe('/home/troy/code/app/services/api');
  });

  it('returns root alone when subdir is empty', () => {
    expect(workspaceHostPath({ workspaceRoot: '/home/troy/code/app', workspaceSubdir: '' })).toBe(
      '/home/troy/code/app'
    );
  });

  it('normalizes stray slashes', () => {
    expect(
      workspaceHostPath({ workspaceRoot: '/home/troy/code/app/', workspaceSubdir: '/services/api/' })
    ).toBe('/home/troy/code/app/services/api');
  });
});

describe('workspacePathLabel', () => {
  it('shows the subdir with a leading slash', () => {
    expect(
      workspacePathLabel({ workspaceRoot: '/home/troy/code/app', workspaceSubdir: 'services/api' })
    ).toBe('/services/api');
  });

  it('falls back to the full root when there is no subdir', () => {
    expect(workspacePathLabel({ workspaceRoot: '/home/troy/code/app', workspaceSubdir: '' })).toBe(
      '/home/troy/code/app'
    );
  });
});

describe('formatResourceLimits', () => {
  it('formats cpu and memory', () => {
    expect(formatResourceLimits({ cpus: 2, memoryMb: 4096 })).toBe('2 cpu · 4096 MB');
  });

  it('includes only the fields present', () => {
    expect(formatResourceLimits({ cpus: 2 })).toBe('2 cpu');
    expect(formatResourceLimits({ memoryMb: 2048 })).toBe('2048 MB');
  });

  it('returns null when no limits are set', () => {
    expect(formatResourceLimits(undefined)).toBeNull();
    expect(formatResourceLimits({})).toBeNull();
  });
});
