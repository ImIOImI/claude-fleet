import { test, expect } from '@playwright/test';
import { launch, callTestIpc } from './_helpers';

const WS = '01MOCKALPHA000000000000000'; // seeded mock workspace (src/main/mock.ts)

test('a declared port surfaces a labeled preview toast; ports:open returns a host port', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    await callTestIpc(app, '__test:emitDetectedPort', [
      { workspaceId: WS, port: 3000, label: 'Vite dev server', reason: null, cmdline: null, declared: true }
    ]);
    const toast = window.locator('.toast-stack', { hasText: 'Vite dev server' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(':3000');
    const openBtn = toast.locator('button.toast-action', { hasText: 'Open preview' });
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    // Call the bridged function; reassigning it does not work through contextBridge (tests/_helpers.ts).
    const res = await window.evaluate(() => window.api.ports.open('01MOCKALPHA000000000000000', 3000));
    expect(res.hostPort).toBe(65000);
  } finally {
    await app.close();
  }
});

test('an undeclared serving port stays rail-only until an agent declares it', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1', CLAUDE_FLEET_E2E: '1' });
  try {
    await callTestIpc(app, '__test:setServingPorts', [
      WS,
      [{ port: 5173, pid: 1, cmdline: 'node vite', sessionId: null, firstSeenAt: Date.now() }]
    ]);
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const row = window.locator('.obs-port-row', { hasText: ':5173' });
    await expect(row).toBeVisible();
    await expect(window.locator('.toast-stack', { hasText: '5173' })).toHaveCount(0);

    await callTestIpc(app, '__test:declarePort', [WS, 5173, 'Docs preview']);
    await expect(window.locator('.toast-stack', { hasText: 'Docs preview' })).toBeVisible();
    await expect(row).toContainText('Docs preview');
  } finally {
    await app.close();
  }
});
