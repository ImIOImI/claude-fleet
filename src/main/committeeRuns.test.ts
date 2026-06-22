// Runaway-guard budget (#121). Caps are read from env at module load, so we set
// small caps before importing to keep the truth table cheap.

import { beforeEach, describe, expect, it } from 'vitest';

process.env.COMMITTEE_MAX_POSTS = '2';
process.env.COMMITTEE_USD_CEILING = '5';

const { wouldExceed, recordPost, resetRun, COMMITTEE_CAPS } = await import('./committeeRuns.js');

const M = '01MANAGER';

beforeEach(() => resetRun(M));

describe('committee run budget (#121)', () => {
  it('reads caps from env', () => {
    expect(COMMITTEE_CAPS.maxPosts).toBe(2);
    expect(COMMITTEE_CAPS.usdCeiling).toBe(5);
  });

  it('permits posts up to the cap, then refuses (checks the about-to-be count)', () => {
    expect(wouldExceed(M, 0).exceeded).toBe(false); // would be post #1
    recordPost(M);
    expect(wouldExceed(M, 0).exceeded).toBe(false); // would be post #2
    recordPost(M);
    const v = wouldExceed(M, 0); // would be post #3 > cap of 2
    expect(v.exceeded).toBe(true);
    expect(v.reason).toMatch(/max posts/);
  });

  it('refuses when spent USD exceeds the ceiling, regardless of post count', () => {
    expect(wouldExceed(M, 4.99).exceeded).toBe(false);
    const v = wouldExceed(M, 5.01);
    expect(v.exceeded).toBe(true);
    expect(v.reason).toMatch(/USD ceiling/);
  });

  it('resetRun clears a manager run counter', () => {
    recordPost(M);
    recordPost(M);
    expect(wouldExceed(M, 0).exceeded).toBe(true);
    resetRun(M);
    expect(wouldExceed(M, 0).exceeded).toBe(false);
  });

  it('tracks managers independently', () => {
    recordPost(M);
    recordPost(M);
    expect(wouldExceed(M, 0).exceeded).toBe(true);
    expect(wouldExceed('01OTHER', 0).exceeded).toBe(false);
  });
});
