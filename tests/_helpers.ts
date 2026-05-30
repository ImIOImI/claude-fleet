// Shared fixtures + helpers for the playwright e2e suite. Underscore-
// prefixed so playwright's default testMatch (`**/*.@(spec|test).…`)
// doesn't pick this up as a test file.
//
// Pattern: each spec file imports `launch`, `mockMainIpc`, etc. from
// here. We mock at the IPC-handler level via `app.evaluate` (which
// runs in main, where ipcMain is mutable) — `contextBridge.exposeIn`
// `MainWorld` makes the api object effectively immutable from the
// renderer, so renderer-side mocking doesn't work.

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Scope locators to the currently-visible TerminalPane. Every live
 * workspace's pane is always-mounted (see App.tsx's
 * `workspaces.map(... <TerminalPane visible={...} />)`); only the one
 * matching `selectedId` has `aria-hidden="false"`. Without this scope
 * a selector like `.terminal-host` matches every mounted pane and
 * trips Playwright's strict-mode locator check.
 */
export function activePane(window: Page) {
  return window.locator('.terminal-pane:not([aria-hidden="true"])');
}

export interface LogEntry {
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
export async function waitForLogEntry(
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

export async function launch(
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

export interface MockOpts {
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
  // When true, `observability:summaryForBrokerSession` returns a
  // summary whose `title` and `sessionId` encode the broker session id
  // — lets tests assert per-tab routing by watching the title change
  // across tab switches. When false (default), the endpoint returns
  // null, matching the real server-side behavior after the bug-A fix.
  observabilityPerTabSummaries?: boolean;
}

export async function mockMainIpc(app: ElectronApplication, opts: MockOpts = {}): Promise<void> {
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
      'observability:summaryForBrokerSession',
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
    // Per-tab variant. Default matches the real server-side behavior:
    // null when no mapping is known. Tests that need to assert per-tab
    // routing pass observabilityPerTabSummaries=true.
    ipcMain.handle(
      'observability:summaryForBrokerSession',
      (_e, _workspaceName: string, brokerSessionId: string) => {
        if (opts.observabilityPerTabSummaries) {
          const tag = brokerSessionId.slice(0, 8);
          return {
            sessionId: `claude-${tag}`,
            title: `Tab-${tag}`,
            model: 'claude-opus-4-7',
            startedAt: Date.now(),
            lastActiveAt: Date.now(),
            eventCount: 1,
            inputTokens: 100,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            usd: 0.001,
            lastTurnContextTokens: 100,
            contextWindowTokens: 200_000,
            topTools: []
          };
        }
        return null;
      }
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

export async function getCalls(app: ElectronApplication): Promise<Record<string, unknown[]>> {
  return app.evaluate(
    () => (globalThis as unknown as { __calls: Record<string, unknown[]> }).__calls
  );
}

/**
 * Open the Close workspace modal for a chip via its hamburger menu.
 * The old main-pane "Close…" header button was removed once the chip
 * menu took over the action.
 */
export async function openCloseModalFor(window: Page, chipText: string): Promise<void> {
  const group = window.locator('.ws-chip-group', { hasText: chipText });
  await group.locator('.ws-chip-menu-trigger').click();
  await window.locator('.ws-chip-menu').getByRole('menuitem', { name: 'Close…' }).click();
}

/**
 * Invoke a test-only ipcMain handler from playwright. Only the
 * `__test:*` channels registered in `src/main/ipc.ts` (gated by
 * `CLAUDE_FLEET_E2E=1`) are reachable — contextIsolation hides
 * `ipcRenderer` from the renderer page, so we go through ipcMain's
 * internal handler map directly.
 */
export async function callTestIpc<T>(
  app: ElectronApplication,
  channel: string,
  args: unknown[]
): Promise<T> {
  return app.evaluate(
    async ({ ipcMain }, [ch, a]) => {
      const internal = (ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
      })._invokeHandlers;
      const handler = internal.get(ch as string);
      if (!handler) throw new Error(`${ch as string} not registered`);
      return (await handler({ sender: null }, ...(a as unknown[]))) as T;
    },
    [channel, args] as const
  );
}
