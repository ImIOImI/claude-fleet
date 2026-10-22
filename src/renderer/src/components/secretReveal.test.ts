import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretRevealer, REVEAL_SECONDS, type RevealState } from './secretReveal';

function setup(fetchImpl: (key: string) => Promise<string | null>) {
  const states = new Map<string, RevealState | undefined>();
  const fetch = vi.fn(fetchImpl);
  const r = createSecretRevealer({
    fetch,
    onChange: (key, state) => states.set(key, state)
  });
  return { r, fetch, states };
}

describe('createSecretRevealer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fetches on reveal and shows the value with a full countdown', async () => {
    const { r, fetch, states } = setup(async () => 'ghp_abc');
    r.reveal('GH_TOKEN');
    expect(states.get('GH_TOKEN')).toEqual({ status: 'loading' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledWith('GH_TOKEN');
    expect(states.get('GH_TOKEN')).toEqual({
      status: 'shown',
      value: 'ghp_abc',
      remainingS: REVEAL_SECONDS
    });
  });

  it('counts down each second and hides at zero', async () => {
    const { r, states } = setup(async () => 'v');
    r.reveal('K');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(states.get('K')).toEqual({ status: 'shown', value: 'v', remainingS: REVEAL_SECONDS - 6 });
    await vi.advanceTimersByTimeAsync((REVEAL_SECONDS - 6) * 1000);
    expect(states.get('K')).toBeUndefined();
    expect(r.isActive('K')).toBe(false);
  });

  it('hide() clears the value immediately and stops the timer', async () => {
    const { r, states } = setup(async () => 'v');
    r.reveal('K');
    await vi.advanceTimersByTimeAsync(0);
    r.hide('K');
    expect(states.get('K')).toBeUndefined();
    states.set('K', { status: 'loading' }); // sentinel: no further callbacks
    await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000);
    expect(states.get('K')).toEqual({ status: 'loading' });
  });

  it('ignores a fetch that resolves after hide()', async () => {
    let resolve!: (v: string | null) => void;
    const { r, states } = setup(() => new Promise((res) => (resolve = res)));
    r.reveal('K');
    r.hide('K');
    resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(states.get('K')).toBeUndefined();
  });

  it('reports a missing vault value', async () => {
    const { r, states } = setup(async () => null);
    r.reveal('K');
    await vi.advanceTimersByTimeAsync(0);
    expect(states.get('K')).toEqual({ status: 'missing' });
  });

  it('reports a fetch failure without exposing a value', async () => {
    const { r, states } = setup(async () => {
      throw new Error('vault locked');
    });
    r.reveal('K');
    await vi.advanceTimersByTimeAsync(0);
    expect(states.get('K')).toEqual({ status: 'error', message: 'vault locked' });
  });

  it('hideAll() clears every key (modal close)', async () => {
    const { r, states } = setup(async (k) => `v-${k}`);
    r.reveal('A');
    r.reveal('B');
    await vi.advanceTimersByTimeAsync(0);
    r.hideAll();
    expect(states.get('A')).toBeUndefined();
    expect(states.get('B')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-revealing restarts the countdown', async () => {
    const { r, fetch, states } = setup(async () => 'v');
    r.reveal('K');
    await vi.advanceTimersByTimeAsync(10_000);
    r.hide('K');
    r.reveal('K');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(states.get('K')).toEqual({ status: 'shown', value: 'v', remainingS: REVEAL_SECONDS });
  });
});
