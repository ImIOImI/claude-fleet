import { describe, expect, it } from 'vitest';
import { lineSplitter } from './mcpLines.js';

function collect(max: number) {
  const lines: string[] = [];
  let oversize = 0;
  const feed = lineSplitter((l) => { lines.push(l); }, () => { oversize++; }, max);
  return { lines, feed, oversize: () => oversize };
}

describe('lineSplitter', () => {
  it('splits lines across chunks', () => {
    const c = collect(100);
    c.feed('{"a":1}\n{"b"');
    c.feed(':2}\n\n{"c":3}');
    c.feed('\n');
    expect(c.lines).toEqual(['{"a":1}', '{"b":2}', '', '{"c":3}']);
    expect(c.oversize()).toBe(0);
  });

  it('drops a line over the cap once and keeps the stream usable', () => {
    const c = collect(10);
    c.feed('x'.repeat(8));
    c.feed('x'.repeat(8));
    c.feed('x'.repeat(50));
    expect(c.oversize()).toBe(1);
    c.feed('tail\nok\n');
    expect(c.oversize()).toBe(1);
    expect(c.lines).toEqual(['ok']);
    c.feed('é'.repeat(6) + '\nnext\n');
    expect(c.oversize()).toBe(2);
    expect(c.lines).toEqual(['ok', 'next']);
  });

  it('stops when onLine returns false', () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => { lines.push(l); return false; }, () => undefined, 100);
    feed('a\nb\n');
    feed('c\n');
    expect(lines).toEqual(['a']);
  });

  it('is linear in a long unterminated line', () => {
    const c = collect(1 << 20);
    const started = Date.now();
    for (let i = 0; i < 2000; i++) c.feed('y'.repeat(1000));
    c.feed('\nz\n');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(c.oversize()).toBe(1);
    expect(c.lines).toEqual(['z']);
  });
});
