import { describe, expect, it } from 'vitest';
import { PUBLISH_TARGETS_MAX, publishFloor, publishForWrite, publishOnWrite, sanitizePublish, widenPublish } from './publish';

const R1 = '01JC00000000000000000000R1';
const R2 = '01JC00000000000000000000R2';
const remotes = new Set([R1, R2]);

describe('sanitizePublish', () => {
  it('keeps well-formed targets that have a since', () => {
    expect(sanitizePublish({ to: [R1, R1, 'bad', 7, R2], since: { [R1]: 5, [R2]: 0 } })).toEqual({ to: [R1], since: { [R1]: 5 } });
  });
  it('drops anything else', () => {
    expect(sanitizePublish(undefined)).toBeUndefined();
    expect(sanitizePublish({ to: [], since: {} })).toBeUndefined();
    expect(sanitizePublish({ to: 'x' })).toBeUndefined();
    expect(sanitizePublish({ to: [R1], since: { [R1]: 1.5 } })).toBeUndefined();
    expect(sanitizePublish({ to: [R1], since: { [R1]: '5' } })).toBeUndefined();
  });
  it('caps the number of targets', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `01JC0000000000000000000${String(i).padStart(3, '0')}`);
    expect(sanitizePublish({ to: ids, since: Object.fromEntries(ids.map((id) => [id, 1])) })?.to).toHaveLength(PUBLISH_TARGETS_MAX);
  });
});

describe('publishForWrite', () => {
  it('stamps a newly added target with now and keeps an existing since', () => {
    expect(publishForWrite({ to: [R1, R2] }, { to: [R1], since: { [R1]: 5 } }, remotes, 100)).toEqual({ to: [R1, R2], since: { [R1]: 5, [R2]: 100 } });
  });
  it('ignores a since sent by the renderer', () => {
    expect(publishForWrite({ to: [R2], since: { [R2]: 1 } }, undefined, remotes, 100)).toEqual({ to: [R2], since: { [R2]: 100 } });
    expect(publishForWrite({ to: [R1], since: { [R1]: 1 } }, { to: [R1], since: { [R1]: 5 } }, remotes, 100)).toEqual({ to: [R1], since: { [R1]: 5 } });
  });
  it('drops targets that are not bookmarked remote workspaces, and clears when none remain', () => {
    expect(publishForWrite({ to: ['01JC00000000000000000000ZZ'] }, undefined, remotes, 100)).toBeUndefined();
    expect(publishForWrite({ to: [] }, { to: [R1], since: { [R1]: 5 } }, remotes, 100)).toBeUndefined();
    expect(publishForWrite(undefined, undefined, remotes, 100)).toBeUndefined();
  });
  it('gives a target turned off and on again a new since', () => {
    const off = publishForWrite({ to: [R2] }, { to: [R1, R2], since: { [R1]: 5, [R2]: 6 } }, remotes, 100);
    expect(publishForWrite({ to: [R1, R2] }, off, remotes, 200)).toEqual({ to: [R1, R2], since: { [R1]: 200, [R2]: 6 } });
  });
});

describe('publishOnWrite', () => {
  it('keeps the stored block when the spec has no publish key', () => {
    const stored = { to: [R1], since: { [R1]: 5 } };
    expect(publishOnWrite({ name: 'x' }, stored, remotes, 100)).toBe(stored);
    expect(publishOnWrite({ publish: undefined }, stored, remotes, 100)).toBeUndefined();
  });
});

describe('backfill floor (from)', () => {
  it('sanitize keeps a from below its since, only for targets that are on', () => {
    expect(sanitizePublish({ to: [R1, R2], since: { [R1]: 50, [R2]: 60 }, from: { [R1]: 0, [R2]: 60, ['01JC00000000000000000000ZZ']: 1 } }))
      .toEqual({ to: [R1, R2], since: { [R1]: 50, [R2]: 60 }, from: { [R1]: 0 } });
    expect(sanitizePublish({ to: [R1], since: { [R1]: 50 }, from: { [R1]: -1 } })).toEqual({ to: [R1], since: { [R1]: 50 } });
    expect(sanitizePublish({ to: [R1], since: { [R1]: 50 }, from: { [R1]: 1.5 } })).toEqual({ to: [R1], since: { [R1]: 50 } });
  });
  it('the floor is from when set, else since', () => {
    expect(publishFloor({ to: [R1, R2], since: { [R1]: 50, [R2]: 60 }, from: { [R1]: 10 } }, R1)).toBe(10);
    expect(publishFloor({ to: [R1, R2], since: { [R1]: 50, [R2]: 60 }, from: { [R1]: 10 } }, R2)).toBe(60);
  });
  it('a save keeps a kept target’s from and ignores one sent by the renderer', () => {
    const stored = { to: [R1], since: { [R1]: 50 }, from: { [R1]: 10 } };
    expect(publishForWrite({ to: [R1, R2], since: { [R2]: 1 }, from: { [R2]: 0 } }, stored, remotes, 100))
      .toEqual({ to: [R1, R2], since: { [R1]: 50, [R2]: 100 }, from: { [R1]: 10 } });
    expect(publishForWrite({ to: [R2], from: { [R2]: 0 } }, undefined, remotes, 100)).toEqual({ to: [R2], since: { [R2]: 100 } });
  });
  it('a target turned off and on again loses its from', () => {
    const off = publishForWrite({ to: [R2] }, { to: [R1, R2], since: { [R1]: 50, [R2]: 60 }, from: { [R1]: 10 } }, remotes, 100);
    expect(publishForWrite({ to: [R1, R2] }, off, remotes, 200)).toEqual({ to: [R1, R2], since: { [R1]: 200, [R2]: 60 } });
  });
});

describe('widenPublish', () => {
  const stored = { to: [R1, R2], since: { [R1]: 50, [R2]: 60 } };
  it('lowers one target’s floor to a date or to all', () => {
    expect(widenPublish(stored, R1, 20)).toEqual({ ...stored, from: { [R1]: 20 } });
    expect(widenPublish({ ...stored, from: { [R1]: 20 } }, R1, 'all')).toEqual({ ...stored, from: { [R1]: 0 } });
    expect(widenPublish({ ...stored, from: { [R1]: 20 } }, R2, 5)).toEqual({ ...stored, from: { [R1]: 20, [R2]: 5 } });
  });
  it('only widens: a date at or after the current floor is refused', () => {
    expect(() => widenPublish(stored, R1, 50)).toThrow(/earlier/);
    expect(() => widenPublish(stored, R1, 51)).toThrow(/earlier/);
    expect(() => widenPublish({ ...stored, from: { [R1]: 20 } }, R1, 30)).toThrow(/earlier/);
    expect(() => widenPublish({ ...stored, from: { [R1]: 0 } }, R1, 'all')).toThrow(/earlier/);
  });
  it('refuses a target that is not on, and anything but a safe non-negative integer or all', () => {
    expect(() => widenPublish(stored, '01JC00000000000000000000ZZ', 0)).toThrow(/not on/);
    expect(() => widenPublish(undefined, R1, 0)).toThrow(/not on/);
    for (const bad of [-1, 1.5, '10', null, undefined, Number.MAX_SAFE_INTEGER + 1, { from: 0 }]) expect(() => widenPublish(stored, R1, bad)).toThrow(/start date/);
  });
});
