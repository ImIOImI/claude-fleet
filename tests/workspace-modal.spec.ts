// Tabbed WorkspaceModal — Saved-tab list, Variant-B search, row expansion,
// Resume action. PR-A surface (Phase 2 of the workspace-modal redesign).

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc, getCalls } from './_helpers.js';

const RUNNER = 'ghcr.io/imioimi/claude-fleet/runner:latest';
const SAVED = [
  {
    id: '01TESTHAPPYLLAMA0000000000',
    name: 'happy-llama',
    description: 'API server work',
    labels: ['dev', 'api'],
    state: 'stopped' as const,
    workspaceRoot: '/tmp/happy-llama',
    image: RUNNER
  },
  {
    id: '01TESTCALMOTTER000000000000',
    name: 'calm-otter',
    description: 'Data pipeline',
    labels: ['data'],
    state: 'stopped' as const,
    workspaceRoot: '/tmp/calm-otter',
    image: RUNNER
  },
  {
    id: '01TESTBOLDFOX00000000000000',
    name: 'bold-fox',
    description: 'Frontend work',
    labels: ['dev', 'frontend'],
    state: 'stopped' as const,
    workspaceRoot: '/tmp/bold-fox',
    image: RUNNER
  }
];

test('Saved tab is the default when saved workspaces exist', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: SAVED });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

    const saved = window.getByRole('tab', { name: 'Saved' });
    const fresh = window.getByRole('tab', { name: 'New' });
    await expect(saved).toHaveAttribute('aria-selected', 'true');
    await expect(fresh).toHaveAttribute('aria-selected', 'false');

    // Every saved workspace appears as a row.
    for (const w of SAVED) {
      await expect(window.locator('.saved-row', { hasText: w.name })).toBeVisible();
    }
  } finally {
    await app.close();
  }
});

test('New tab is the default when no saved workspaces exist', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

    await expect(window.getByRole('tab', { name: 'New' })).toHaveAttribute('aria-selected', 'true');
    await expect(window.getByLabel('Workspace name')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Saved tab: text search filters by name and description', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: SAVED });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

    const search = window.getByLabel('Search by name or description');
    await search.fill('pipeline');

    await expect(window.locator('.saved-row', { hasText: 'calm-otter' })).toBeVisible();
    await expect(window.locator('.saved-row', { hasText: 'happy-llama' })).toBeHidden();
    await expect(window.locator('.saved-row', { hasText: 'bold-fox' })).toBeHidden();

    // Clearing the filter restores everything.
    await search.fill('');
    await expect(window.locator('.saved-row', { hasText: 'happy-llama' })).toBeVisible();
    await expect(window.locator('.saved-row', { hasText: 'bold-fox' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Saved tab: labels dropdown filters with OR semantics and surfaces pills', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: SAVED });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

    // Open the Labels dropdown.
    await window.getByRole('button', { name: /Labels/ }).click();
    const dropdown = window.locator('.labels-dropdown');
    await expect(dropdown).toBeVisible();

    // Pick `dev` → matches happy-llama + bold-fox.
    await dropdown.locator('.labels-dropdown-row', { hasText: 'dev' }).click();
    await expect(window.locator('.saved-row', { hasText: 'happy-llama' })).toBeVisible();
    await expect(window.locator('.saved-row', { hasText: 'bold-fox' })).toBeVisible();
    await expect(window.locator('.saved-row', { hasText: 'calm-otter' })).toBeHidden();

    // Add `data` → OR with dev, matches all three again.
    await dropdown.locator('.labels-dropdown-row', { hasText: 'data' }).click();
    await expect(window.locator('.saved-row', { hasText: 'happy-llama' })).toBeVisible();
    await expect(window.locator('.saved-row', { hasText: 'bold-fox' })).toBeVisible();
    await expect(window.locator('.saved-row', { hasText: 'calm-otter' })).toBeVisible();

    // Filter pills appear above the list.
    await expect(window.locator('.filter-pill', { hasText: 'dev' })).toBeVisible();
    await expect(window.locator('.filter-pill', { hasText: 'data' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Saved tab: clicking a row expands inline with Resume action', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: SAVED });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

    const row = window.locator('.saved-row', { hasText: 'happy-llama' });
    // Body starts collapsed.
    await expect(row).not.toHaveClass(/expanded/);

    await row.locator('.saved-row-header').click();
    await expect(row).toHaveClass(/expanded/);

    // Edit form fields appear inside the row.
    await expect(row.getByLabel('Workspace name')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();

    // Cancel collapses the row.
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row).not.toHaveClass(/expanded/);
  } finally {
    await app.close();
  }
});

test('Committee access: accept-from lists managers as checkboxes and saves the selection', async () => {
  const EXPERT = {
    id: '01TESTEXPERT0000000000000E',
    name: 'sec-expert',
    state: 'stopped' as const,
    workspaceRoot: '/tmp/sec-expert',
    image: RUNNER,
    kind: 'container' as const,
    labels: []
  };
  // A manager: another container workspace that holds an outbound grant.
  const MANAGER = {
    id: '01TESTMANAGER000000000000M',
    name: 'lead-manager',
    state: 'stopped' as const,
    workspaceRoot: '/tmp/lead-manager',
    image: RUNNER,
    kind: 'container' as const,
    labels: [],
    control: { canControl: [{ id: EXPERT.id, verbs: ['read' as const] }] }
  };

  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { workspaceList: [EXPERT, MANAGER], isDirectoryReturns: true });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

    const row = window.locator('.saved-row', { hasText: 'sec-expert' });
    await row.locator('.saved-row-header').click();

    // Open "Committee access" and opt in as reachable.
    await row.getByText('Committee access').click();
    await row.getByText('Reachable by managers').click();

    // The manager appears as a checkbox row (not the expert itself).
    const mgrRow = row.locator('.committee-acceptfrom-row', { hasText: 'lead-manager' });
    await expect(mgrRow).toBeVisible();
    await expect(row.locator('.committee-acceptfrom-row', { hasText: 'sec-expert' })).toHaveCount(0);

    await mgrRow.locator('input[type="checkbox"]').check();

    // Resume serializes the form → writeManifest carries the selected id.
    await row.getByRole('button', { name: 'Resume' }).click();

    const calls = await getCalls(app);
    const spec = calls.writeManifest.at(-1) as {
      accessibility?: { reachable?: boolean; acceptFrom?: string[] };
    };
    expect(spec.accessibility?.reachable).toBe(true);
    expect(spec.accessibility?.acceptFrom).toEqual([MANAGER.id]);
  } finally {
    await app.close();
  }
});

test('Saved tab: Resume writes the manifest then starts the container', async () => {
  const { app, window } = await launch({});
  try {
    await mockMainIpc(app, {
      workspaceList: [SAVED[0]],
      isDirectoryReturns: true
    });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();

    const row = window.locator('.saved-row', { hasText: 'happy-llama' });
    await row.locator('.saved-row-header').click();
    await row.getByRole('button', { name: 'Resume' }).click();

    // Modal closed.
    await expect(window.getByRole('tab', { name: 'Saved' })).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.writeManifest).toHaveLength(1);
    const spec = calls.writeManifest[0] as { id: string; name: string };
    expect(spec.id).toBe(SAVED[0].id);
    expect(spec.name).toBe('happy-llama');
    expect(calls.start).toContain(SAVED[0].id);
  } finally {
    await app.close();
  }
});
