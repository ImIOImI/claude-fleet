// ObservabilityPane content, slot consumers (chip subline + terminal
// context bar), and the live-push channel from the JsonlWatcher to
// the renderer. Mixed: most exercise mock-mode + mockMainIpc, but
// `Live push` needs the real watcher + DB and bypasses the mock IPC.

import { _electron as electron, test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launch, mockMainIpc, activePane, REPO_ROOT } from './_helpers.js';

test('Live push: renderer receives observability:summary push when watcher ingests a new JSONL line', async () => {
  // The JsonlWatcher emits 'ingest' after every batch that inserts ≥1
  // new event, ipc.ts computes the summary and broadcasts
  // `observability:summary` to every window. The renderer's
  // `window.api.observability.onSummary` callback receives
  // `(workspaceId, summary)` and updates the shared map.
  //
  // Test design: launch the app with a manifest but no JSONLs, subscribe
  // in the renderer (collecting received pushes into a window-scoped
  // array), then write a JSONL on disk. The push must arrive within
  // a reasonable window with the correct workspace name + non-null
  // summary derived from the line we just wrote.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-push-'));
  // State dir is keyed by id (ULID shape) so the startup migration treats
  // the manifest as already-current and doesn't rename the dir out from
  // under us. The display name is what the test reads from chips/UI; the
  // id is what observability + watcher key by.
  const id = '01TESTPUSH00000000000000WS';
  const name = 'push-test-ws';
  const stateDir = path.join(userDataDir, 'state', id);
  const projectsDir = path.join(stateDir, '.claude', 'projects', '-workspace');
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id,
      name,
      labels: [],
      workspaceRoot: '/tmp/fleet-test-' + name,
      workspaceSubdir: '',
      kind: 'container',
      image: 'mock',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
    ) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  try {
    // Subscribe in the renderer BEFORE writing the JSONL — the
    // subscription stashes every push into window.__pushes so the
    // test can poll for arrivals. We pull onSummary off window.api
    // (exposed by preload) and ignore its unsubscribe (page tears
    // down with the test).
    await window.evaluate(() => {
      type Api = {
        api: {
          observability: {
            onSummary: (
              cb: (workspaceId: string, summary: unknown) => void
            ) => () => void;
          };
        };
      };
      const w = window as unknown as Window & {
        __pushes: Array<{ workspaceId: string; summary: unknown }>;
      } & Api;
      w.__pushes = [];
      w.api.observability.onSummary((workspaceId, summary) => {
        w.__pushes.push({ workspaceId, summary });
      });
    });

    // Give the watcher a moment to fully start before writing —
    // chokidar can drop early add() calls if start() hasn't resolved.
    await new Promise((r) => setTimeout(r, 500));

    const sessionId = randomUUID();
    const event = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-opus-4-7',
        content: [],
        usage: {
          input_tokens: 123,
          output_tokens: 45,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          service_tier: 'standard'
        }
      }
    };
    writeFileSync(path.join(projectsDir, `${sessionId}.jsonl`), JSON.stringify(event) + '\n');

    // Push must arrive within ~8s — chokidar latency + ingest + IPC.
    await expect
      .poll(
        async () => {
          return await window.evaluate((targetId) => {
            const w = window as unknown as {
              __pushes: Array<{
                workspaceId: string;
                summary: { eventCount?: number; sessionId?: string } | null;
              }>;
            };
            return w.__pushes.find(
              (p) => p.workspaceId === targetId && p.summary !== null
            );
          }, id);
        },
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBeTruthy();

    // Verify the pushed summary actually reflects the line we wrote
    // (not just a null/empty arrival). eventCount must be ≥1, and the
    // sessionId must match the file we created.
    const latest = await window.evaluate((targetId) => {
      const w = window as unknown as {
        __pushes: Array<{
          workspaceId: string;
          summary: { eventCount?: number; sessionId?: string } | null;
        }>;
      };
      return w.__pushes
        .filter((p) => p.workspaceId === targetId && p.summary !== null)
        .pop();
    }, id);
    expect(latest?.summary?.sessionId).toBe(sessionId);
    expect(latest?.summary?.eventCount).toBeGreaterThanOrEqual(1);
  } finally {
    await app.close();
  }
});

