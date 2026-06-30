// Runaway-guard budget (#121). Caps are read from env at module load, so we set
// a small post cap before importing to keep the truth table cheap. There is no
// dollar cost control on committee runs — only the post-count runaway guard and
// the per-expert turn-timeout stall guard remain; the USD ceiling was removed
// because committee experts are meant to run without a spend cap.

import { beforeEach, describe, expect, it } from 'vitest';

process.env.COMMITTEE_MAX_POSTS = '2';

const { wouldExceed, recordPost, resetRun, COMMITTEE_CAPS } = await import('./committeeRuns.js');

const M = '01MANAGER';

beforeEach(() => resetRun(M));

describe('committee run budget (#121)', () => {
  it('reads the post cap from env', () => {
    expect(COMMITTEE_CAPS.maxPosts).toBe(2);
  });

  it('has no USD ceiling cap', () => {
    expect('usdCeiling' in COMMITTEE_CAPS).toBe(false);
  });

  it('permits posts up to the cap, then refuses (checks the about-to-be count)', () => {
    expect(wouldExceed(M).exceeded).toBe(false); // would be post #1
    recordPost(M);
    expect(wouldExceed(M).exceeded).toBe(false); // would be post #2
    recordPost(M);
    const v = wouldExceed(M); // would be post #3 > cap of 2
    expect(v.exceeded).toBe(true);
    expect(v.reason).toMatch(/max posts/);
  });

  it('never refuses on spend — there is no spend argument or cap anymore', () => {
    // A fresh run is always permitted no matter how much the experts have cost.
    expect(wouldExceed(M).exceeded).toBe(false);
  });

  it('resetRun clears a manager run counter', () => {
    recordPost(M);
    recordPost(M);
    expect(wouldExceed(M).exceeded).toBe(true);
    resetRun(M);
    expect(wouldExceed(M).exceeded).toBe(false);
  });

  it('tracks managers independently', () => {
    recordPost(M);
    recordPost(M);
    expect(wouldExceed(M).exceeded).toBe(true);
    expect(wouldExceed('01OTHER').exceeded).toBe(false);
  });
});
