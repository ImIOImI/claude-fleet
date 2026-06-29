import { test, expect } from '@playwright/test';
import { launch, callTestIpc } from './_helpers';

test('detected dev-server port surfaces a preview toast that calls ports:open', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    // Capture the ports:open round-trip from the renderer side by wrapping the
    // preload method (it returns the mock stub host port, 65000, in mock mode).
    await window.evaluate(() => {
      const w = window as unknown as { __openedHostPort?: number; api: typeof window.api };
      w.__openedHostPort = undefined;
      const orig = w.api.ports.open;
      w.api.ports.open = async (ws: string, port: number) => {
        const res = await orig(ws, port);
        w.__openedHostPort = res.hostPort;
        return res;
      };
    });

    // Drive a detection event from main via the test-only handler (no real
    // broker exists in mock mode). '01MOCKALPHA000000000000000' is a seeded
    // mock workspace (src/main/mock.ts).
    await callTestIpc(app, '__test:emitDetectedPort', ['01MOCKALPHA000000000000000', 3000]);

    // Toast appears with the Open preview action.
    const toast = window.locator('.toast-stack', { hasText: 'port 3000' });
    await expect(toast).toBeVisible();
    const openBtn = toast.locator('button.toast-action', { hasText: 'Open preview' });
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    // ports:open returned the mock stub host port.
    await expect
      .poll(() => window.evaluate(() => (window as unknown as { __openedHostPort?: number }).__openedHostPort))
      .toBe(65000);
  } finally {
    await app.close();
  }
});
