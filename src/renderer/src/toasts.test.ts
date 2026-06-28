// Unit tests for the pure toast reducer (no DOM — renderer logic only, per
// vitest.config.ts). Covers push, dismiss, replace-by-key, and the sticky→
// dismissible normalization.

import { describe, expect, it } from 'vitest';
import { makeToast, toastReducer, type Toast, type ToastInput } from './toasts.js';

const input = (over: Partial<ToastInput> = {}): ToastInput => ({
  kind: 'progress',
  message: 'm',
  placement: 'global',
  sticky: false,
  dismissible: false,
  ...over
});

describe('makeToast', () => {
  it('stamps the id and forces sticky toasts to be dismissible', () => {
    expect(makeToast(1, input({ sticky: true })).dismissible).toBe(true);
    expect(makeToast(2, input({ sticky: false, dismissible: false })).dismissible).toBe(false);
    expect(makeToast(3, input()).id).toBe(3);
  });
});

describe('toastReducer', () => {
  const t = (id: number, over: Partial<Toast> = {}): Toast => ({ ...makeToast(id, input()), ...over });

  it('push appends', () => {
    const s = toastReducer([], { type: 'push', toast: t(1) });
    expect(s.map((x) => x.id)).toEqual([1]);
    expect(toastReducer(s, { type: 'push', toast: t(2) }).map((x) => x.id)).toEqual([1, 2]);
  });

  it('push with a key replaces the existing same-key toast (no duplicate)', () => {
    let s = toastReducer([], { type: 'push', toast: t(1, { key: 'mcp-down', message: 'first' }) });
    s = toastReducer(s, { type: 'push', toast: t(2, { message: 'other' }) });
    s = toastReducer(s, { type: 'push', toast: t(3, { key: 'mcp-down', message: 'second' }) });
    expect(s.filter((x) => x.key === 'mcp-down')).toHaveLength(1);
    expect(s.find((x) => x.key === 'mcp-down')!.message).toBe('second');
    expect(s.map((x) => x.id)).toEqual([2, 3]); // id 1 replaced, order preserved
  });

  it('dismiss removes by id', () => {
    const s = [t(1), t(2), t(3)];
    expect(toastReducer(s, { type: 'dismiss', id: 2 }).map((x) => x.id)).toEqual([1, 3]);
  });

  it('dismissKey removes by key, leaving keyless toasts', () => {
    const s = [t(1), t(2, { key: 'mcp-down' }), t(3)];
    expect(toastReducer(s, { type: 'dismissKey', key: 'mcp-down' }).map((x) => x.id)).toEqual([1, 3]);
  });
});