test('Tool-call detail + cost series: ingest derives duration/status and per-turn cost', async () => {
  // Phase B data layer end-to-end through the real watcher + DB: a tool_use
  // matched to its tool_result yields name/input/duration/status, and an
  // assistant turn with usage yields a positive cost-series entry.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-tools-'));
  const id = '01TESTTOOLS0000000000000WS';
  const name = 'tools-test-ws';
  const stateDir = path.join(userDataDir, 'state', id);
  const projectsDir = path.join(stateDir, '.claude', 'projects', '-workspace');
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id,
      name,
      labels: [],
      workspaceRoot: '/tmp/fleet-test-' + name,
      workspaceSubdir: '',
      kind: 'container',
      image: 'mock',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
    ) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  try {
    await new Promise((r) => setTimeout(r, 500));

    const sessionId = randomUUID();
    const lines = [
      {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          model: 'claude-opus-4-8',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }]
        }
      },
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-01-01T00:00:02.400Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }] }
      },
      {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          model: 'claude-opus-4-8',
          content: [],
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            service_tier: 'standard'
          }
        }
      }
    ];
    writeFileSync(
      path.join(projectsDir, `${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    );

    // Poll until the watcher has ingested the tool_use (recentToolCalls fills).
    await expect
      .poll(
        async () =>
          window.evaluate(async (wsId) => {
            const s = await window.api.observability.summaryForWorkspace(wsId);
            return s?.recentToolCalls?.length ?? 0;
          }, id),
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBeGreaterThanOrEqual(1);

    const summary = await window.evaluate(
      (wsId) => window.api.observability.summaryForWorkspace(wsId),
      id
    );

    const calls = summary!.recentToolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'Bash',
      input: 'ls -la',
      durationMs: 2400,
      status: 'ok'
    });

    expect(summary!.costSeries.length).toBeGreaterThanOrEqual(1);
    expect(summary!.costSeries.some((c) => c > 0)).toBe(true);
  } finally {
    await app.close();
  }
});

test('User-prompt log: AskUserQuestion/ExitPlanMode surface with resolved status (#11)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-prompts-'));
  const id = '01TESTPROMPTS000000000WS';
  const name = 'prompts-test-ws';
  const stateDir = path.join(userDataDir, 'state', id);
  const projectsDir = path.join(stateDir, '.claude', 'projects', '-workspace');
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id, name, labels: [],
      workspaceRoot: '/tmp/fleet-test-' + name, workspaceSubdir: '',
      kind: 'container', image: 'mock', authMode: 'oauth',
      env: { plain: {}, secretKeys: [] }, createdAt: Date.now(), lastUsedAt: Date.now()
    })
  );

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
    ) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  try {
    await new Promise((r) => setTimeout(r, 500));
    const sessionId = randomUUID();
    const lines = [
      // AskUserQuestion, answered (a tool_result follows).
      {
        type: 'assistant', uuid: randomUUID(), timestamp: '2026-01-01T00:00:00.000Z',
        message: { model: 'claude-opus-4-8', content: [
          { type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Pick one' }] } }
        ] }
      },
      {
        type: 'user', uuid: randomUUID(), timestamp: '2026-01-01T00:00:05.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', is_error: false }] }
      },
      // ExitPlanMode, still pending (no tool_result).
      {
        type: 'assistant', uuid: randomUUID(), timestamp: '2026-01-01T00:00:10.000Z',
        message: { model: 'claude-opus-4-8', content: [
          { type: 'tool_use', id: 'toolu_plan', name: 'ExitPlanMode', input: { plan: 'do the thing' } }
        ] }
      }
    ];
    writeFileSync(
      path.join(projectsDir, `${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    );

    await expect
      .poll(
        async () =>
          window.evaluate(async (wsId) => {
            const r = await window.api.userPrompts.list(wsId);
            return r.length;
          }, id),
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBeGreaterThanOrEqual(2);

    const prompts = await window.evaluate((wsId) => window.api.userPrompts.list(wsId), id);
    const ask = prompts!.find((p) => p.kind === 'ask');
    const plan = prompts!.find((p) => p.kind === 'plan');
    expect(ask).toBeTruthy();
    expect(ask!.resolved).toBe(true);
    expect(plan).toBeTruthy();
    expect(plan!.resolved).toBe(false);
  } finally {
    await app.close();
  }
});

