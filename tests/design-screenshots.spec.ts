// tests/design-screenshots.spec.ts
// Regenerates docs/design/workspace-modal.md captures. NOT part of the
// gate: skipped unless CF_SHOOT=1. Run:
//   npm run build && CF_SHOOT=1 ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a \
//     npx playwright test tests/design-screenshots.spec.ts
import { test } from '@playwright/test';
import { launch, mockMainIpc } from './_helpers';

test.skip(!process.env.CF_SHOOT, 'screenshot regen only (CF_SHOOT=1)');

const EP = { id: 'ep1', name: 'ollama-local', modelId: 'qwen3:4b', baseUrl: 'http://host.docker.internal:11434' };
const OUT = 'assets/design/workspace-modal';

test('capture workspace-modal states', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { endpoints: [EP] });
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await window.getByRole('tab', { name: 'New' }).click();
    const modal = window.locator('.modal-tabbed');

    // 02 — empty create form, Model=Claude, OAuth selected, API key locked
    await modal.screenshot({ path: `${OUT}/02-empty-oauth-api-key-option-disabled.png` });

    // 10 — Model combobox open
    await window.getByRole('button', { name: 'Model' }).click();
    await window.locator('[role="listbox"][aria-label="Model options"]').waitFor();
    await modal.screenshot({ path: `${OUT}/10-model-combobox-open.png` });

    // 11 — endpoint selected, Auth morphed to the registry-key note
    await window.getByRole('option', { name: /ollama-local/ }).click();
    await modal.screenshot({ path: `${OUT}/11-endpoint-selected-auth-note.png` });
  } finally {
    await app.close();
  }
});
