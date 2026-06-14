// Regression guard for the workspace context-accent bar at the top of the
// terminal. It's filled with the workspace hue via the `--hue` CSS custom
// property, which every consumer (this bar, the active session-tab underline)
// reads as a full color. A regression once set `--hue` to a bare `Ndeg`
// angle on .main-pane — an invalid color for `background`/`color-mix`, which
// silently blanked the bar. These tests assert `--hue` resolves to a real
// color and the bar fill actually paints.

import { test, expect } from '@playwright/test';
import { launch, activePane } from './_helpers.js';

test('Context bar: --hue on .main-pane is a color, and the accent bar paints', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();

    // --hue must be a real color, not an angle (e.g. "210deg"), or every
    // color consumer scoped under .main-pane silently fails.
    const hue = await window
      .locator('.main-pane')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--hue').trim());
    expect(hue).not.toBe('');
    expect(hue.endsWith('deg')).toBe(false);

    // The bar fill should resolve to a non-transparent background. An invalid
    // `--hue` would leave it transparent (var() fallback doesn't kick in once
    // the property is set, even to an invalid value).
    const fill = activePane(window).locator('.terminal-accent-band-fill');
    await expect(fill).toBeVisible();
    const bg = await fill.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
  } finally {
    await app.close();
  }
});