test('Cost sparkline: renders one bar per costSeries entry in the pane', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        { name: 'alpha', containerId: 'alpha-id', state: 'running', workspaceRoot: '/tmp/alpha' }
      ],
      // Per-tab summaries carry a 3-entry costSeries (see _helpers).
      observabilityPerTabSummaries: true
    });

    await window.locator('.ws-chip', { hasText: 'alpha' }).click();
    const obsPane = window.locator('.sidebar-right');
    await expect(obsPane.locator('.obs-title')).toBeVisible({ timeout: 5_000 });

    // One bar per costSeries entry.
    await expect(obsPane.locator('.obs-sparkline-bar')).toHaveCount(3);
  } finally {
    await app.close();
  }
});

test('Context bars: one row per terminal, active tab highlighted', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        { name: 'alpha', containerId: 'alpha-id', state: 'running', workspaceRoot: '/tmp/alpha' }
      ],
      observabilityPerTabSummaries: true
    });

    await window.locator('.ws-chip', { hasText: 'alpha' }).click();
    const obsPane = window.locator('.sidebar-right');
    await expect(obsPane.locator('.obs-title')).toBeVisible({ timeout: 5_000 });

    // The auto-created "main" terminal yields exactly one context row,
    // marked active.
    await expect(obsPane.locator('.obs-ctx-row')).toHaveCount(1, { timeout: 5_000 });
    await expect(obsPane.getByText(/Context · 1 terminal/)).toBeVisible();
    await expect(obsPane.locator('.obs-ctx-name.active')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test('Fleet scope: toggle shows aggregate cost + per-workspace rows', async () => {
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        { name: 'alpha', containerId: 'alpha-id', state: 'running', workspaceRoot: '/tmp/alpha' },
        { name: 'beta', containerId: 'beta-id', state: 'running', workspaceRoot: '/tmp/beta' }
      ],
      observabilitySummaries: {
        alpha: {
          sessionId: 's1', title: 'a', model: 'claude-opus-4-7',
          startedAt: Date.now(), lastActiveAt: Date.now(),
          eventCount: 3, inputTokens: 100, outputTokens: 50,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          usd: 0.05, lastTurnContextTokens: 1000, contextWindowTokens: 200_000,
          topTools: [], recentToolCalls: [], costSeries: []
        },
        beta: {
          sessionId: 's2', title: 'b', model: 'claude-opus-4-7',
          startedAt: Date.now(), lastActiveAt: Date.now(),
          eventCount: 3, inputTokens: 100, outputTokens: 50,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          usd: 0.15, lastTurnContextTokens: 1000, contextWindowTokens: 200_000,
          topTools: [], recentToolCalls: [], costSeries: []
        }
      }
    });

    const obsPane = window.locator('.sidebar-right');
    await window.getByRole('tab', { name: /Fleet/ }).click();

    // One row per workspace, and the aggregate cost (0.05 + 0.15).
    await expect(obsPane.locator('.obs-fleet-row')).toHaveCount(2);
    await expect(obsPane.locator('.obs-cost-amount')).toContainText('$0.20', { timeout: 5_000 });
    await expect(obsPane.locator('.obs-fleet-row', { hasText: 'beta' })).toContainText('$0.15');
  } finally {
    await app.close();
  }
});

