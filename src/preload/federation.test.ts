import { describe, expect, it } from 'vitest';
import { appendSessionPage, compareBytes, replaceSessionPage, compareSessionKey, cursorOf, mergeSessionPages, type SessionCursor, type SourcePage } from './federation';

type R = { id: string; workspaceId: string; lastActiveAt: number | null };
const row = (id: string, la: number | null, ws = 'W'): R => ({ id, workspaceId: ws, lastActiveAt: la });

/** A source that pages its sorted rows by keyset, as the host does. */
function pager(origin: string, all: R[]) {
  const sorted = [...all].sort(compareSessionKey);
  return (after: SessionCursor | null, limit: number): SourcePage<R> => {
    const rest = after ? sorted.filter((r) => compareSessionKey(r, { lastActiveAt: after.lastActiveAt, id: after.id }) > 0) : sorted;
    const rows = rest.slice(0, limit);
    return { origin, rows, next: rest.length > limit ? cursorOf(rows[rows.length - 1]) : null };
  };
}

describe('mergeSessionPages', () => {
  it('pages through ties without skips or repeats and ends equal to a one-shot merge', () => {
    const a = Array.from({ length: 37 }, (_, i) => row(`a${String(i).padStart(2, '0')}`, 1000 - (i % 4), 'A'));
    const b = Array.from({ length: 23 }, (_, i) => row(`b${String(i).padStart(2, '0')}`, i % 3 === 0 ? null : 1000 - (i % 5), 'B'));
    const pa = pager('HA', a), pb = pager('HB', b);
    let m = mergeSessionPages([pa(null, 5), pb(null, 5)]);
    let guard = 0;
    while (m.more.length && guard++ < 100) {
      const next = m.more[0];
      m = appendSessionPage(m, (next.origin === 'HA' ? pa : pb)(next.after, 5));
    }
    expect(m.more).toEqual([]);
    const ids = m.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(60);
    const full = mergeSessionPages([pa(null, 1000), pb(null, 1000)]);
    expect(ids).toEqual(full.rows.map((r) => r.id));
  });

  it('drops a duplicate (workspaceId, id), keeping the local row', () => {
    const m = mergeSessionPages([
      { origin: 'H1', rows: [row('s', 5, 'W1')], next: null },
      { origin: 'local', rows: [row('s', 5, 'W1')], next: null },
    ]);
    expect(m.rows).toEqual([{ ...row('s', 5, 'W1'), origin: 'local' }]);
  });

  it('between remote duplicates the byte-smaller origin wins; same id in another workspace stays', () => {
    const m = mergeSessionPages([
      { origin: 'HB', rows: [row('s', 5, 'W1'), row('t', 4, 'W1')], next: null },
      { origin: 'HA', rows: [row('s', 5, 'W1'), row('t', 4, 'W2')], next: null },
    ]);
    expect(m.rows.map((r) => `${r.origin}:${r.workspaceId}:${r.id}`)).toEqual(['HA:W1:s', 'HA:W2:t', 'HB:W1:t']);
  });

  it('a row above every horizon is final; NULL lastActiveAt sorts as 0', () => {
    const m = mergeSessionPages([
      { origin: 'local', rows: [row('l1', 9), row('l2', null)], next: null },
      { origin: 'H', rows: [row('h1', 7)], next: { lastActiveAt: 7, id: 'h1' } },
    ]);
    expect(m.rows.map((r) => r.id)).toEqual(['l1', 'h1', 'l2']);
    expect(m.more).toEqual([{ origin: 'H', after: { lastActiveAt: 7, id: 'h1' } }]);
  });

  it('replaceSessionPage swaps one source and keeps the others', () => {
    const m = mergeSessionPages([
      { origin: 'local', rows: [row('l1', 9)], next: null },
      { origin: 'H', rows: [row('h1', 7), row('h2', 6)], next: { lastActiveAt: 6, id: 'h2' } },
    ]);
    const r = replaceSessionPage(m, { origin: 'H', rows: [row('h3', 10)], next: null });
    expect(r.rows.map((x) => `${x.origin}:${x.id}`)).toEqual(['H:h3', 'local:l1']);
    expect(r.more).toEqual([]);
  });

  it('appendSessionPage keeps a source cursor whose rows were all deduplicated away', () => {
    const m = mergeSessionPages([
      { origin: 'local', rows: [row('s', 5)], next: null },
      { origin: 'H', rows: [row('s', 5)], next: { lastActiveAt: 5, id: 's' } },
    ]);
    expect(m.more).toEqual([{ origin: 'H', after: { lastActiveAt: 5, id: 's' } }]);
    const n = appendSessionPage(m, { origin: 'H', rows: [row('h', 1)], next: null });
    expect(n.rows.map((x) => `${x.origin}:${x.id}`)).toEqual(['local:s', 'H:h']);
    expect(n.more).toEqual([]);
  });
});

describe('compareBytes', () => {
  it('orders by UTF-8 bytes, as COLLATE "C" and SQLite do', () => {
    expect(compareBytes('￿', '\u{10000}')).toBeLessThan(0);
    expect(compareBytes('a', 'ab')).toBeLessThan(0);
    expect(compareBytes('B', 'a')).toBeLessThan(0);
    expect(compareBytes('x', 'x')).toBe(0);
  });
});
