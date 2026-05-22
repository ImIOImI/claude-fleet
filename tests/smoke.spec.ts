import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

async function launch(
  envOverrides: Record<string, string> = {}
): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [REPO_ROOT],
    cwd: REPO_ROOT,
    env: { ...process.env, ...envOverrides } as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

test('preload exposes window.api with all expected surfaces', async () => {
  const { app, window } = await launch();
  try {
    const types = await window.evaluate(() => ({
      api: typeof (window as unknown as { api?: unknown }).api,
      docker: typeof (window as unknown as { api?: { docker?: unknown } }).api?.docker,
      vault: typeof (window as unknown as { api?: { vault?: unknown } }).api?.vault,
      pty: typeof (window as unknown as { api?: { pty?: unknown } }).api?.pty,
      fs: typeof (window as unknown as { api?: { fs?: unknown } }).api?.fs,
      dialog: typeof (window as unknown as { api?: { dialog?: unknown } }).api?.dialog
    }));
    expect(types).toEqual({
      api: 'object',
      docker: 'object',
      vault: 'object',
      pty: 'object',
      fs: 'object',
      dialog: 'object'
    });
  } finally {
    await app.close();
  }
});

test('+ New container opens the modal', async () => {
  const { app, window } = await launch();
  try {
    await window.getByRole('button', { name: '+ New container' }).click();
    await expect(window.getByRole('heading', { name: 'New container' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Create button surfaces validation errors when fields are empty', async () => {
  const { app, window } = await launch();
  try {
    await window.getByRole('button', { name: '+ New container' }).click();
    await expect(window.getByRole('heading', { name: 'New container' })).toBeVisible();

    // Click Create with no input — should surface an error, not silently no-op
    await window.getByRole('button', { name: 'Create' }).click();
    await expect(window.locator('.error-text')).toContainText(/required|match/);
  } finally {
    await app.close();
  }
});

// The full submit flow with Docker / FS IPC stubbed in the main process.
// `contextBridge.exposeInMainWorld` makes the api object's properties
// effectively immutable from the renderer side, so mocking via
// `window.evaluate` doesn't work. We mock at the IPC-handler level via
// `app.evaluate`, which runs in the main process where ipcMain is mutable.
//
// The actual OAuth handshake (browser → Anthropic → auth code) can't be
// tested in CI — it needs real credentials and an interactive browser.
// What we guarantee here is the foundation: a blank-profile submit
// produces a container with profile label 'oauth' and an empty env, so
// when claude starts in the PTY there's no ANTHROPIC_API_KEY env to win
// precedence over OAuth.

interface MockOpts {
  isDirectoryReturns?: boolean;
}

async function mockMainIpc(app: ElectronApplication, opts: MockOpts = {}): Promise<void> {
  await app.evaluate(({ ipcMain }, opts) => {
    const g = globalThis as unknown as { __calls: Record<string, unknown[]> };
    g.__calls = {
      ensureImage: [],
      create: [],
      list: [],
      isDirectory: [],
      mkdirp: []
    };

    const channels = [
      'docker:ensureImage',
      'docker:create',
      'docker:list',
      'docker:ping',
      'fs:isDirectory',
      'fs:mkdirp'
    ];
    for (const ch of channels) {
      try {
        ipcMain.removeHandler(ch);
      } catch {
        /* ignore */
      }
    }

    ipcMain.handle('docker:ping', () => true);
    ipcMain.handle('docker:list', () => {
      g.__calls.list.push(true);
      return [];
    });
    ipcMain.handle('docker:ensureImage', async () => {
      g.__calls.ensureImage.push(true);
    });
    ipcMain.handle('docker:create', async (_e, spec: Record<string, unknown>) => {
      g.__calls.create.push(spec);
      return { id: 'fake', name: spec.name, state: 'running', status: 'running' };
    });
    ipcMain.handle('fs:isDirectory', async (_e, p: string) => {
      g.__calls.isDirectory.push(p);
      return opts.isDirectoryReturns ?? true;
    });
    ipcMain.handle('fs:mkdirp', async (_e, p: string) => {
      g.__calls.mkdirp.push(p);
    });
  }, opts);
}

async function getCalls(app: ElectronApplication): Promise<Record<string, unknown[]>> {
  return app.evaluate(
    () => (globalThis as unknown as { __calls: Record<string, unknown[]> }).__calls
  );
}

test('Create flow (OAuth mode): empty profile submits with profile=oauth and no API key env', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { isDirectoryReturns: true });

    await window.getByRole('button', { name: '+ New container' }).click();
    await window.getByPlaceholder('my-container').fill('test-oauth-container');
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/fleet-test');
    // Subdir and profile left blank → OAuth mode

    await window.getByRole('button', { name: 'Create' }).click();
    await expect(window.getByRole('heading', { name: 'New container' })).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.ensureImage).toHaveLength(1);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({
      name: 'test-oauth-container',
      workspaceRoot: '/tmp/fleet-test',
      workspaceSubdir: '',
      profile: 'oauth',
      env: {}
    });
  } finally {
    await app.close();
  }
});

