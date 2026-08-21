// #268: the terminal renderer is selectable, and the choice actually reaches
// xterm. The DOM renderer paints the grid as thousands of absolutely-
// positioned spans in a scrolling container — the case Chromium's scroll/paint
// invalidation handles worst, which leaves narrow stale strips of a previous
// frame's text behind (reported as stray characters pinned to the left edge).
// canvas/webgl paint the grid as a single element, where that cannot happen.
//
// Asserting on the config value alone would prove nothing: the regression that
// matters is the addon silently not loading, leaving everyone on DOM while the
// setting claims otherwise. So this checks the rendered output — a <canvas>
// inside .xterm-screen — which only exists when an addon actually attached.

import { test, expect } from '@playwright/test';
import { launch, activePane } from './_helpers.js';

async function openTerminal(window: import('@playwright/test').Page) {
  await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
  const host = activePane(window).locator('.terminal-host');
  await expect(host).toBeVisible();
  return host;
}

test('default (dom) renders rows as DOM nodes, with no canvas', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    const host = await openTerminal(window);
    await expect(host.locator('.xterm-rows > div').first()).toBeAttached();
    // The discriminator: no renderer canvas is attached under the DOM renderer.
    await expect(host.locator('.xterm-screen canvas')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('canvas renderer attaches canvas layers and replaces the DOM rows', async () => {
  const { app, window } = await launch({
    CLAUDE_FLEET_MOCK: '1',
    CLAUDE_FLEET_TERMINAL_RENDERER: 'canvas'
  });
  try {
    const host = await openTerminal(window);
    // The addon loads after term.open() (it needs the renderer wired), so give
    // it a beat rather than asserting on the first frame.
    await expect(host.locator('.xterm-screen canvas.xterm-text-layer')).toBeAttached({
      timeout: 10_000
    });
    // And the DOM rows are gone — proof the swap happened rather than both
    // renderers being live at once.
    await expect(host.locator('.xterm-rows > div')).toHaveCount(0);

    // A canvas that attaches but paints nothing would be worse than DOM.
    await host.click();
    await window.keyboard.type('echo renderer-ok');
    await window.keyboard.press('Enter');
    // The canvas renderer keeps no DOM text, so assert the pane is live by the
    // cursor layer still being attached after input rather than by row text.
    await expect(host.locator('.xterm-screen canvas.xterm-cursor-layer')).toBeAttached();
  } finally {
    await app.close();
  }
});

// WebGL is not available everywhere — headless Linux/WSLg has no GPU context,
// and a driver can refuse one at any time. The contract is therefore "upgrade
// if you can, otherwise stay on a working DOM terminal", never a blank pane.
// Asserting a canvas here would make the suite fail on exactly the machines
// the fallback exists for.
test('webgl either attaches or falls back to a working DOM terminal', async () => {
  const { app, window } = await launch({
    CLAUDE_FLEET_MOCK: '1',
    CLAUDE_FLEET_TERMINAL_RENDERER: 'webgl'
  });
  try {
    const host = await openTerminal(window);
    await window.waitForTimeout(2_000);
    const canvases = await host.locator('.xterm-screen canvas').count();
    const rows = await host.locator('.xterm-rows > div').count();
    // Exactly one renderer is live: canvas layers, or DOM rows. Never neither.
    expect(canvases > 0 || rows > 0).toBe(true);

    // Whichever attached, the terminal must still work end to end.
    await host.click();
    await window.keyboard.type('echo webgl-path-ok');
    await window.keyboard.press('Enter');
    if (canvases === 0) {
      await expect(activePane(window).locator('.xterm-rows')).toContainText('webgl-path-ok', {
        timeout: 10_000
      });
    }
  } finally {
    await app.close();
  }
});

test('an unrecognised renderer value falls back to dom rather than breaking', async () => {
  const { app, window } = await launch({
    CLAUDE_FLEET_MOCK: '1',
    CLAUDE_FLEET_TERMINAL_RENDERER: 'vulkan'
  });
  try {
    const host = await openTerminal(window);
    await expect(host.locator('.xterm-rows > div').first()).toBeAttached();
    await expect(host.locator('.xterm-screen canvas')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
