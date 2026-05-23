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
      workspace: typeof (window as unknown as { api?: { workspace?: unknown } }).api?.workspace,
      images: typeof (window as unknown as { api?: { images?: unknown } }).api?.images,
      vault: typeof (window as unknown as { api?: { vault?: unknown } }).api?.vault,
      pty: typeof (window as unknown as { api?: { pty?: unknown } }).api?.pty,
      fs: typeof (window as unknown as { api?: { fs?: unknown } }).api?.fs,
      dialog: typeof (window as unknown as { api?: { dialog?: unknown } }).api?.dialog
    }));
    expect(types).toEqual({
      api: 'object',
      workspace: 'object',
      images: 'object',
      vault: 'object',
      pty: 'object',
      fs: 'object',
      dialog: 'object'
    });
  } finally {
    await app.close();
  }
});

test('+ New workspace opens the modal', async () => {
  const { app, window } = await launch();
  try {
    // WorkspaceTabStrip disables the + New workspace button when
    // backendReady === false; stub the backend so the test isn't gated
    // on host Docker state.
    await mockMainIpc(app);
    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Create button surfaces validation errors when required fields are empty', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app);
    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();

    // Name now has a pet-name placeholder default, so the remaining required
    // field is the workspace root — we still expect a "required" / "match"
    // error to be surfaced rather than a silent no-op.
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.locator('.error-text')).toContainText(/required|match/);
  } finally {
    await app.close();
  }
});

// The full submit flow with backend / FS IPC stubbed in the main process.
// `contextBridge.exposeInMainWorld` makes the api object's properties
// effectively immutable from the renderer side, so mocking via
// `window.evaluate` doesn't work. We mock at the IPC-handler level via
// `app.evaluate`, which runs in the main process where ipcMain is mutable.
//
// The actual OAuth handshake (browser → Anthropic → auth code) can't be
// tested in CI — it needs real credentials and an interactive browser.
// What we guarantee here is the foundation: a blank-profile submit
// produces a workspace with profile label 'oauth' and an empty env, so
// when claude starts in the PTY there's no ANTHROPIC_API_KEY env to win
// precedence over OAuth.

interface MockOpts {
  isDirectoryReturns?: boolean;
  // Workspaces returned from workspace:list. Defaults to []. The renderer
  // synthesizes ids: live → containerId, deleted → "deleted:<name>".
  workspaceList?: Array<{
    name: string;
    containerId?: string;
    state: 'running' | 'stopped' | 'deleted';
    status?: string;
    workspaceRoot: string;
    workspaceSubdir?: string;
    profile: string;
    kind?: 'container' | 'local';
    image?: string;
    createdAt?: number;
    lastUsedAt?: number;
  }>;
  // Images returned from images:list. Defaults to [].
  imageLibrary?: Array<{
    ref: string;
    digest?: string;
    labels: Record<string, string>;
    firstUsedAt?: number;
    lastUsedAt?: number;
    useCount?: number;
  }>;
}

