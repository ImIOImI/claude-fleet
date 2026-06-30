// Committee post + collect (#120), mock backend. The real broker round-trip
// (sendInput) is docker-only and can't run in this harness, so here we verify
// the authorization + dispatch wiring on both verbs: a granted manager's
// post/collect resolve, an ungranted caller is refused. The collect data path
// (real events, cursored by events.id) is covered in mcp-server.spec.ts.

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

test('Committee: post + collect gated by grant (#120)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await createWorkspace(window, 'expert-c');
    await createWorkspace(window, 'mgr-c');

    // expert-c opts in.
    const menu = await openChipMenu(window, 'expert-c');
    await menu.getByRole('menuitem', { name: 'Edit…' }).click();
    await window.getByText('Committee access').click();
    await window.getByLabel('Reachable by managers').check();
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(window.locator('.modal-tab', { hasText: 'Edit expert-c' })).toBeHidden();

    // mgr-c is granted read + post over expert-c.
    await window.locator('.ws-chip', { hasText: 'mgr-c' }).click();
    await window.getByLabel('read expert-c').check();
    await window.getByLabel('post expert-c').check();
    await expect(
      window.locator('.ws-chip-group', { hasText: 'mgr-c' }).locator('.committee-glyph.mgr')
    ).toBeVisible({ timeout: 5_000 });

    const ids = await window.evaluate(async () => {
      const list = (await (window as any).api.workspace.list()) as Array<{ id: string; name: string }>;
      return Object.fromEntries(list.map((w) => [w.name, w.id])) as Record<string, string>;
    });

    // Select the expert's tab so its (always-mounted) pane is visible, then post.
    await window.locator('.ws-chip', { hasText: 'expert-c' }).click();

    // Granted post resolves (mock acks; real broker round-trip is docker-only).
    const posted = await window.evaluate(
      ([c, t]) => (window as any).api.committee.post(c, t, 'review PR #42 from your lens'),
      [ids['mgr-c'], ids['expert-c']]
    );
    expect(posted).toMatchObject({ id: ids['expert-c'] });

    // The post broadcasts a [committee] inbound toast into the expert's tab (#123).
    // After the toast consolidation (#167) this renders via the shared ToastView
    // as the in-tab `.toast--tab` (eyebrow "committee"); the bespoke
    // `.committee-toast` class is gone (see Toast.tsx / styles.css).
    const toast = window.locator('.terminal-pane:not([aria-hidden="true"]) .toast--tab');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText('committee');
    await expect(toast).toContainText('review PR #42');

    // Granted status resolves (paused/busy computed without the DB; #121).
    const status = await window.evaluate(
      ([c, t]) => (window as any).api.committee.status(c, t),
      [ids['mgr-c'], ids['expert-c']]
    );
    expect(status).toMatchObject({ id: ids['expert-c'], paused: false, busy: false });

    // (Granted collect's data path needs a real DB — covered in mcp-server.spec.ts;
    // mock mode opens no DB. Here we just prove the grant gate on both verbs.)

    // Ungranted caller (expert acting on the manager) is refused on both verbs
    // — assertControl runs before any DB/broker work, so the deny is clean.
    const deniedPost = await window.evaluate(
      async ([c, t]) => {
        try {
          await (window as any).api.committee.post(c, t, 'nope');
          return 'NOT-REFUSED';
        } catch (e) {
          return String(e);
        }
      },
      [ids['expert-c'], ids['mgr-c']]
    );
    expect(deniedPost).toContain('control denied');

    const deniedCollect = await window.evaluate(
      async ([c, t]) => {
        try {
          await (window as any).api.committee.collect(c, t);
          return 'NOT-REFUSED';
        } catch (e) {
          return String(e);
        }
      },
      [ids['expert-c'], ids['mgr-c']]
    );
    expect(deniedCollect).toContain('control denied');

    const deniedStatus = await window.evaluate(
      async ([c, t]) => {
        try {
          await (window as any).api.committee.status(c, t);
          return 'NOT-REFUSED';
        } catch (e) {
          return String(e);
        }
      },
      [ids['expert-c'], ids['mgr-c']]
    );
    expect(deniedStatus).toContain('control denied');
  } finally {
    await app.close();
  }
});
