// Regression e2e for #330: narrowing the window must not corrupt terminal
// scrollback. xterm reflows scrollback on width change; Claude's TUI paints
// absolutely-positioned full-width rows (not genuinely wrapped text), so a
// re-wrap splits them — orphaned tails ("Re", "Th", "So.") land at column 0
// of their own lines and persist until they scroll away. Ctrl+L only repaints
// the screen, never scrollback, which is why scrolling up is the
// discriminating action.
//
// The mock shell's `wide <n>` prints n rows exactly terminal-width wide, the
// same shape Ink leaves behind. Every payload row starts with `row-`, is
// filled with `x`, and ends with `####` — so after a resize, any rendered
// line starting with a fill/tail character is a reflow fragment.
//
// The buffer-level twin of this test (unit, runs without a display) is
// src/renderer/src/components/terminalOptions.test.ts; this one proves the
// no-reflow option actually reaches the app's Terminal instance.

import { test, expect } from '@playwright/test';
import { launch, activePane } from './_helpers.js';

test('scrollback survives a window narrow without reflow fragments (#330)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const term = activePane(window).locator('.terminal-host');
    await expect(term).toBeVisible();
    await term.click();

    // Enough rows that a good chunk lands in scrollback at any window size.
    await window.keyboard.type('wide 120');
    await window.keyboard.press('Enter');
    await expect(activePane(window).locator('.xterm-rows')).toContainText('row-119', {
      timeout: 10_000
    });

    // Narrow the OS window ~4 columns. The pane refits, xterm resizes, and —
    // with reflow active — every full-width scrollback row splits in two.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const b = win.getBounds();
      win.setBounds({ ...b, width: b.width - 30 });
    });
    // The refit path is rAF/debounce-driven; give it a beat, then scroll deep
    // into scrollback — the corruption lives there, the live screen region is
    // always repainted clean (that's what made #268/#328 look plausible).
    await window.waitForTimeout(1_000);
    await term.hover();
    for (let i = 0; i < 15; i++) {
      await window.mouse.wheel(0, -1200);
      await window.waitForTimeout(50);
    }

    const rows = await activePane(window)
      .locator('.xterm-rows > div')
      .allInnerTexts();
    const nonEmpty = rows.map((r) => r.trim()).filter((r) => r.length > 0);

    // Positive control: we are actually looking at payload scrollback, not a
    // blank screen or the prompt area.
    expect(nonEmpty.some((r) => r.startsWith('row-'))).toBe(true);

    // The regression: no rendered line may start with a fragment of another
    // row's fill (`x…`) or tail (`#…`). With reflow enabled this fails with
    // dozens of `xxx####`-style orphan lines.
    const fragments = nonEmpty.filter((r) => /^[x#]/.test(r));
    expect(fragments).toEqual([]);
  } finally {
    await app.close();
  }
});