async function mockMainIpc(app: ElectronApplication, opts: MockOpts = {}): Promise<void> {
  await app.evaluate(({ ipcMain }, opts) => {
    const g = globalThis as unknown as { __calls: Record<string, unknown[]> };
    g.__calls = {
      ensureImage: [],
      create: [],
      list: [],
      start: [],
      isDirectory: [],
      mkdirp: []
    };

    const channels = [
      'workspace:ensureImage',
      'workspace:create',
      'workspace:list',
      'workspace:start',
      'workspace:ping',
      'images:list',
      'images:remove',
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

    const now = Date.now();
    const list = (opts.workspaceList ?? []).map((w) => ({
      workspaceSubdir: '',
      createdAt: now,
      lastUsedAt: now,
      ...w
    }));

    ipcMain.handle('workspace:ping', () => true);
    ipcMain.handle('workspace:list', () => {
      g.__calls.list.push(true);
      return list;
    });
    ipcMain.handle('workspace:ensureImage', async () => {
      g.__calls.ensureImage.push(true);
    });
    ipcMain.handle('workspace:create', async (_e, spec: Record<string, unknown>) => {
      g.__calls.create.push(spec);
      return {
        name: spec.name,
        containerId: 'fake-id',
        state: 'running',
        status: 'running',
        workspaceRoot: spec.workspaceRoot,
        workspaceSubdir: spec.workspaceSubdir ?? '',
        profile: spec.profile,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      };
    });
    ipcMain.handle('workspace:start', async (_e, name: string) => {
      g.__calls.start.push(name);
      const found = list.find((w) => w.name === name);
      if (!found) return null;
      return { ...found, state: 'running', containerId: found.containerId ?? `restarted-${name}` };
    });
    ipcMain.handle('fs:isDirectory', async (_e, p: string) => {
      g.__calls.isDirectory.push(p);
      return opts.isDirectoryReturns ?? true;
    });
    ipcMain.handle('fs:mkdirp', async (_e, p: string) => {
      g.__calls.mkdirp.push(p);
    });

    const imageLib = (opts.imageLibrary ?? []).map((img) => ({
      firstUsedAt: now,
      lastUsedAt: now,
      useCount: 1,
      ...img
    }));
    ipcMain.handle('images:list', () => imageLib);
    ipcMain.handle('images:remove', (_e, ref: string) => {
      const idx = imageLib.findIndex((img) => img.ref === ref);
      if (idx >= 0) imageLib.splice(idx, 1);
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

    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await window.getByLabel('Workspace name').fill('test-oauth-workspace');
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/fleet-test');
    // Subdir and profile left blank → OAuth mode

    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeHidden();

    const calls = await getCalls(app);
    expect(calls.ensureImage).toHaveLength(1);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({
      name: 'test-oauth-workspace',
      workspaceRoot: '/tmp/fleet-test',
      workspaceSubdir: '',
      profile: 'oauth',
      env: {}
    });
  } finally {
    await app.close();
  }
});

test('Create flow: missing workspace prompts to create it and mkdirps before workspace-create', async () => {
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

    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await window.getByLabel('Workspace name').fill('test-mkdir');
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/does-not-exist-yet');

    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeHidden();

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

test('Mock mode: seeded workspaces appear and MOCK MODE chip is visible', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await expect(window.getByText('MOCK MODE')).toBeVisible();
    await expect(window.locator('.ws-chip .name', { hasText: 'mock-alpha' })).toBeVisible();
    await expect(window.locator('.ws-chip .name', { hasText: 'mock-beta' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Mock mode: selecting a workspace mounts the terminal pane', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    await expect(window.locator('.ws-chip.active', { hasText: 'mock-alpha' })).toBeVisible();
    await expect(window.locator('.terminal-host')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Mock mode: oauth command runs without crashing the terminal', async () => {
  // Canvas rendering hides URL text from Playwright; this test only proves
  // the command path stays alive end-to-end. The clickable-link behavior must
  // be verified manually by running `CLAUDE_FLEET_MOCK=1 npm run dev`,
  // typing `oauth`, and clicking the wrapped URL.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const term = window.locator('.terminal-host');
    await expect(term).toBeVisible();
    await term.click();
    await window.keyboard.type('oauth');
    await window.keyboard.press('Enter');
    await window.waitForTimeout(500);
    await expect(term).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Mock mode: Close button stops and removes the selected workspace', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();

    await window.getByRole('button', { name: 'Close…' }).click();
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();

    // Running workspace should expose both "Stop only" and "Stop & remove"
    await expect(window.getByRole('button', { name: 'Stop only' })).toBeVisible();
    await window.getByRole('button', { name: 'Stop & remove' }).click();

    // Modal closes, workspace disappears from strip, nothing is selected
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeHidden();
    await expect(window.locator('.ws-chip .name', { hasText: 'mock-alpha' })).toBeHidden();
    await expect(window.locator('.empty', { hasText: 'No workspace selected' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Mock mode: Close on an exited workspace shows only Remove', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-beta' }).click();
    await window.getByRole('button', { name: 'Close…' }).click();
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();
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

    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await window.getByLabel('Workspace name').fill('test-decline');
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/declined-path');
    await window.getByRole('button', { name: 'Create & start' }).click();

    // Modal stays open after user declines the create-folder confirmation
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();

    const calls = await getCalls(app);
    expect(calls.mkdirp).toEqual([]);
    expect(calls.create).toEqual([]);
  } finally {
    await app.close();
  }
});

test('Create modal: workspace root persists across opens', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app);
    // Start with no remembered workspace so the first open's input
    // value is deterministically empty.
    await window.evaluate(() => localStorage.removeItem('claude-fleet:lastWorkspaceRoot'));

    const newWorkspace = window
      .locator('.top-strip')
      .getByRole('button', { name: '+ New workspace' });
    const wsInput = window.getByPlaceholder('/home/troy/repos');

    // First open + submit
    await newWorkspace.click();
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    await expect(wsInput).toHaveValue('');
    await window.getByLabel('Workspace name').fill('persistence-test-1');
    await wsInput.fill('/tmp/persistence-test-A');
    await window.getByRole('button', { name: 'Create & start' }).click();
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeHidden();

    // Second open — the workspace input should remember the previous value.
    await newWorkspace.click();
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    await expect(wsInput).toHaveValue('/tmp/persistence-test-A');
  } finally {
    await app.close();
  }
});

test('Past workspaces: deleted workspace appears in modal and restart fires workspace:start', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'ghost-fox',
          state: 'deleted',
          workspaceRoot: '/tmp/ghost-fox',
          profile: 'oauth'
        }
      ]
    });

    await window
      .locator('.top-strip')
      .getByRole('button', { name: '+ New workspace' })
      .click();

    // The "deleted" workspace isn't in the top strip but should appear in
    // the modal's past-workspaces list.
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    const row = window.locator('.past-workspace-row', { hasText: 'ghost-fox' });
    await expect(row).toBeVisible();
    await expect(row.locator('.ws-state.deleted')).toBeVisible();

    await row.click();

    // The modal closes after a successful restart, and workspace:start was
    // invoked with the workspace name.
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeHidden();
    const calls = await getCalls(app);
    expect(calls.start).toContain('ghost-fox');
  } finally {
    await app.close();
  }
});

