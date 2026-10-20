import { describe, it, expect } from 'vitest';
import { diffLines, compact } from './lineDiff';

describe('diffLines', () => {
  it('marks added, removed and unchanged lines', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { type: 'same', text: 'a' }, { type: 'del', text: 'b' }, { type: 'add', text: 'B' }, { type: 'same', text: 'c' }, { type: 'add', text: 'd' }
    ]);
    expect(diffLines('', 'x')).toEqual([{ type: 'del', text: '' }, { type: 'add', text: 'x' }]);
  });
  it('compacts long unchanged runs', () => {
    const before = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l5', 'L5');
    const c = compact(diffLines(before, after), 1);
    expect(c.map((l) => ('text' in l ? `${l.type}:${l.text}` : 'gap'))).toEqual(['gap', 'same:l4', 'del:l5', 'add:L5', 'same:l6', 'gap']);
  });
});
