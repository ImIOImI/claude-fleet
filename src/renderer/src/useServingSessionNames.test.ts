import { describe, it, expect } from 'vitest';
import { workspacesNeedingNames } from './useServingSessionNames.js';
import type { ServingPort } from '../../preload';

const port = (sessionId: string | null): ServingPort => ({
  port: 3000,
  pid: 1,
  cmdline: 'x',
  sessionId,
  firstSeenAt: 0
});

describe('workspacesNeedingNames', () => {
  it('returns only workspaces with at least one attributed port, sorted', () => {
    expect(
      workspacesNeedingNames({
        b: [port('tab-1')],
        a: [port(null), port('tab-2')],
        c: [port(null)],
        d: []
      })
    ).toEqual(['a', 'b']);
  });
  it('empty input → empty output', () => {
    expect(workspacesNeedingNames({})).toEqual([]);
  });
});
