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
  // Workspaces returned from workspace:list. Defaults to []. Renderer
  // identity is the ULID `id`; tests can pass an arbitrary string (the
  // mock doesn't enforce ULID shape since it never resolves a real
  // state-dir). `authMode`/`env`/`labels` default to safe values so
  // legacy tests don't have to spell them out.
  workspaceList?: Array<{
    id?: string;
    name: string;
    description?: string;
    labels?: string[];
    containerId?: string;
    state: 'running' | 'stopped' | 'deleted';
    status?: string;
    workspaceRoot: string;
    workspaceSubdir?: string;
    kind?: 'container' | 'local';
    image?: string;
    authMode?: 'oauth' | 'apikey';
    env?: { plain: Record<string, string>; secretKeys: string[] };
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
  // userPrompts:list rows, keyed by workspace id. Missing → [].
  userPrompts?: Record<string, unknown[]>;
}

export async function mockMainIpc(app: ElectronApplication, opts: MockOpts = {}): Promise<void> {
  await app.evaluate(({ ipcMain }, opts) => {
    const g = globalThis as unknown as { __calls: Record<string, unknown[]> };
    g.__calls = {
      ensureImage: [],
      create: [],
      list: [],
      start: [],
      stop: [],
      pause: [],
      remove: [],
      writeManifest: [],
      isDirectory: [],
      mkdirp: [],
      vaultSetSecret: [],
      vaultDeleteAllForWorkspace: []
    };

    const channels = [
      'workspace:ensureImage',
      'workspace:create',
      'workspace:list',
      'workspace:start',
      'workspace:stop',
      'workspace:pause',
      'workspace:remove',
      'workspace:ping',
      'workspace:writeManifest',
      'images:list',
      'images:remove',
      'fs:isDirectory',
      'fs:mkdirp',
      'vault:available',
      'vault:listKeys',
      'vault:getSecret',
      'vault:setSecret',
      'vault:deleteSecret',
      'vault:deleteAllForWorkspace',
      'observability:summaryForWorkspace',
      'observability:summaryForBrokerSession',
      'observability:getCost',
      'observability:getCostForWorkspace',
      'userPrompts:list'
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
      // Pre-fill the new identity + manifest fields so callers don't
      // have to spell them out. Defaulting `id` to `name` keeps the old
      // tests' name-based workspace references working without
      // declaring an explicit ULID.
      id: w.id ?? w.name,
      labels: w.labels ?? [],
      authMode: w.authMode ?? 'oauth',
      env: w.env ?? { plain: {}, secretKeys: [] },
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
        id: spec.id,
        name: spec.name,
        description: spec.description,
        labels: spec.labels ?? [],
        color: spec.color,
        containerId: 'fake-id',
        state: 'running',
        status: 'running',
        workspaceRoot: spec.workspaceRoot,
        workspaceSubdir: spec.workspaceSubdir ?? '',
        kind: spec.kind ?? 'container',
        image: spec.image,
        authMode: spec.authMode ?? 'oauth',
        env: spec.env ?? { plain: {}, secretKeys: [] },
        resources: spec.resources,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      };
    });
    // Identity moved from name → id. Mock accepts either: tests that
    // pre-set an id pass it directly; legacy tests that just pass a
    // name still find the matching workspace via the `id ?? name`
    // default applied above.
    ipcMain.handle('workspace:start', async (_e, id: string) => {
      g.__calls.start.push(id);
      const found = list.find((w) => w.id === id || w.name === id);
      if (!found) return null;
      return { ...found, state: 'running', containerId: found.containerId ?? `restarted-${found.id}` };
    });
    // Resume flow (Saved-tab Edit form) calls writeManifest before start.
    // No persistence — just record the call shape for assertions.
    ipcMain.handle('workspace:writeManifest', async (_e, spec: Record<string, unknown>) => {
      g.__calls.writeManifest.push(spec);
    });
    ipcMain.handle('workspace:stop', async (_e, containerId: string) => {
      g.__calls.stop.push(containerId);
    });
    ipcMain.handle('workspace:pause', async (_e, containerId: string) => {
      g.__calls.pause.push(containerId);
    });
    ipcMain.handle(
      'workspace:remove',
      async (_e, containerId: string, removeOpts: { deleteState?: boolean } | undefined) => {
        g.__calls.remove.push({ containerId, ...(removeOpts ?? {}) });
      }
    );
    // Vault mocks — record but no persistence. Tests assert against the
    // call list to verify Delete and secret-write flows.
    ipcMain.handle('vault:available', () => true);
    ipcMain.handle('vault:listKeys', (_e, _id: string) => []);
    ipcMain.handle('vault:getSecret', (_e, _id: string, _key: string) => null);
    ipcMain.handle('vault:setSecret', async (_e, id: string, key: string, value: string) => {
      g.__calls.vaultSetSecret.push({ id, key, value });
    });
    ipcMain.handle('vault:deleteSecret', async (_e, _id: string, _key: string) => undefined);
    ipcMain.handle(
      'vault:deleteAllForWorkspace',
      async (_e, id: string) => {
        g.__calls.vaultDeleteAllForWorkspace.push(id);
      }
    );
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
      (_e, workspaceId: string) => summaries[workspaceId] ?? null
    );
    const promptsByWs = opts.userPrompts ?? {};
    ipcMain.handle('userPrompts:list', (_e, workspaceId: string) => promptsByWs[workspaceId] ?? []);
    // Per-tab variant. Default matches the real server-side behavior:
    // null when no mapping is known. Tests that need to assert per-tab
    // routing pass observabilityPerTabSummaries=true.
    ipcMain.handle(
      'observability:summaryForBrokerSession',
      (_e, _workspaceId: string, brokerSessionId: string) => {
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
            topTools: [],
            recentToolCalls: [],
            costSeries: [0.002, 0.004, 0.006],
            pendingPrompt: false
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
