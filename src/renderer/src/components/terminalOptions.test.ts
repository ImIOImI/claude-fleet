// Regression test for #330: xterm reflows scrollback when the terminal
// narrows, splitting full-width rows — the tail of each row lands at column 0
// of a new line ("Re", "Th", "So." fragments overlapping the transcript).
// Claude's TUI (Ink) paints absolutely-positioned rows, not genuinely wrapped
// text, so any re-wrap of its output is corruption. Nothing ever repairs
// scrollback, so the junk persists until the lines scroll off.
//
// This runs xterm's real buffer logic (reflow is pure JS, no renderer needed)
// against the app's real options via buildTerminalOptions() — the assertion is
// meaningless against a test-local options object.

import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { buildTerminalOptions } from './terminalOptions';

const COLS = 40;
const ROWS = 10;
const ROW_COUNT = 15; // > ROWS so rows land in scrollback

/** Emit ROW_COUNT distinct rows, each exactly COLS wide (like Ink's padded
 *  status/text rows), each carrying a start marker and a distinctive tail. */
function fullWidthRows(): string {
  let data = '';
  for (let i = 0; i < ROW_COUNT; i++) {
    const head = `row-${String(i).padStart(2, '0')} `.padEnd(COLS - 5, 'x');
    data += `${head}TAIL${i % 10}\r\n`;
  }
  return data;
}

function bufferRows(term: Terminal): string[] {
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true);
    if (line) rows.push(line);
  }
  return rows;
}

describe('terminal scrollback survives resize without reflow corruption (#330)', () => {
  it('narrowing does not split full-width rows into fragment lines', async () => {
    const term = new Terminal({ ...buildTerminalOptions(), cols: COLS, rows: ROWS });
    await new Promise<void>((resolve) => term.write(fullWidthRows(), resolve));

    term.resize(COLS - 2, ROWS); // the pane losing a couple of columns

    const rows = bufferRows(term);
    // Every non-empty row must still be one of the rows we wrote. With reflow
    // active each row splits into a 38-char head plus an orphaned "L0" tail
    // row — exactly the stray fragments reported on top of real transcripts.
    const fragments = rows.filter((r) => !r.startsWith('row-'));
    expect(fragments).toEqual([]);
    expect(rows).toHaveLength(ROW_COUNT);
  });

  it('a narrow→widen round trip leaves every row intact', async () => {
    const term = new Terminal({ ...buildTerminalOptions(), cols: COLS, rows: ROWS });
    await new Promise<void>((resolve) => term.write(fullWidthRows(), resolve));

    term.resize(COLS - 2, ROWS);
    term.resize(COLS + 5, ROWS);

    const rows = bufferRows(term);
    const fragments = rows.filter((r) => !r.startsWith('row-'));
    expect(fragments).toEqual([]);
    expect(rows).toHaveLength(ROW_COUNT);
  });

  it('genuinely wrapped long lines still copy as one logical line', async () => {
    // Guard for the issue's caveat 1: disabling reflow must not break the
    // isWrapped chain that selection/copy uses to join a wrapped line. A
    // 2×COLS line written continuously wraps once; its continuation row must
    // stay marked wrapped so a copy yields one logical line.
    const term = new Terminal({ ...buildTerminalOptions(), cols: COLS, rows: ROWS });
    await new Promise<void>((resolve) => term.write('A'.repeat(COLS * 2), resolve));

    expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);
  });
});
