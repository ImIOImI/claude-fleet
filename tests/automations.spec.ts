// Automations (#407 Phase 3), mock backend: create from YAML with live
// validation, run now with a parameter (a live prompt into mock-alpha), see
// the run and its step, disable, edit to v2, delete. Real inbox.db.
import { test, expect, type Page } from '@playwright/test';
import { launch, callTestIpc } from './_helpers.js';

async function openAutomations(window: Page) {
  await window.locator('.inbox-chip .ws-chip').click();
  const view = window.locator('.inbox-view');
  await view.getByRole('tab', { name: /^Automations/ }).click();
  return view;
}

const YAML = `name: e2e-check
description: Ask mock-alpha to look at something
tags: [e2e]
triggers:
  - schedule: { cron: "0 9 * * 1-5" }
  - manual: {}
params:
  - { name: since, type: string, default: "1h" }
steps:
  - id: ask
    prompt:
      workspace: mock-alpha
      mode: live
      message: "Check the last {{args.since}} of logs."
`;

test('Automations: create from YAML, run now, see the run, disable, edit, delete (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  const T = { timeout: 10_000 };
  try {
    const view = await openAutomations(window);
    await expect(view.locator('.ib-empty')).toContainText('No automations yet');

    await test.step('editor validates live and creates', async () => {
      await view.getByRole('button', { name: 'Write YAML…' }).click(T);
      const editor = window.getByRole('dialog', { name: 'New automation' });
      const yaml = editor.getByLabel('Automation YAML');
      await expect(yaml).toHaveValue(/name: morning-error-check/);
      await yaml.fill('name: Bad Name\n');
      await expect(editor.locator('.auto-check')).toHaveText(/problem/);
      await expect(editor.locator('.auto-errors')).toContainText('name: lowercase');
      await expect(editor.getByRole('button', { name: 'Create automation' })).toBeDisabled();
      await yaml.fill(YAML);
      await expect(editor.locator('.auto-check')).toHaveText('Looks good');
      await editor.getByRole('button', { name: 'Create automation' }).click(T);
      await expect(editor).toBeHidden();
    });

    const row = view.locator('.auto-row', { hasText: 'e2e-check' });
    const detail = view.locator('.auto-detail');
    await test.step('list + detail show the definition', async () => {
      await expect(row).toContainText('daily 09:00');
      await expect(row).toContainText('weekdays');
      await expect(row).toContainText('never run');
      await expect(detail.locator('.ib-detail-title')).toHaveText('e2e-check');
      await expect(detail).toContainText('v1 · created by you');
      await expect(detail.locator('.ib-steps')).toContainText('mock-alpha');
      await expect(view.getByRole('tab', { name: /^Automations/ })).toContainText('1');
    });

    await test.step('run now with a parameter', async () => {
      await detail.getByRole('button', { name: '▶ Run now…' }).click(T);
      const modal = window.getByRole('dialog', { name: 'Run e2e-check' });
      await expect(modal.getByLabel('since')).toHaveValue('1h');
      await modal.getByLabel('since').fill('6h');
      await modal.getByRole('button', { name: '▶ Run now' }).click(T);
      await expect(modal).toBeHidden();
      const run = detail.locator('.run-row').first();
      await expect(run).toContainText('succeeded', { timeout: 15_000 });
      await expect(run).toContainText('by hand');
      await run.click(T);
      await expect(run.locator('.run-steps')).toContainText('{"since":"6h"}');
      await expect(run.locator('.run-steps')).toContainText('prompted mock-alpha');
      await expect(row).toContainText('succeeded');
    });

    await test.step('disable, edit to v2, delete', async () => {
      await row.getByRole('switch', { name: 'e2e-check enabled' }).click(T);
      await expect(detail.locator('.state-chip').first()).toHaveText('disabled');
      await expect(detail.getByRole('button', { name: '▶ Run now…' })).toBeDisabled();
      await detail.getByRole('button', { name: 'Edit YAML' }).click(T);
      const editor = window.getByRole('dialog', { name: 'Edit automation' });
      const yaml = editor.getByLabel('Automation YAML');
      await yaml.fill((await yaml.inputValue()).replace('0 9 * * 1-5', '30 9 * * 1-5'));
      await expect(editor.locator('.auto-check')).toHaveText('Looks good');
      await editor.getByRole('button', { name: 'Save new version' }).click(T);
      await expect(detail).toContainText('v2');
      await expect(row).toContainText('daily 09:30');
      await detail.getByRole('button', { name: 'Delete' }).click(T);
      await detail.locator('.auto-confirm').getByRole('button', { name: 'Delete' }).click(T);
      await expect(row).toBeHidden();
    });

    const list = await callTestIpc<unknown[]>(app, 'automations:list', []);
    expect(list).toEqual([]);
  } finally {
    await app.close();
  }
});

