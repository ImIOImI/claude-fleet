import { test, expect } from '@playwright/test';
import { launch, callTestIpc, activePane } from './_helpers';

const WS = '01MOCKALPHA000000000000000'; // seeded mock workspace (src/main/mock.ts)

test('serving ports render in the rail; kill uses a two-step confirm', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    // Drive a Serving snapshot from main (no broker in mock mode).
    await callTestIpc(app, '__test:setServingPorts', [
      WS,
      [
        { port: 3000, pid: 42, cmdline: 'node vite dev', sessionId: null, firstSeenAt: Date.now() - 60_000 },
        { port: 8765, pid: null, cmdline: null, sessionId: null, firstSeenAt: Date.now() }
      ]
    ]);

    // Select the mock workspace so the workspace-scope rail shows it.
    // Selector mirrors mock-mode.spec.ts line 22: `.ws-chip` with hasText 'mock-alpha'.
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();

    // The Serving section should appear in the obs rail.
    const section = window.locator('.obs-section', { hasText: 'Serving' });
    await expect(section).toBeVisible();
    const rows = section.locator('.obs-port-row');
    await expect(rows).toHaveCount(2);

    // First row: port 3000 with cmdline and uptime.
    await expect(rows.first()).toContainText(':3000');
    await expect(rows.first()).toContainText('vite dev');
    await expect(rows.first()).toContainText('up 1m');

    // pid:null row (old broker) still gets a kill button — the failure is
    // surfaced at kill time via toast, not by hiding the affordance.
    await expect(rows.nth(1).locator('.obs-port-btn.kill')).toHaveCount(1);

    // Kill is two-step: clicking ✕ shows the confirm chip, no kill yet.
    // Playwright's click() auto-hovers, so no explicit hover needed.
    await rows.first().locator('.obs-port-btn.kill').click();
    await expect(rows.first().locator('.obs-port-kill-confirm')).toBeVisible();

    // An empty snapshot clears the section entirely.
    await callTestIpc(app, '__test:setServingPorts', [WS, []]);
    await expect(section).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('session chip names the owning tab and click focuses it', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    // Select the mock workspace. In mock+E2E mode the terminal pane auto-creates
    // a "main" tab and persists it to sessions.json on mount — same as the
    // multi-session.spec.ts tests. Click the chip first so the tab strip renders.
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();

    // Wait for the first session tab to appear (auto-created "main").
    const strip = activePane(window).locator('.session-tab-strip');
    await activePane(window).locator('.session-tab').first().waitFor();

    // Read the real tab id from sessions.json (the sessions:read IPC handler
    // in mock mode uses the same file-backed readInventory as production).
    const { id: tabId, name: tabName } = await window.evaluate(async (ws) => {
      const inv = await window.api.sessions.read(ws);
      return { id: inv.sessions[0].id, name: inv.sessions[0].name };
    }, WS);

    await callTestIpc(app, '__test:setServingPorts', [
      WS,
      [
        { port: 3000, pid: 42, cmdline: 'node vite dev', sessionId: tabId, firstSeenAt: Date.now() },
        { port: 8765, pid: 43, cmdline: 'python3 -m http.server', sessionId: null, firstSeenAt: Date.now() }
      ]
    ]);

    const section = window.locator('.obs-section', { hasText: 'Serving' });
    const rows = section.locator('.obs-port-row');
    // Attributed row: chip shows the tab name.
    await expect(rows.first().locator('.obs-port-chip')).toContainText(tabName);
    // Unattributed row: no chip.
    await expect(rows.nth(1).locator('.obs-port-chip')).toHaveCount(0);

    // Click focuses the owning tab (activateRequest path).
    await rows.first().locator('.obs-port-chip').click();
    await expect(activePane(window).locator('.session-tab.active')).toContainText(tabName);
  } finally {
    await app.close();
  }
});