test('Slot consumer: chip heights stay equal regardless of whether observability data is present', async () => {
  // Visual regression from the slot-consumers PR. The chip secondary
  // line (".ws-chip-sub" showing "active 2m ago" / "idle 1h ago") is
  // rendered only when summary.lastActiveAt is non-null. So a workspace
  // with observability data gets a TALLER chip than a workspace
  // without — the top strip looks jagged with mixed-height chips.
  //
  // The fix is to reserve the subline's space unconditionally
  // (placeholder element, min-height, or similar) so chip heights
  // stay consistent regardless of data presence.
  const { app, window } = await launch();
  try {
    const recent = Date.now() - 30_000;
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'with-data',
          containerId: 'with-id',
          state: 'running',
          workspaceRoot: '/tmp/with',
        },
        {
          name: 'no-data',
          containerId: 'no-id',
          state: 'running',
          workspaceRoot: '/tmp/no',
        }
      ],
      observabilitySummaries: {
        'with-data': {
          sessionId: 'sess-1',
          title: 'demo',
          model: 'claude-opus-4-7',
          startedAt: recent - 60_000,
          lastActiveAt: recent,
          eventCount: 5,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          usd: 0.01,
          lastTurnContextTokens: 10_000,
          contextWindowTokens: 200_000,
          topTools: []
        }
        // no-data: summary is missing (null) → no activity text
      }
    });

    const withChip = window.locator('.ws-chip', { hasText: 'with-data' });
    const noChip = window.locator('.ws-chip', { hasText: 'no-data' });
    await expect(withChip).toBeVisible({ timeout: 5_000 });
    await expect(noChip).toBeVisible({ timeout: 5_000 });

    // Give the polling effect a beat to apply the summary so the
    // sub-line lands in with-data's chip.
    await expect(withChip.locator('.ws-chip-sub')).toBeVisible({ timeout: 5_000 });

    const withHeight = await withChip.evaluate(
      (el) => (el as HTMLElement).getBoundingClientRect().height
    );
    const noHeight = await noChip.evaluate(
      (el) => (el as HTMLElement).getBoundingClientRect().height
    );

    // Heights should be identical. Off-by-1 from sub-pixel rounding
    // is tolerable; >1px difference means the subline conditionally
    // pushes the chip taller.
    expect(Math.abs(withHeight - noHeight)).toBeLessThanOrEqual(1);
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
          contextWindowTokens: 200_000,
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
  // CSS variable should be `(lastTurnContextTokens / contextWindowTokens)
  // * 100`, clamped to [0, 100]. When summary is missing, falls back to
  // 100% (pure identity band, the pre-observability behavior).
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'alpha',
          containerId: 'alpha-id',
          state: 'running',
          workspaceRoot: '/tmp/alpha',
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
          contextWindowTokens: 200_000,
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

test('ObservabilityPane: clicking + on a workspace clears the pane to empty (no inheritance from previous tab)', async () => {
  // Regression for: "when I open a new session in a workspace it shows
  // me the information from the last session I used". The renderer
  // must NOT surface the workspace fallback for freshly-added tabs —
  // they legitimately have no data, and showing the previous tab's
  // numbers is confusing.
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'alpha',
          containerId: 'alpha-id',
          state: 'running',
          workspaceRoot: '/tmp/alpha',
        }
      ],
      observabilitySummaries: {
        alpha: {
          sessionId: 'previous-claude-uuid',
          title: 'PREVIOUS-SESSION-TITLE',
          model: 'claude-opus-4-7',
          startedAt: Date.now() - 60_000,
          lastActiveAt: Date.now() - 5_000,
          eventCount: 99,
          inputTokens: 4242,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          usd: 0.05,
          lastTurnContextTokens: 4242,
          contextWindowTokens: 200_000,
          topTools: []
        }
      }
    });

    await window.locator('.ws-chip', { hasText: 'alpha' }).click();
    const strip = activePane(window).locator('.session-tab-strip');
    await expect(strip).toBeVisible();
    await expect(strip.locator('.session-tab')).toHaveCount(1);

    const obsPane = window.locator('.sidebar-right');

    // The bug repro: click + to add a fresh tab.
    await strip.getByRole('button', { name: 'New session' }).click();
    await expect(strip.locator('.session-tab')).toHaveCount(2);

    // The fix: pane must show the empty state — NOT inherit
    // "PREVIOUS-SESSION-TITLE" from the workspace fallback.
    await expect(obsPane.locator('.pane-placeholder')).toContainText(
      /No transcript events yet/i,
      { timeout: 5_000 }
    );
    await expect(obsPane.locator('.obs-title')).not.toBeAttached();
  } finally {
    await app.close();
  }
});

