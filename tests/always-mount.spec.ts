// Always-mounted TerminalPanes per workspace — regression guards for
// "claude scrollback corruption" (attach before fit), "cross-workspace
// data bleed" (xterm content leaking), "css visibility cascade" (every
// pane painted simultaneously), tab-list leaks, and the attach-error
// overlay for broker-socket failures.

import { test, expect } from '@playwright/test';
import { launch, activePane, waitForLogEntry } from './_helpers.js';

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
    // mock-beta seeds as `stopped`, so clicking it shows the Start overlay
    // (#17); wake it so its terminal mounts.
    await window.locator('.ws-chip', { hasText: 'mock-beta' }).click();
    await window.getByRole('button', { name: 'Start' }).click();
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
    // mock-beta seeds as `stopped` (no terminal until started, #17). Wake it
    // so all three workspaces have mounted xterms for the visibility check.
    await window.locator('.ws-chip', { hasText: 'mock-beta' }).click();
    await window.getByRole('button', { name: 'Start' }).click();
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
  // a misuse of workspaceId in the persist effect could cause workspace
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

    // Switch to mock-beta and wake it (seeds stopped, #17). Its tab strip
    // must still have exactly one "main" tab — alpha's add MUST NOT have
    // leaked into beta.
    await window.locator('.ws-chip', { hasText: 'mock-beta' }).click();
    await window.getByRole('button', { name: 'Start' }).click();
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
