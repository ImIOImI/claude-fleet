// Committee pause/unpause control plane (#119), mock backend. Drives the
// committee:pause / committee:unpause IPC (the channel the future console uses,
// and the same effect the manager's MCP tools reach) and asserts the
// authorization gate: a granted manager flips a reachable expert paused ⇄
// running, while an ungranted caller is refused.

import { test, expect, type Page } from '@playwright/test';
import { launch } from './_helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function createWorkspace(window: Page, name: string): Promise<void> {
  await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
  await window.getByLabel('Workspace name').fill(name);
  await window.getByRole('button', { name: 'Create & start' }).click();
  await expect(window.getByRole('tab', { name: 'New' })).toBeHidden();
}

async function openChipMenu(window: Page, name: string) {
  await window.locator('.ws-chip-group', { hasText: name }).locator('.ws-chip-menu-trigger').click();
  return window.locator('.ws-chip-menu');
}

/** Current state of a workspace by id, read live from the IPC list. */
function stateOf(window: Page, id: string): Promise<string | undefined> {
  return window.evaluate(async (wid) => {
    const list = (await (window as any).api.workspace.list()) as Array<{ id: string; state: string }>;
    return list.find((w) => w.id === wid)?.state;
  }, id);
}

test('Committee: granted manager pauses/unpauses a reachable expert; ungranted is refused (#119)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await createWorkspace(window, 'expert-p');
    await createWorkspace(window, 'mgr-p');

    // expert-p opts in.
    const menu = await openChipMenu(window, 'expert-p');
    await menu.getByRole('menuitem', { name: 'Edit…' }).click();
    await window.getByText('Committee access').click();
    await window.getByLabel('Reachable by managers').check();
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(window.locator('.modal-tab', { hasText: 'Edit expert-p' })).toBeHidden();

    // mgr-p is granted `pause` over expert-p via the matrix.
    await window.locator('.ws-chip', { hasText: 'mgr-p' }).click();
    await window.getByLabel('pause expert-p').check();
    await expect(
      window.locator('.ws-chip-group', { hasText: 'mgr-p' }).locator('.committee-glyph.mgr')
    ).toBeVisible({ timeout: 5_000 });

    // Resolve workspace ids from the live list.
    const ids = await window.evaluate(async () => {
      const list = (await (window as any).api.workspace.list()) as Array<{ id: string; name: string }>;
      return Object.fromEntries(list.map((w) => [w.name, w.id])) as Record<string, string>;
    });

    // Granted pause → expert flips to paused.
    const res = await window.evaluate(
      ([c, t]) => (window as any).api.committee.pause(c, t),
      [ids['mgr-p'], ids['expert-p']]
    );
    expect(res).toMatchObject({ id: ids['expert-p'], paused: true });
    await expect.poll(() => stateOf(window, ids['expert-p'])).toBe('paused');

    // Unpause → back to running.
    await window.evaluate(
      ([c, t]) => (window as any).api.committee.unpause(c, t),
      [ids['mgr-p'], ids['expert-p']]
    );
    await expect.poll(() => stateOf(window, ids['expert-p'])).toBe('running');

    // Ungranted caller (expert acting on the manager) is refused by assertControl.
    const denied = await window.evaluate(
      async ([c, t]) => {
        try {
          await (window as any).api.committee.pause(c, t);
          return 'NOT-REFUSED';
        } catch (e) {
          return String(e);
        }
      },
      [ids['expert-p'], ids['mgr-p']]
    );
    expect(denied).toContain('control denied');
  } finally {
    await app.close();
  }
});
