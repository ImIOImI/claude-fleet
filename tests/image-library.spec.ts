// Image library: free-text filter inside the workspace-create modal.

import { test, expect } from '@playwright/test';
import { launch, mockMainIpc } from './_helpers.js';

test('Image picker: free-text filter matches across ref and label values', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      imageLibrary: [
        {
          ref: 'ghcr.io/imioimi/claude-fleet/runner:latest',
          labels: { 'com.claude-fleet.kind': 'runner', language: 'node' }
        },
        {
          ref: 'docker.io/library/python:3.12-slim',
          labels: { language: 'python', purpose: 'data-science' }
        },
        {
          ref: 'docker.io/library/golang:1.22',
          labels: { language: 'go', purpose: 'backend' }
        }
      ]
    });

    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await expect(window.getByRole('tab', { name: 'New' })).toBeVisible();

    // All three images visible at first (no filter beyond whatever defaulted
    // into the input — make sure we clear it for a clean assertion).
    const imageInput = window.getByLabel('Image reference');
    await imageInput.fill('');
    await expect(window.locator('.image-row', { hasText: 'runner:latest' })).toBeVisible();
    await expect(window.locator('.image-row', { hasText: 'python:3.12-slim' })).toBeVisible();
    await expect(window.locator('.image-row', { hasText: 'golang:1.22' })).toBeVisible();

    // Filter by a label value — only the python image should remain.
    await imageInput.fill('data-science');
    await expect(window.locator('.image-row', { hasText: 'python:3.12-slim' })).toBeVisible();
    await expect(window.locator('.image-row', { hasText: 'runner:latest' })).toBeHidden();
    await expect(window.locator('.image-row', { hasText: 'golang:1.22' })).toBeHidden();

    // Click the surviving row — it should fill the image input.
    await window.locator('.image-row', { hasText: 'python:3.12-slim' }).click();
    await expect(imageInput).toHaveValue('docker.io/library/python:3.12-slim');
  } finally {
    await app.close();
  }
});
