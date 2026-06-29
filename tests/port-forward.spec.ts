import { test, expect } from '@playwright/test';
import { launch, callTestIpc } from './_helpers';

test('detected dev-server port surfaces a preview toast; ports:open returns a host port', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    // Drive a detection event from main (no real broker exists in mock mode).
    // '01MOCKALPHA000000000000000' is a seeded mock workspace (src/main/mock.ts).
    await callTestIpc(app, '__test:emitDetectedPort', ['01MOCKALPHA000000000000000', 3000]);

    // The renderer shows a preview toast carrying an Open preview action.
    const toast = window.locator('.toast-stack', { hasText: 'port 3000' });
    await expect(toast).toBeVisible();
    const openBtn = toast.locator('button.toast-action', { hasText: 'Open preview' });
    await expect(openBtn).toBeVisible();
    await openBtn.click(); // exercises the onClick → ports.open wiring

    // The ports:open IPC round-trip returns the mock stub host port. Calling the
    // bridged function (not reassigning it) works through contextBridge — the
    // renderer-side spy pattern does NOT (see tests/_helpers.ts header note).
    const res = await window.evaluate(() =>
      window.api.ports.open('01MOCKALPHA000000000000000', 3000)
    );
    expect(res.hostPort).toBe(65000);
  } finally {
    await app.close();
  }
});
