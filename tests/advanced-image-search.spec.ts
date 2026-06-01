// Advanced image search modal — opened by the magnifying-glass icon
// next to the Image input in WorkspaceForm. Tests cover the modal's
// open/close, text + tag filtering, the per-row "used by" annotation
// (with warning styling for stopped consumers), and the pick action.

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc } from './_helpers.js';

const IMAGES = [
  {
    ref: 'ghcr.io/imioimi/claude-fleet/runner:latest',
    digest: 'sha256:abcdef1234567890aaaabbbbccccdddd',
    labels: { 'com.claude-fleet.kind': 'runner', language: 'node' }
  },
  {
    ref: 'docker.io/library/python:3.12-slim',
    digest: 'sha256:1111222233334444aaaabbbbccccdddd',
    labels: { language: 'python', purpose: 'data-science' }
  },
  {
    ref: 'docker.io/library/golang:1.22',
    digest: 'sha256:5555666677778888aaaabbbbccccdddd',
    labels: { language: 'go', purpose: 'backend' }
  }
];

async function openSearchModal(window: import('@playwright/test').Page) {
  await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
  // Make sure we're on the New tab (default when no saved workspaces).
  await expect(window.getByRole('tab', { name: 'New' })).toHaveAttribute('aria-selected', 'true');
  await window.getByRole('button', { name: 'Open advanced image search' }).click();
}

test('Advanced image search: trigger opens the modal listing every library entry', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { imageLibrary: IMAGES });
    await openSearchModal(window);

    await expect(window.locator('.modal-tab', { hasText: 'Image library' })).toBeVisible();
    for (const img of IMAGES) {
      await expect(window.locator('.image-search-row', { hasText: img.ref })).toBeVisible();
    }
  } finally {
    await app.close();
  }
});

test('Advanced image search: text input filters across ref and digest', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { imageLibrary: IMAGES });
    await openSearchModal(window);

    const search = window.getByLabel('Search image library');

    // Ref substring.
    await search.fill('python');
    await expect(window.locator('.image-search-row', { hasText: 'python:3.12-slim' })).toBeVisible();
    await expect(window.locator('.image-search-row', { hasText: 'runner:latest' })).toBeHidden();

    // Digest prefix — pick the first 8 hex chars of the golang image.
    await search.fill('55556666');
    await expect(window.locator('.image-search-row', { hasText: 'golang:1.22' })).toBeVisible();
    await expect(window.locator('.image-search-row', { hasText: 'python:3.12-slim' })).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Advanced image search: Tags dropdown filters with OR semantics + pills', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { imageLibrary: IMAGES });
    await openSearchModal(window);

    await window.getByRole('button', { name: /Tags/ }).click();
    const dropdown = window.locator('.labels-dropdown');
    await expect(dropdown).toBeVisible();

    // Pick `latest` → matches runner only.
    await dropdown.locator('.labels-dropdown-row', { hasText: 'latest' }).click();
    await expect(window.locator('.image-search-row', { hasText: 'runner:latest' })).toBeVisible();
    await expect(window.locator('.image-search-row', { hasText: 'python:3.12-slim' })).toBeHidden();
    await expect(window.locator('.image-search-row', { hasText: 'golang:1.22' })).toBeHidden();

    // Add `3.12-slim` → OR with latest, matches both.
    await dropdown.locator('.labels-dropdown-row', { hasText: '3.12-slim' }).click();
    await expect(window.locator('.image-search-row', { hasText: 'runner:latest' })).toBeVisible();
    await expect(window.locator('.image-search-row', { hasText: 'python:3.12-slim' })).toBeVisible();

    // Filter pills appear.
    await expect(window.locator('.filter-pill', { hasText: 'latest' })).toBeVisible();
    await expect(window.locator('.filter-pill', { hasText: '3.12-slim' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Advanced image search: clicking a row picks the image and closes the modal', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { imageLibrary: IMAGES });
    await openSearchModal(window);

    await window.locator('.image-search-row', { hasText: 'python:3.12-slim' }).locator('button').click();

    // Modal closed.
    await expect(window.locator('.modal-tab', { hasText: 'Image library' })).toBeHidden();

    // Image input now reflects the picked ref.
    await expect(window.getByLabel('Image reference')).toHaveValue(
      'docker.io/library/python:3.12-slim'
    );
  } finally {
    await app.close();
  }
});

test('Advanced image search: each row surfaces workspaces using the image, stopped ones flagged', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      imageLibrary: IMAGES,
      // Two workspaces using the python image — one running, one stopped.
      workspaceList: [
        {
          id: '01ALPHARUNNING0000000000WS',
          name: 'alpha-running',
          state: 'running',
          workspaceRoot: '/tmp/alpha',
          image: 'docker.io/library/python:3.12-slim'
        },
        {
          id: '01BETAPAUSED000000000000WS',
          name: 'beta-stopped',
          state: 'stopped',
          workspaceRoot: '/tmp/beta',
          image: 'docker.io/library/python:3.12-slim'
        }
      ]
    });
    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    // Workspaces exist → Saved tab is default; switch to New first.
    await window.getByRole('tab', { name: 'New' }).click();
    await window.getByRole('button', { name: 'Open advanced image search' }).click();

    const pythonRow = window.locator('.image-search-row', { hasText: 'python:3.12-slim' });
    await expect(pythonRow.getByText('alpha-running')).toBeVisible();
    await expect(pythonRow.getByText('beta-stopped')).toBeVisible();

    // The stopped consumer has the warning styling.
    const beta = pythonRow.locator('.image-search-user', { hasText: 'beta-stopped' });
    await expect(beta).toHaveClass(/stopped/);
  } finally {
    await app.close();
  }
});
