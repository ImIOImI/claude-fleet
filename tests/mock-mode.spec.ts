// Mock-mode (`CLAUDE_FLEET_MOCK=1`) basics: seeded workspaces appear
// in the chip strip, selection mounts the terminal pane, and a tiny
// `oauth`-command sanity check that the mock shell stays alive.

import { test, expect } from '@playwright/test';
import { launch, activePane } from './_helpers.js';

test('Mock mode: seeded workspaces appear and MOCK MODE chip is visible', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await expect(window.getByText('MOCK MODE')).toBeVisible();
    await expect(window.locator('.ws-chip .name', { hasText: 'mock-alpha' })).toBeVisible();
    await expect(window.locator('.ws-chip .name', { hasText: 'mock-beta' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Mock mode: selecting a workspace mounts the terminal pane', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    await expect(window.locator('.ws-chip-group.active', { hasText: 'mock-alpha' })).toBeVisible();
    await expect(activePane(window).locator('.terminal-host')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Mock mode: oauth command runs without crashing the terminal', async () => {
  // Canvas rendering hides URL text from Playwright; this test only proves
  // the command path stays alive end-to-end. The clickable-link behavior must
  // be verified manually by running `CLAUDE_FLEET_MOCK=1 npm run dev`,
  // typing `oauth`, and clicking the wrapped URL.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const term = activePane(window).locator('.terminal-host');
    await expect(term).toBeVisible();
    await term.click();
    await window.keyboard.type('oauth');
    await window.keyboard.press('Enter');
    await window.waitForTimeout(500);
    await expect(term).toBeVisible();
  } finally {
    await app.close();
  }
});
