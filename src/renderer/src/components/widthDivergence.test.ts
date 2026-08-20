// Why a width divergence is a correctness bug and not a cosmetic one (#268).
//
// #330/#331 removed xterm's scrollback REFLOW as a corruption source, and
// that fix holds. This pins the mechanism that survives it: when claude lays
// out at a width the terminal does not have, the damage is done at WRITE
// time, not at resize time. Claude's TUI (Ink) paints absolutely-positioned
// full-width rows; if it believes the terminal is `delta` columns wider than
// xterm actually is, every row overflows and its tail wraps onto the next
// line's first `delta` columns.
//
// That is the reported signature — stray fragments in the leading columns,
// overlapping the transcript — and, critically, it is PERMANENT: the bytes
// are in the buffer, so resizing afterwards cannot repair it and Ctrl+L only
// repaints the live screen. This is what the width-agreement instrumentation
// in main (widthAgreement.ts) and the delivery latch in resizePusher.ts exist
// to catch, since nothing in the stack reported the condition before.

import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { buildTerminalOptions } from './terminalOptions';

const XTERM_COLS = 80;
const ROWS = 12;

function rowsOf(term: Terminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true);
    if (line !== undefined && line.trim()) out.push(line);
  }
  return out;
}

/** Ink-style full-width rows laid out for a terminal `claudeCols` wide. */
function inkRows(claudeCols: number, count: number): string {
  let data = '';
  for (let i = 0; i < count; i++) {
    const head = `row-${String(i).padStart(3, '0')} `;
    data += head.padEnd(claudeCols - 4, '·') + 'TAIL\r\n';
  }
  return data;
}

async function writeAt(claudeCols: number): Promise<Terminal> {
  const term = new Terminal({ ...buildTerminalOptions(), cols: XTERM_COLS, rows: ROWS });
  await new Promise<void>((r) => term.write(inkRows(claudeCols, 8), r));
  return term;
}

describe('pty/xterm width divergence corrupts the transcript (#268)', () => {
  it('is clean when claude and xterm agree', async () => {
    const term = await writeAt(XTERM_COLS);
    expect(rowsOf(term).every((r) => r.startsWith('row-'))).toBe(true);
  });

  it('overflows into the leading columns when claude is wider than xterm', async () => {
    // delta = 2 -> two-character fragments in columns 0-1, the reported shape.
    const term = await writeAt(XTERM_COLS + 2);
    const rows = rowsOf(term);
    const fragments = rows.filter((r) => !r.startsWith('row-'));

    expect(fragments.length).toBeGreaterThan(0);
    // Each fragment is exactly the overflowed tail of the row above it.
    expect(fragments.every((f) => f === 'IL')).toBe(true);
  });

  it('scales with the divergence: delta columns of junk per row', async () => {
    for (const delta of [1, 2, 3]) {
      const term = await writeAt(XTERM_COLS + delta);
      const fragments = rowsOf(term).filter((r) => !r.startsWith('row-'));
      expect(fragments.length).toBeGreaterThan(0);
      expect(new Set(fragments.map((f) => f.length))).toEqual(new Set([delta]));
    }
  });

  it('is permanent — resizing to the width claude used does not repair it', async () => {
    // The discriminating property. Reflow damage (#330) was also permanent,
    // which is why the two were confused; the difference is that this one is
    // already in the buffer before any resize happens.
    const term = await writeAt(XTERM_COLS + 2);
    expect(rowsOf(term).some((r) => !r.startsWith('row-'))).toBe(true);

    term.resize(XTERM_COLS + 2, ROWS);
    expect(rowsOf(term).some((r) => !r.startsWith('row-'))).toBe(true);

    term.resize(XTERM_COLS, ROWS);
    expect(rowsOf(term).some((r) => !r.startsWith('row-'))).toBe(true);
  });
});