test('ObservabilityPane: switching between two loaded-from-inventory tabs surfaces the active tab, not the workspace fallback', async () => {
  // Regression: "now changing tabs doesn't update the sidepanel". This
  // reproduces the user's actual scenario — multiple tabs already exist
  // in sessions.json (loaded from inventory, isFresh=false), and none
  // have a broker→claude mapping yet. Before the fix: both unmapped
  // tabs fall back to the workspace summary → identical pane content.
  // After the fix: pane shows the empty state on both, switching
  // remains in the empty state.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-bug-b-'));
  const wsName = 'alpha';
  const stateDir = path.join(userDataDir, 'state', wsName);
  mkdirSync(stateDir, { recursive: true });
  const tab1Id = 'loaded-tab-1-' + randomUUID();
  const tab2Id = 'loaded-tab-2-' + randomUUID();
  writeFileSync(
    path.join(stateDir, 'sessions.json'),
    JSON.stringify({
      version: 1,
      sessions: [
        { id: tab1Id, name: 'main', createdAt: Date.now() - 60_000 },
        { id: tab2Id, name: 'session 2', createdAt: Date.now() - 30_000 }
      ],
      nextNum: 3,
      activeId: tab1Id
    })
  );

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: { ...process.env, CLAUDE_FLEET_MOCK: '1' } as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  try {
    // Default per-tab mock (returns null) — simulates the real
    // unmapped-tab scenario. Workspace summary returns identifiable
    // fallback data so the failure mode would be clearly visible.
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: wsName,
          containerId: 'alpha-id',
          state: 'running',
          workspaceRoot: '/tmp/alpha',
        }
      ],
      observabilitySummaries: {
        [wsName]: {
          sessionId: 'workspace-fallback-uuid',
          title: 'WORKSPACE-FALLBACK-TITLE',
          model: 'claude-opus-4-7',
          startedAt: Date.now() - 60_000,
          lastActiveAt: Date.now() - 5_000,
          eventCount: 7,
          inputTokens: 7777,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          usd: 0.05,
          lastTurnContextTokens: 7777,
          contextWindowTokens: 200_000,
          topTools: []
        }
      }
    });

    await window.locator('.ws-chip', { hasText: wsName }).click();
    const strip = activePane(window).locator('.session-tab-strip');
    const tabs = strip.locator('.session-tab');
    await expect(tabs).toHaveCount(2, { timeout: 5_000 });

    const obsPane = window.locator('.sidebar-right');

    await expect(obsPane.locator('.pane-placeholder')).toContainText(
      /No transcript events yet/i,
      { timeout: 5_000 }
    );
    await expect(obsPane.locator('.obs-title')).not.toBeAttached();

    // Switching tabs must keep us in the empty state, not flicker the
    // workspace fallback back in.
    await tabs.nth(1).click();
    await expect(obsPane.locator('.pane-placeholder')).toContainText(
      /No transcript events yet/i,
      { timeout: 5_000 }
    );
    await expect(obsPane.locator('.obs-title')).not.toBeAttached();
  } finally {
    await app.close();
  }
});

test('ObservabilityPane: switching tabs refetches and updates the pane to the focused tab', async () => {
  // The per-tab fetch in App.tsx must re-run whenever the active tab id
  // changes, and the result must replace the rendered summary. Mock
  // summaryForBrokerSession to return a summary whose title encodes the
  // broker session id — so on tab switch, the title must change to the
  // new id's tag.
  const { app, window } = await launch();
  try {
    await mockMainIpc(app, {
      workspaceList: [
        {
          name: 'alpha',
          containerId: 'alpha-id',
          state: 'running',
          workspaceRoot: '/tmp/alpha',
        }
      ],
      // Per-tab routing on — each call returns Tab-<8-char id prefix>.
      observabilityPerTabSummaries: true
    });

    await window.locator('.ws-chip', { hasText: 'alpha' }).click();
    const strip = activePane(window).locator('.session-tab-strip');
    const tabs = strip.locator('.session-tab');
    await expect(tabs).toHaveCount(1);

    const obsPane = window.locator('.sidebar-right');
    await expect(obsPane.locator('.obs-title')).toBeVisible({ timeout: 5_000 });
    const titleOnTab1 = await obsPane.locator('.obs-title').textContent();
    expect(titleOnTab1).toMatch(/^Tab-/);

    // Add a second tab — focus moves to it, pane re-fetches.
    await strip.getByRole('button', { name: 'New session' }).click();
    await expect(tabs).toHaveCount(2);

    // The title must change to the new tab's tag.
    await expect
      .poll(async () => obsPane.locator('.obs-title').textContent(), {
        timeout: 5_000,
        intervals: [100, 250, 500]
      })
      .not.toBe(titleOnTab1);
    const titleOnTab2 = await obsPane.locator('.obs-title').textContent();
    expect(titleOnTab2).toMatch(/^Tab-/);

    // Click back to the first tab — pane must update back to its title.
    await tabs.nth(0).click();
    await expect(obsPane.locator('.obs-title')).toHaveText(titleOnTab1!, {
      timeout: 5_000
    });
  } finally {
    await app.close();
  }
});