test('Workspace kind selector: Local shows a "coming soon" error on submit', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app);
    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();

    // Both kind radios are visible; Container is the default.
    const container = window.getByRole('radio', { name: /Container/ });
    const local = window.getByRole('radio', { name: /Local/ });
    await expect(container).toBeChecked();
    await expect(local).not.toBeChecked();

    // Pick Local and submit — should block with a "not implemented" error,
    // never call workspace:create.
    await local.check();
    await window.getByPlaceholder('/home/troy/repos').fill('/tmp/local-ws');
    await window.getByRole('button', { name: 'Create & start' }).click();

    await expect(window.locator('.error-text')).toContainText(/aren't implemented yet|coming soon/i);
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    const calls = await getCalls(app);
    expect(calls.create).toEqual([]);
  } finally {
    await app.close();
  }
});

test('Session ended overlay: "Start new session" reattaches a fresh claude', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const term = window.locator('.terminal-host');
    await expect(term).toBeVisible();

    // Type `exit` in the mock shell — closes the duplex, triggers
    // the "session ended" overlay in TerminalPane.
    await term.click();
    await window.keyboard.type('exit');
    await window.keyboard.press('Enter');

    const overlay = window.locator('.session-ended-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole('button', { name: 'Start new session' })).toBeVisible();

    // Click → overlay disappears (new attach succeeds in mock mode).
    await overlay.getByRole('button', { name: 'Start new session' }).click();
    await expect(overlay).toBeHidden();
    await expect(term).toBeVisible();
  } finally {
    await app.close();
  }
});

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
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();

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