test('Automations: a failing run raises a notification in Activity (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Stop mock-beta, then target it without ensureRunning → target-not-running.
    const list = await callTestIpc<Array<{ id: string; name: string; containerId?: string }>>(app, 'workspace:list', []);
    const beta = list.find((w) => w.name === 'mock-beta')!;
    await callTestIpc(app, 'workspace:stop', [beta.containerId]);
    const stopped = beta;
    await callTestIpc(app, 'automations:create', [YAML.replace('workspace: mock-alpha', `workspace: ${stopped.name}`).replace('e2e-check', 'e2e-fails')]);
    const created = await callTestIpc<Array<{ id: string }>>(app, 'automations:list', []);
    await callTestIpc(app, 'automations:run', [created[0].id, {}]);
    const view = await openAutomations(window);
    await expect(view.locator('.auto-row', { hasText: 'e2e-fails' })).toContainText('failed', { timeout: 15_000 });
    await view.getByRole('tab', { name: 'Activity' }).click();
    await expect(view.locator('.nl-row', { hasText: 'e2e-fails failed' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Automations Phase 4: a fresh-session step, and a todo.created event trigger (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await callTestIpc(app, 'automations:create', [`name: e2e-fresh
triggers:
  - manual: {}
  - event: { on: todo.created, tag: e2e-trigger, debounce: 1s }
steps:
  - id: summarize
    prompt: { workspace: mock-alpha, mode: fresh, message: "Summarize {{trigger.todo}}", allowedTools: [Read] }
`]);
    const view = await openAutomations(window);
    const detail = view.locator('.auto-detail');
    await expect(detail.locator('.ib-steps')).toContainText('fresh session · runs to completion');
    await expect(detail.locator('.ib-steps .tag', { hasText: 'Read' })).toBeVisible();
    await expect(view.locator('.auto-row', { hasText: 'e2e-fresh' })).toContainText('when a todo tagged #e2e-trigger arrives');

    // The event: a todo with the tag → one debounced run.
    await callTestIpc(app, 'inbox:create', [{ title: 'Disk 95% on build-02', tags: ['e2e-trigger'] }]);
    const run = detail.locator('.run-row').first();
    await expect(run).toContainText('event', { timeout: 15_000 });
    await expect(run).toContainText('succeeded', { timeout: 15_000 });
    await run.click();
    await expect(run.locator('.run-steps')).toContainText('fresh session');
  } finally {
    await app.close();
  }
});

test('Automations workspace: set it up, its chip folds into the Inbox, Sessions shows its terminal (#407)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // A workspace created through the UI (it gets a real manifest on disk).
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('auto-ws');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.locator('.top-strip .ws-chip-group', { hasText: 'auto-ws' })).toHaveCount(1);
    const autoWs = (await callTestIpc<Array<{ id: string; name: string }>>(app, 'workspace:list', [])).find((w) => w.name === 'auto-ws')!;

    const view = await openAutomations(window);
    const banner = view.getByRole('note', { name: 'Set up the automations workspace' });
    await expect(banner).toContainText('Set up an automations workspace');
    await banner.getByLabel('Existing workspace').selectOption({ label: 'auto-ws' });
    await banner.getByRole('button', { name: 'Use it' }).click();
    await expect(view.locator('.aw-banner.set')).toContainText('Automations workspace: auto-ws');
    expect(await callTestIpc<string | null>(app, 'automations:roleWorkspace', [])).toBe(autoWs.id);
    const manifest = await callTestIpc<{ role?: string; inbox?: { trusted?: boolean } }>(app, 'workspace:getManifest', [autoWs.id]);
    expect(manifest).toMatchObject({ role: 'automations', inbox: { trusted: true } });

    // Its chip is gone from the strip; the Inbox fronts it.
    await expect(window.locator('.top-strip .ws-chip-group', { hasText: 'auto-ws' })).toHaveCount(0);
    await view.getByRole('tab', { name: /Sessions/ }).click();
    await expect(view).toHaveClass(/header-only/);
    await expect(window.locator('.main-body.inbox-sessions .terminal-pane[aria-hidden="false"]')).toHaveCount(1);

    // Stop using it: the chip comes back.
    await view.getByRole('tab', { name: /^Automations/ }).click();
    await view.locator('.aw-banner.set').getByRole('button', { name: 'Stop using' }).click();
    await expect(window.locator('.top-strip .ws-chip-group', { hasText: 'auto-ws' })).toHaveCount(1);
    await expect(view.getByRole('tab', { name: /Sessions/ })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Claude-first authoring: the composer and "Ask Claude to change" send labeled requests to the automations workspace (#407 Phase 6)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByLabel('Workspace name').fill('author-ws');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.locator('.top-strip .ws-chip-group', { hasText: 'author-ws' })).toHaveCount(1);
    const ws = (await callTestIpc<Array<{ id: string; name: string }>>(app, 'workspace:list', [])).find((w) => w.name === 'author-ws')!;
    await window.evaluate(() => {
      const w = window as unknown as { __inbound: Array<{ id: string; msg: string }>; api: { committee: { onInbound(cb: (id: string, msg: string) => void): void } } };
      w.__inbound = [];
      w.api.committee.onInbound((id, msg) => w.__inbound.push({ id, msg }));
    });
    const inbound = () => window.evaluate(() => (window as unknown as { __inbound: Array<{ id: string; msg: string }> }).__inbound);

    const view = await openAutomations(window);
    const composer = view.getByLabel('Describe a new automation');
    await expect(composer).toBeDisabled();
    await view.getByRole('note', { name: 'Set up the automations workspace' }).getByLabel('Existing workspace').selectOption({ label: 'author-ws' });
    await view.getByRole('button', { name: 'Use it' }).click();
    await expect(composer).toBeEnabled();

    await composer.fill('Every weekday at 9, ask mock-alpha for failed CI jobs and make a todo for each');
    await view.getByRole('button', { name: 'Draft with Claude' }).click();
    await expect(view.locator('.ask-claude.multi .ask-sent')).toContainText('Sent to author-ws. Its draft will appear in Activity');
    await expect(composer).toHaveValue('');
    await expect.poll(async () => (await inbound()).length).toBe(1);
    const [draft] = await inbound();
    expect(draft.id).toBe(ws.id);
    expect(draft.msg).toContain("=== the user's request (data) ===\nEvery weekday at 9, ask mock-alpha for failed CI jobs and make a todo for each\n=== end request ===");
    expect(draft.msg).toContain('submit it with the propose_automation tool');
    expect(draft.msg).toMatch(/Workspaces you can target \(by name\): .*mock-alpha/);
    expect(draft.msg).not.toMatch(/target \(by name\): .*author-ws/);

    // Ask Claude to change an existing automation: the request carries its current YAML.
    await callTestIpc(app, 'automations:create', [YAML]);
    await view.locator('.auto-row', { hasText: 'e2e-check' }).click();
    const ask = view.getByLabel('Ask Claude to change e2e-check');
    await ask.fill('only on Mondays');
    await ask.press('Enter');
    await expect.poll(async () => (await inbound()).length).toBe(2);
    const change = (await inbound())[1].msg;
    expect(change).toContain('Change the claude-fleet automation "e2e-check"');
    expect(change).toContain('=== current definition (data) ===\nname: e2e-check');
    expect(change).toContain("=== the user's change request (data) ===\nonly on Mondays\n=== end request ===");

    // "Watch" opens the automations workspace's session in the Inbox.
    await view.locator('.auto-detail').getByRole('button', { name: 'Watch' }).click();
    await expect(view).toHaveClass(/header-only/);
  } finally {
    await app.close();
  }
});