test('Create flow: missing workspace prompts to create it and mkdirps before container-create', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { isDirectoryReturns: false });
    // window.confirm is a vanilla window method (not contextBridge-managed),
    // so we can override it from the renderer side directly.
    await window.evaluate(() => {
      const g = window as unknown as { __confirmArgs: string[] };
      g.__confirmArgs = [];
      window.confirm = (msg?: string) => {
        g.__confirmArgs.push(msg ?? '');
        return true;
      };
    });

    await window.getByRole('button', { name: '+ New container' }).click();
    await window.getByPlaceholder('my-container').fill('test-mkdir');
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/does-not-exist-yet');

    await window.getByRole('button', { name: 'Create' }).click();
    await expect(window.getByRole('heading', { name: 'New container' })).toBeHidden();

    const confirmArgs = await window.evaluate(
      () => (window as unknown as { __confirmArgs: string[] }).__confirmArgs
    );
    const calls = await getCalls(app);
    expect(confirmArgs[0]).toContain('/tmp/does-not-exist-yet');
    expect(calls.mkdirp).toEqual(['/tmp/does-not-exist-yet']);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({ workspaceRoot: '/tmp/does-not-exist-yet' });
  } finally {
    await app.close();
  }
});

test('Mock mode: seeded containers appear and MOCK MODE chip is visible', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await expect(window.getByText('MOCK MODE')).toBeVisible();
    // Seeded containers from src/main/mock.ts
    await expect(window.locator('.container-row .name', { hasText: 'mock-alpha' })).toBeVisible();
    await expect(window.locator('.container-row .name', { hasText: 'mock-beta' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Mock mode: selecting a container mounts the terminal pane', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.container-row', { hasText: 'mock-alpha' }).click();
    await expect(window.locator('.container-row.active', { hasText: 'mock-alpha' })).toBeVisible();
    await expect(window.locator('.terminal-host')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Mock mode: Close button stops and removes the selected container', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.container-row', { hasText: 'mock-alpha' }).click();

    await window.getByRole('button', { name: 'Close…' }).click();
    await expect(window.getByRole('heading', { name: 'Close container' })).toBeVisible();

    // Running container should expose both "Stop only" and "Stop & remove"
    await expect(window.getByRole('button', { name: 'Stop only' })).toBeVisible();
    await window.getByRole('button', { name: 'Stop & remove' }).click();

    // Modal closes, container disappears from sidebar, nothing is selected
    await expect(window.getByRole('heading', { name: 'Close container' })).toBeHidden();
    await expect(window.locator('.container-row .name', { hasText: 'mock-alpha' })).toBeHidden();
    await expect(window.locator('.empty', { hasText: 'No container selected' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Mock mode: Close on an exited container shows only Remove', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.container-row', { hasText: 'mock-beta' }).click();
    await window.getByRole('button', { name: 'Close…' }).click();
    await expect(window.getByRole('heading', { name: 'Close container' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Stop only' })).toBeHidden();
    await expect(window.getByRole('button', { name: 'Remove' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Create flow: declining the missing-workspace confirm aborts without mkdirp or create', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, { isDirectoryReturns: false });
    await window.evaluate(() => {
      window.confirm = () => false;
    });

    await window.getByRole('button', { name: '+ New container' }).click();
    await window.getByPlaceholder('my-container').fill('test-decline');
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/declined-path');
    await window.getByRole('button', { name: 'Create' }).click();

    // Modal stays open after user declines the create-folder confirmation
    await expect(window.getByRole('heading', { name: 'New container' })).toBeVisible();

    const calls = await getCalls(app);
    expect(calls.mkdirp).toEqual([]);
    expect(calls.create).toEqual([]);
  } finally {
    await app.close();
  }
});
