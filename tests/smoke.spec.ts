import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Scope locators to the currently-visible TerminalPane. Every live
 * workspace's pane is always-mounted (see App.tsx's
 * `workspaces.map(... <TerminalPane visible={...} />)`); only the one
 * matching `selectedId` has `aria-hidden="false"`. Without this scope
 * a selector like `.terminal-host` matches every mounted pane and
 * trips Playwright's strict-mode locator check.
 */
function activePane(window: Page) {
  return window.locator('.terminal-pane:not([aria-hidden="true"])');
}

interface LogEntry {
  ts: string;
  source: 'main' | 'renderer';
  type: string;
  message: string;
  extra?: Record<string, unknown>;
}

/**
 * Poll the main-process error.log (read directly from the test
 * process's filesystem, since `app.evaluate` runs in a context
 * without `require`) until at least one entry matches the
 * predicate, or timeout. Used to assert main-process side-effects
 * (like the cols/rows the broker was asked to spawn claude with)
 * that aren't reachable via the renderer's DOM.
 */
async function waitForLogEntry(
  userDataDir: string,
  match: (e: LogEntry) => boolean,
  timeoutMs = 5_000
): Promise<LogEntry> {
  const logPath = path.join(userDataDir, 'error.log');
  const deadline = Date.now() + timeoutMs;
  let lastEntries: LogEntry[] = [];
  for (;;) {
    let entries: LogEntry[] = [];
    try {
      const content = readFileSync(logPath, 'utf8');
      entries = content
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as LogEntry);
    } catch {
      // File may not exist yet — keep polling.
    }
    lastEntries = entries;
    const found = entries.find(match);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForLogEntry timed out after ${timeoutMs}ms. Last ${lastEntries.length} entries: ${JSON.stringify(lastEntries)}`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function launch(
  envOverrides: Record<string, string> = {}
): Promise<{ app: ElectronApplication; window: Page; userDataDir: string }> {
  // Isolate userData per launch so persisted state (sessions.json,
  // workspace manifests, image library) from one test can't leak into
  // another. The OS keeps temp dirs around — we don't bother cleaning,
  // they're small and OS-managed.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-test-'));
  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: { ...process.env, ...envOverrides } as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window, userDataDir };
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
  // Per-workspace observability summaries returned from
  // observability:summaryForWorkspace, keyed by workspace name. Missing
  // entries → null (matches the real handler's "no events yet" return).
  // Use unknown for the value so tests can pass partial shapes without
  // re-declaring the full WorkspaceObservabilitySummary type here.
  observabilitySummaries?: Record<string, Record<string, unknown> | null>;
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
      'fs:mkdirp',
      'observability:summaryForWorkspace',
      'observability:getCost',
      'observability:getCostForWorkspace'
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

    const summaries = opts.observabilitySummaries ?? {};
    ipcMain.handle(
      'observability:summaryForWorkspace',
      (_e, workspaceName: string) => summaries[workspaceName] ?? null
    );
    // Cost endpoints used by the sessions table and detail views;
    // return zeroed data for tests that don't care.
    const zeroCost = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      usd: 0
    };
    ipcMain.handle('observability:getCost', () => zeroCost);
    ipcMain.handle('observability:getCostForWorkspace', () => zeroCost);
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
    await expect(window.locator('.ws-chip-group.active', { hasText: 'mock-alpha' })).toBeVisible();
    await expect(activePane(window).locator('.terminal-host')).toBeVisible();
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
    const term = activePane(window).locator('.terminal-host');
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

// Opens the Close workspace modal for a chip via its hamburger menu.
// The old main-pane "Close…" header button was removed once the chip
// menu took over the action.
async function openCloseModalFor(window: Page, chipText: string): Promise<void> {
  const group = window.locator('.ws-chip-group', { hasText: chipText });
  await group.locator('.ws-chip-menu-trigger').click();
  await window.locator('.ws-chip-menu').getByRole('menuitem', { name: 'Close…' }).click();
}

test('Hamburger Close…: stops and removes a running workspace', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await openCloseModalFor(window, 'mock-alpha');
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();

    // Running workspace should expose both "Stop only" and "Stop & remove"
    await expect(window.getByRole('button', { name: 'Stop only' })).toBeVisible();
    await window.getByRole('button', { name: 'Stop & remove' }).click();

    // Modal closes, workspace disappears from strip
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeHidden();
    await expect(window.locator('.ws-chip .name', { hasText: 'mock-alpha' })).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Hamburger Close… on an exited workspace shows only Remove', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await openCloseModalFor(window, 'mock-beta');
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Stop only' })).toBeHidden();
    await expect(window.getByRole('button', { name: 'Remove' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Sessions persistence: write then read returns the same inventory', async () => {
  // Exercises the sessions.json layer end-to-end through IPC. The
  // renderer-facing read/write API is what TerminalPane uses on mount
  // and on every tab-list change.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    const inv = {
      version: 1,
      sessions: [
        { id: 'aaa', name: 'main', createdAt: 1000 },
        { id: 'bbb', name: 'session 2', createdAt: 2000 }
      ],
      nextNum: 3,
      activeId: 'bbb'
    };
    await window.evaluate(async (inventory) => {
      await window.api.sessions.write('persistence-roundtrip-test', inventory);
    }, inv);

    const got = await window.evaluate(async () => {
      return window.api.sessions.read('persistence-roundtrip-test');
    });

    expect(got).toEqual(inv);
  } finally {
    await app.close();
  }
});

test('Pause: chip shows paused glyph and terminal pane shows paused overlay', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Select the running mock-alpha workspace so its terminal pane mounts.
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    await expect(activePane(window).locator('.terminal-host')).toBeVisible();

    // Pause via the chip's hamburger menu.
    const group = window.locator('.ws-chip-group', { hasText: 'mock-alpha' });
    await group.locator('.ws-chip-menu-trigger').click();
    await window.locator('.ws-chip-menu').getByRole('menuitem', { name: 'Pause' }).click();

    // The renderer polls workspace:list every 5s but onRefresh fires
    // immediately after the menu action — paused state should land fast.
    await expect(
      window.locator('.ws-chip-group', { hasText: 'mock-alpha' }).locator('.chip-paused-glyph')
    ).toBeVisible();
    await expect(window.locator('.paused-overlay')).toBeVisible();
    await expect(window.getByText('workspace paused')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Pause + Resume: clicking Resume in the overlay un-pauses and clears it', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const group = window.locator('.ws-chip-group', { hasText: 'mock-alpha' });
    await group.locator('.ws-chip-menu-trigger').click();
    await window.locator('.ws-chip-menu').getByRole('menuitem', { name: 'Pause' }).click();

    await expect(window.locator('.paused-overlay')).toBeVisible();

    // Resume button inside the overlay.
    await window.locator('.paused-overlay').getByRole('button', { name: 'Resume' }).click();

    // After unpause the overlay disappears and the chip's pause glyph
    // does too. Underlying terminal regains pointer events.
    await expect(window.locator('.paused-overlay')).toBeHidden();
    await expect(
      window.locator('.ws-chip-group', { hasText: 'mock-alpha' }).locator('.chip-paused-glyph')
    ).toBeHidden();
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

test('Hamburger menu: running workspace shows Pause/Stop, paused shows Resume', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    const chipGroup = window.locator('.ws-chip-group', { hasText: 'mock-alpha' });
    const trigger = chipGroup.locator('.ws-chip-menu-trigger');
    await trigger.click();

    // The menu is portaled to document.body; query it at page level.
    const menu = window.locator('.ws-chip-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Pause' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Stop' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Close…' })).toBeVisible();
    // Stopped/Start should NOT appear for a running workspace.
    await expect(menu.getByRole('menuitem', { name: 'Resume' })).toBeHidden();
    await expect(menu.getByRole('menuitem', { name: 'Start' })).toBeHidden();

    await menu.getByRole('menuitem', { name: 'Pause' }).click();
    await expect(menu).toBeHidden();
    await expect(chipGroup.locator('.dot.paused')).toBeVisible();

    // Re-open the menu — now we should see Resume instead.
    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Resume' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Pause' })).toBeHidden();
    await expect(menu.getByRole('menuitem', { name: 'Stop' })).toBeHidden();

    await menu.getByRole('menuitem', { name: 'Resume' }).click();
    await expect(chipGroup.locator('.dot.running')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Hamburger menu: stopped workspace shows Start (not Pause/Stop)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // mock-beta is seeded as state='stopped'
    const chipGroup = window.locator('.ws-chip-group', { hasText: 'mock-beta' });
    await chipGroup.locator('.ws-chip-menu-trigger').click();

    const menu = window.locator('.ws-chip-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Start' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Close…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Pause' })).toBeHidden();
    await expect(menu.getByRole('menuitem', { name: 'Stop' })).toBeHidden();
    await expect(menu.getByRole('menuitem', { name: 'Resume' })).toBeHidden();

    await menu.getByRole('menuitem', { name: 'Start' }).click();
    await expect(chipGroup.locator('.dot.running')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Hamburger menu: Close… opens the CloseWorkspaceModal even when chip is not selected', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Don't click mock-beta first — go straight to its hamburger menu.
    const chipGroup = window.locator('.ws-chip-group', { hasText: 'mock-beta' });
    await chipGroup.locator('.ws-chip-menu-trigger').click();
    await window
      .locator('.ws-chip-menu')
      .getByRole('menuitem', { name: 'Close…' })
      .click();

    // The Close modal opens for mock-beta (the chip the user clicked the
    // menu on), not for whatever was previously selected (nothing here).
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();
    await expect(window.locator('.modal-eyebrow', { hasText: 'mock-beta' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Pause then Resume via the Close modal (opened from hamburger)', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    const chip = window.locator('.ws-chip', { hasText: 'mock-alpha' });

    // Running workspace → Close modal exposes Pause.
    await openCloseModalFor(window, 'mock-alpha');
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();
    await window.getByRole('button', { name: 'Pause' }).click();

    // Modal closes; the workspace chip now shows the paused dot.
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeHidden();
    await expect(chip.locator('.dot.paused')).toBeVisible();
    await expect(chip.locator('.dot.running')).toBeHidden();

    // Reopen Close modal via the hamburger. Paused workspace → Resume button.
    await openCloseModalFor(window, 'mock-alpha');
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Pause' })).toBeHidden();
    const resume = window.getByRole('button', { name: 'Resume' });
    await expect(resume).toBeVisible();
    await resume.click();

    // Modal closes; the workspace chip is back to running.
    await expect(window.getByRole('heading', { name: 'Close workspace' })).toBeHidden();
    await expect(chip.locator('.dot.running')).toBeVisible();
    await expect(chip.locator('.dot.paused')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Past workspaces: paused workspace renders the paused state in the past list', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'frozen-fox',
          containerId: 'frozen-fox-id',
          state: 'paused',
          status: 'Paused',
          workspaceRoot: '/tmp/frozen-fox',
          profile: 'oauth'
        }
      ]
    });

    await window.locator('.top-strip').getByRole('button', { name: '+ New workspace' }).click();
    await expect(window.getByRole('heading', { name: 'New workspace' })).toBeVisible();

    const row = window.locator('.past-workspace-row', { hasText: 'frozen-fox' });
    await expect(row).toBeVisible();
    await expect(row.locator('.ws-state.paused')).toBeVisible();
    await expect(row.locator('.dot.paused')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Multi-session: workspace starts with a "main" tab; + adds new tabs; close switches', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();

    const strip = activePane(window).locator('.session-tab-strip');
    await expect(strip).toBeVisible();

    // First session is auto-created and called "main".
    const tabs = strip.locator('.session-tab');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.nth(0)).toContainText('main');
    await expect(tabs.nth(0)).toHaveClass(/active/);

    // + adds a new session, becomes active, named "session 2".
    await strip.getByRole('button', { name: 'New session' }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toContainText('session 2');
    await expect(tabs.nth(1)).toHaveClass(/active/);
    await expect(tabs.nth(0)).not.toHaveClass(/active/);

    // Clicking the main tab switches focus back to it.
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveClass(/active/);
    await expect(tabs.nth(1)).not.toHaveClass(/active/);

    // Add a third — counter doesn't decrement, so it's "session 3".
    await strip.getByRole('button', { name: 'New session' }).click();
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(2)).toContainText('session 3');

    // Close the active "session 3" — focus moves to the tab on its left
    // (session 2), not all the way back to main.
    await tabs.nth(2).getByRole('button', { name: 'Close session 3' }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toContainText('session 2');
    await expect(tabs.nth(1)).toHaveClass(/active/);
    await expect(tabs.nth(0)).not.toHaveClass(/active/);
  } finally {
    await app.close();
  }
});

test('Multi-session: closing the only tab respawns a fresh "main"', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();

    const strip = activePane(window).locator('.session-tab-strip');
    const tabs = strip.locator('.session-tab');
    await expect(tabs).toHaveCount(1);

    await tabs.nth(0).getByRole('button', { name: /Close main/ }).click();

    // Strip is never empty: a fresh "main" appears in place.
    await expect(tabs).toHaveCount(1);
    await expect(tabs.nth(0)).toContainText('main');
    await expect(tabs.nth(0)).toHaveClass(/active/);
  } finally {
    await app.close();
  }
});

test('Session ended overlay: "Start new session" reattaches a fresh claude', async () => {
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const term = activePane(window).locator('.terminal-host');
    await expect(term).toBeVisible();

    // Type `exit` in the mock shell — closes the duplex, triggers
    // the "session ended" overlay in TerminalPane.
    await term.click();
    await window.keyboard.type('exit');
    await window.keyboard.press('Enter');

    const overlay = activePane(window).locator('.session-ended-overlay');
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

test('Attach error overlay: broker-unreachable surfaces the actual error message', async () => {
  // Regression guard for the "blank cursor → generic session-ended modal"
  // bug. The mock seeds a `fail-broker-missing` workspace whose attachPty
  // throws synchronously (mirroring the real-world ENOENT on the broker
  // socket — what happens when the local runner image predates the broker
  // landing). Before the fix, that error was written into xterm and
  // immediately covered by the session-ended overlay; users saw nothing
  // actionable. Now the attach-error overlay surfaces the message verbatim
  // plus a hint about pulling the runner image.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // The seeded `fail-broker-missing` chip is already in the top strip;
    // clicking it mounts TerminalPane and triggers the attach.
    await window.locator('.ws-chip', { hasText: 'fail-broker-missing' }).click();

    const overlay = window.locator('.session-ended-overlay');
    await expect(overlay).toBeVisible({ timeout: 5_000 });
    await expect(overlay.getByText("couldn't attach to the workspace")).toBeVisible();
    const errorBlock = window.getByTestId('attach-error-message');
    await expect(errorBlock).toBeVisible();
    await expect(errorBlock).toContainText('broker socket not reachable');
    await expect(errorBlock).toContainText('Is the runner image new enough');
    // The pull hint is part of the help copy in the attach-error variant.
    await expect(
      overlay.getByText(/docker pull ghcr\.io\/imioimi\/claude-fleet\/runner/)
    ).toBeVisible();
    await expect(overlay.getByRole('button', { name: 'Retry' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Always-mount: pty:attach receives fitted xterm cols/rows, not the 80x24 default', async () => {
  // Regression guard for the "claude setup-flow scrollback corruption"
  // bug. With always-mount, TerminalPane mounts when the workspace
  // appears in the list, not when the user clicks the chip. Its
  // TerminalSession initializes xterm at the default 80x24 and calls
  // `pty.attach(containerId, sessionId, term.cols, term.rows)`
  // synchronously — BEFORE any fit-addon resize fires. Claude is
  // spawned at 80x24, writes its multi-screen setup flow at that
  // size, and only later receives a SIGWINCH from the post-fit
  // pty.resize. The reflow-after-clear scrambles scrollback: rows
  // beyond the original 24 inherit leftover content from earlier
  // setup screens.
  //
  // The fix is to defer attach until after the initial safeFit runs
  // (one rAF). This test asserts the cols/rows recorded in the
  // pty-attach log entry are the fitted values, not the xterm
  // default — failing as long as the bug exists, passing once attach
  // happens after fit.
  //
  // Why mock mode: real-backend repro requires Docker + a long
  // claude setup flow. The bug is in the renderer's mount sequence
  // (when fit runs vs when attach is called), so the mock backend
  // exercises it just as well — the cols/rows passed to attachPty
  // come from xterm regardless of which backend handles them.
  const { app, userDataDir } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Mock seeds 3 workspaces at startup, each gets a TerminalPane
    // under always-mount. We just need ANY pty-attach to land in the
    // log to inspect its cols/rows.
    const attachEntry = await waitForLogEntry(userDataDir, (e) => e.type === 'pty-attach');
    const extra = (attachEntry.extra ?? {}) as { cols?: number; rows?: number };

    expect(extra.cols).toBeDefined();
    expect(extra.rows).toBeDefined();
    // Window is 1400×900 (src/main/index.ts), main pane gets ~800px
    // wide; fitted xterm should be well over 80 cols. Default xterm
    // is 80x24 — if attach fires before fit, we see exactly that.
    expect(extra.cols).not.toBe(80);
    expect(extra.rows).not.toBe(24);
  } finally {
    await app.close();
  }
});

test('Always-mount: workspace terminals stay isolated (no cross-workspace data bleed)', async () => {
  // Regression guard for the "witty-wren's sessions are mixed up with
  // gentle-crane's" bug. With always-mount, multiple workspaces have
  // their TerminalPanes mounted simultaneously, each with its own
  // BrokerClient and xterm. If anything in the routing/state path
  // crosses streams — wrong containerId passed to attach, sessions.json
  // for one workspace getting written under another's name, broker
  // channels colliding — the symptom is: workspace A's terminal shows
  // content from workspace B (or some mix of both).
  //
  // Mock-mode FakeShell prints `workspace: <name>` in its 150ms-delayed
  // welcome banner. If routing is correct, mock-alpha's xterm contains
  // only "workspace: mock-alpha" and never sees "workspace: mock-beta",
  // and vice-versa. If the bug exists, the cross-name leaks in.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Click mock-alpha and assert its terminal has its own name only.
    // Each FakeShell's 150ms greet timer starts when its TerminalPane
    // mounts — i.e., at app startup with always-mount.
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const alphaRows = activePane(window).locator('.xterm-rows');
    await expect(alphaRows).toContainText('workspace: mock-alpha', { timeout: 3_000 });
    const alphaContent = (await alphaRows.textContent()) ?? '';
    expect(alphaContent).not.toContain('workspace: mock-beta');

    // Switch to mock-beta and assert its terminal has its own name only.
    await window.locator('.ws-chip', { hasText: 'mock-beta' }).click();
    const betaRows = activePane(window).locator('.xterm-rows');
    await expect(betaRows).toContainText('workspace: mock-beta', { timeout: 3_000 });
    const betaContent = (await betaRows.textContent()) ?? '';
    expect(betaContent).not.toContain('workspace: mock-alpha');
  } finally {
    await app.close();
  }
});

test('Always-mount: only the selected workspace\'s xterm is actually visible (CSS cascade)', async () => {
  // Captures the "witty-wren's terminal shows gentle-crane's claude
  // output" symptom. Root-cause hypothesis: visibility-cascade quirk.
  // TerminalPane sets `style={{ visibility: visible ? 'visible' : 'hidden' }}`
  // on its outer div, but the inner TerminalSession ALSO sets
  // `visibility: visible` on its own div when it's the active tab in
  // that pane. Per CSS spec, `visibility: visible` on a descendant
  // overrides `visibility: hidden` on an ancestor — so every workspace's
  // active TerminalSession actually paints, regardless of whether the
  // outer pane is meant to be hidden. They all stack at
  // `position: absolute; inset: 0`; the one later in DOM order is on
  // top, and that's what the user sees no matter which chip they
  // click.
  //
  // This test asserts: after clicking a chip, EXACTLY ONE `.xterm-rows`
  // element is actually visible per Playwright's visibility check
  // (which follows the browser's "is this element rendered" rules,
  // not just CSS class names). If the bug exists, multiple .xterm-rows
  // are visible simultaneously.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Wait for both panes to mount and their xterms to render.
    await expect(window.locator('.xterm-rows')).toHaveCount(3, { timeout: 5_000 });

    // Click mock-alpha. Only mock-alpha's pane should be visibly painted.
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();

    const allXtermRows = window.locator('.xterm-rows');
    const count = await allXtermRows.count();
    const visibleStates = await Promise.all(
      Array.from({ length: count }, (_, i) => allXtermRows.nth(i).isVisible())
    );
    const visibleCount = visibleStates.filter(Boolean).length;
    expect(visibleCount).toBe(1);

    // Switch to mock-beta. Now only mock-beta's pane should be visible.
    await window.locator('.ws-chip', { hasText: 'mock-beta' }).click();
    const visibleStates2 = await Promise.all(
      Array.from({ length: count }, (_, i) => allXtermRows.nth(i).isVisible())
    );
    expect(visibleStates2.filter(Boolean).length).toBe(1);
  } finally {
    await app.close();
  }
});

test('Always-mount: adding a tab in one workspace does not leak into the other', async () => {
  // Companion to the data-bleed test above. The user reported "witty-wren's
  // sessions seem to be mixed up with gentle-crane's" — possibly meaning
  // tabs themselves (not terminal content) are leaking across workspaces.
  // With always-mount, both TerminalPanes' state hooks run continuously;
  // a misuse of workspaceName in the persist effect could cause workspace
  // A's tab additions to overwrite workspace B's sessions.json (or
  // vice-versa).
  //
  // This test: add a session to mock-alpha, switch to mock-beta, assert
  // mock-beta still has exactly one "main" tab and nothing leaked from
  // alpha's tab-add. Then add a session to mock-beta and confirm
  // alpha still has its alpha-only tabs.
  const { app, window } = await launch({ CLAUDE_FLEET_MOCK: '1' });
  try {
    // Click mock-alpha and verify single "main" tab.
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const alphaStrip = activePane(window).locator('.session-tab-strip');
    await expect(alphaStrip.locator('.session-tab')).toHaveCount(1);
    await expect(alphaStrip.locator('.session-tab').nth(0)).toContainText('main');

    // Add a new session in alpha → alpha has 2 tabs.
    await alphaStrip.getByRole('button', { name: 'New session' }).click();
    await expect(alphaStrip.locator('.session-tab')).toHaveCount(2);
    await expect(alphaStrip.locator('.session-tab').nth(1)).toContainText('session 2');

    // Switch to mock-beta. Its tab strip must still have exactly one
    // "main" tab — alpha's add MUST NOT have leaked into beta.
    await window.locator('.ws-chip', { hasText: 'mock-beta' }).click();
    const betaStrip = activePane(window).locator('.session-tab-strip');
    await expect(betaStrip.locator('.session-tab')).toHaveCount(1);
    await expect(betaStrip.locator('.session-tab').nth(0)).toContainText('main');

    // Add a session to beta.
    await betaStrip.getByRole('button', { name: 'New session' }).click();
    await expect(betaStrip.locator('.session-tab')).toHaveCount(2);
    await expect(betaStrip.locator('.session-tab').nth(1)).toContainText('session 2');

    // Switch back to alpha. Its tab list must be EXACTLY what we left:
    // 2 tabs, both still bearing alpha's original names. Beta's add
    // MUST NOT have leaked into alpha.
    await window.locator('.ws-chip', { hasText: 'mock-alpha' }).click();
    const alphaStrip2 = activePane(window).locator('.session-tab-strip');
    await expect(alphaStrip2.locator('.session-tab')).toHaveCount(2);
    await expect(alphaStrip2.locator('.session-tab').nth(0)).toContainText('main');
    await expect(alphaStrip2.locator('.session-tab').nth(1)).toContainText('session 2');
  } finally {
    await app.close();
  }
});

test('Slot consumer: chip secondary line shows live activity from observability summary', async () => {
  // Issue #34, part 1: each workspace chip in the top strip gets a small
  // secondary line below the workspace name showing recent activity —
  // "active 30s ago" / "idle 1h ago" / null when no events have been
  // ingested for that workspace yet. The summary comes from the
  // centralized observability:summaryForWorkspace poll in App.tsx (so
  // multiple consumers — pane, chip, terminal-pane context-bar — all
  // share one source of truth, polled once per 2s per workspace).
  const { app, window } = await launch();
  try {
    const recent = Date.now() - 30_000;
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'alpha',
          containerId: 'alpha-id',
          state: 'running',
          workspaceRoot: '/tmp/alpha',
          profile: 'oauth'
        }
      ],
      observabilitySummaries: {
        alpha: {
          sessionId: 'sess-1',
          title: 'demo session',
          model: 'claude-opus-4-7',
          startedAt: recent - 5 * 60_000,
          lastActiveAt: recent,
          eventCount: 10,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          usd: 0.05,
          lastTurnContextTokens: 80_000,
          topTools: []
        }
      }
    });

    // Force a refresh so workspace:list and the summary IPCs are queried.
    // The chip should appear with its workspace name on top and an
    // "active …" line beneath.
    const chip = window.locator('.ws-chip', { hasText: 'alpha' });
    await expect(chip).toBeVisible({ timeout: 5_000 });
    await expect(chip.locator('.ws-chip-sub')).toBeVisible({ timeout: 5_000 });
    await expect(chip.locator('.ws-chip-sub')).toContainText(/active/);
  } finally {
    await app.close();
  }
});

test('Slot consumer: terminal context bar fills proportionally to lastTurnContextTokens', async () => {
  // Issue #34, part 3: the workspace's accent band at the top of the
  // terminal area becomes a context-window-fullness gauge. Its `--pct`
  // CSS variable should be `(lastTurnContextTokens / 200_000) * 100`,
  // clamped to [0, 100]. When summary is missing, falls back to 100%
  // (pure identity band, the pre-observability behavior).
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'alpha',
          containerId: 'alpha-id',
          state: 'running',
          workspaceRoot: '/tmp/alpha',
          profile: 'oauth'
        }
      ],
      observabilitySummaries: {
        alpha: {
          sessionId: 'sess-1',
          title: null,
          model: 'claude-opus-4-7',
          startedAt: Date.now() - 60_000,
          lastActiveAt: Date.now() - 5_000,
          eventCount: 3,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          usd: 0,
          // 80k / 200k = 40%
          lastTurnContextTokens: 80_000,
          topTools: []
        }
      }
    });

    // Click the chip so its TerminalPane is the visible one (always-mount
    // means all panes mount; only the visible one is paintable).
    await window.locator('.ws-chip', { hasText: 'alpha' }).click();
    const band = activePane(window).locator('.terminal-accent-band');
    await expect(band).toBeVisible({ timeout: 5_000 });

    // Wait for the polling effect in App.tsx to feed the summary down
    // (the value lands on the next poll tick after click). Then assert.
    await expect
      .poll(
        async () => band.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--pct')),
        { timeout: 5_000 }
      )
      .toBe('40%');
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
