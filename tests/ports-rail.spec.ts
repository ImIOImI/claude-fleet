import { test, expect } from '@playwright/test';
import { launch, callTestIpc } from './_helpers';

const WS = '01MOCKALPHA000000000000000'; // seeded mock workspace (src/main/mock.ts)

test('serving ports render in the rail; kill uses a two-step confirm', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    // Drive a Serving snapshot from main (no broker in mock mode).
    await callTestIpc(app, '__test:setServingPorts', [
      WS,
      [
        { port: 3000, pid: 42, cmdline: 'node vite dev', firstSeenAt: Date.now() - 60_000 },
        { port: 8765, pid: null, cmdline: null, firstSeenAt: Date.now() }
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

    // pid:null row (old broker) has no kill button.
    await expect(rows.nth(1).locator('.obs-port-btn.kill')).toHaveCount(0);

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
