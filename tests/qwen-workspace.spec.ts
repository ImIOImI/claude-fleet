// Task 13: e2e — qwen workspace boots against endpoint, env vars surface in terminal.
//
// REALITY CHECK — the local-qwen guard:
// ─────────────────────────────────────
// attachLocalSession (src/main/localSessions.ts:159) currently THROWS:
//   "qwen-code harness is not yet supported for local workspaces"
// when harness:'qwen-code' is passed. This guard was introduced in Task 3
// (deferred binary resolution). A local-backend e2e that seeds a qwen
// workspace and tries to attach a PTY will hit this throw before the stub
// process is ever spawned.
//
// Approach taken: OPTION (a) — assert the CURRENT guarded behavior:
//   • The "guarded behavior" test seeds a local qwen workspace and attempts
//     to resume it. It asserts that the error surfaces (app error log or
//     chip stays stopped / absent) rather than the terminal showing the stub
//     output. This proves the guard is live and the e2e is honest.
//   • The "happy path" test is marked test.fixme with a clear comment:
//     it describes the FULL happy-path assertion (env vars in terminal) and
//     is explicitly skipped until Task 5 removes the guard and wires real
//     qwen binary resolution for local workspaces.
//
// Why not option (b) (container-backed e2e)?
//   The existing container e2e specs (local-backend.spec.ts, endpoint-workspace.spec.ts)
//   all use CLAUDE_FLEET_LOCAL_CLAUDE_BIN to run stubs without Docker. There is no
//   container-backed qwen image available in CI at this stage. Attempting to use the
//   real Docker path would require a qwen image pull, a sidecar process, and a real
//   qwen binary — none of which are present. Option (a) is the only honest choice.

import { _electron as electron, test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, waitForLogEntry } from './_helpers.js';

// ── Shared seed helper ─────────────────────────────────────────────────────

function seedQwenWorkspace(userDataDir: string): { id: string; epId: string } {
  const id = '01QWENE2ETEST000000000000W';
  const epId = 'ep-qwen-e2e-1';

  writeFileSync(
    path.join(userDataDir, 'endpoints.json'),
    JSON.stringify([
      {
        id: epId,
        name: 'qwen-e2e-fake',
        baseUrl: 'http://127.0.0.1:59997',
        modelId: 'qwen3-coder:30b',
        hasApiKey: false
      }
    ])
  );

  const stateDir = path.join(userDataDir, 'state', id);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id,
      name: 'qwen-e2e',
      labels: [],
      workspaceRoot: tmpdir(),
      workspaceSubdir: '',
      kind: 'local',
      authMode: 'endpoint',
      endpointId: epId,
      harness: 'qwen-code',
      env: { plain: {}, secretKeys: [] },
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );

  return { id, epId };
}

// ── Test 1: guarded behavior ───────────────────────────────────────────────
// Asserts that the CURRENT guard ("qwen-code harness is not yet supported for
// local workspaces") fires when resuming a qwen local workspace. The chip must
// NOT transition to a running state that shows a live PTY — either the resume
// fails silently (chip stays in Saved tab) or an error is logged.

test('qwen local workspace: resume hits the guard (not yet supported for local workspaces)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'fleet-qwen-guard-'));
  seedQwenWorkspace(userDataDir);

  const stubPath = path.resolve(import.meta.dirname, 'fixtures', 'qwen-stub.mjs');
  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_FLEET_LOCAL_CLAUDE_BIN: process.execPath,
      CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS: stubPath
    } as Record<string, string>
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // The seeded workspace starts in 'stopped' state; open Add-workspace modal
    // and navigate to the Saved tab to resume it.
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    await expect(window.getByRole('tab', { name: 'Saved' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const row = window.locator('.saved-row', { hasText: 'qwen-e2e' });
    await expect(row).toBeVisible({ timeout: 8_000 });
    await row.locator('.saved-row-header').click();
    await row.getByRole('button', { name: 'Resume' }).click();

    // The guard throws inside attachLocalSession → ipc.ts:attachPty catch
    // logs type:'pty-attach-failed' with message:
    //   "pty:attach failed: qwen-code harness is not yet supported for local workspaces"
    // Assert the log entry arrives, proving the guard fired and no PTY was spawned.
    await waitForLogEntry(
      userDataDir,
      (e) =>
        e.type === 'pty-attach-failed' &&
        typeof e.message === 'string' &&
        e.message.includes('qwen-code'),
      10_000
    );
  } finally {
    await app.close();
  }
});

// ── Test 2: happy path (SKIPPED until Task 5 removes the guard) ───────────
// When the qwen binary resolution guard is removed (Task 5) and a real
// `qwen` binary (or stub) can be launched for local workspaces, this test
// should resume the workspace and assert:
//   1. The chip appears in the running strip ("qwen-e2e").
//   2. Clicking the chip shows the terminal pane.
//   3. The terminal contains OPENAI_BASE_URL=…/v1 (endpoint base + /v1 suffix).
//   4. The terminal contains OPENAI_MODEL=qwen3-coder:30b.
//
// Until then it is fixme'd so CI doesn't treat it as a missing test.

// eslint-disable-next-line @typescript-eslint/no-empty-function
test.fixme(
  'qwen local workspace: compiled OpenAI env surfaces in terminal (needs Task 5 — guard removal)',
  async () => {
    // FIXME: remove test.fixme once:
    //   • localSessions.ts:159 guard is removed (Task 5)
    //   • qwen binary resolution for local workspaces is implemented
    //   • CLAUDE_FLEET_LOCAL_CLAUDE_BIN + qwen-stub.mjs works end-to-end
    //
    // Implementation sketch (mirrors endpoint-workspace.spec.ts):
    //
    //   const userDataDir = mkdtempSync(path.join(tmpdir(), 'fleet-qwen-e2e-'));
    //   seedQwenWorkspace(userDataDir);
    //   const stubPath = path.resolve(import.meta.dirname, 'fixtures', 'qwen-stub.mjs');
    //   const app = await electron.launch({
    //     args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    //     cwd: REPO_ROOT,
    //     env: {
    //       ...process.env,
    //       CLAUDE_FLEET_LOCAL_CLAUDE_BIN: process.execPath,
    //       CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS: stubPath
    //     } as Record<string, string>
    //   });
    //   try {
    //     const window = await app.firstWindow();
    //     await window.waitForLoadState('domcontentloaded');
    //     await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    //     await expect(window.getByRole('tab', { name: 'Saved' })).toHaveAttribute('aria-selected', 'true');
    //     const row = window.locator('.saved-row', { hasText: 'qwen-e2e' });
    //     await expect(row).toBeVisible({ timeout: 8_000 });
    //     await row.locator('.saved-row-header').click();
    //     await row.getByRole('button', { name: 'Resume' }).click();
    //     await expect(window.locator('.ws-chip .name', { hasText: 'qwen-e2e' })).toBeVisible({ timeout: 10_000 });
    //     await window.locator('.ws-chip', { hasText: 'qwen-e2e' }).click();
    //     await expect(
    //       window.locator('.terminal-pane:not([aria-hidden="true"]) .terminal-host')
    //     ).toBeVisible({ timeout: 8_000 });
    //     const termRows = window.locator('.terminal-pane:not([aria-hidden="true"]) .xterm-rows');
    //     // endpointEnv for qwen-code appends /v1 to baseUrl:
    //     await expect(termRows).toContainText('OPENAI_BASE_URL=http://127.0.0.1:59997/v1', { timeout: 20_000 });
    //     await expect(termRows).toContainText('OPENAI_MODEL=qwen3-coder:30b');
    //   } finally {
    //     await app.close();
    //   }
  }
);
