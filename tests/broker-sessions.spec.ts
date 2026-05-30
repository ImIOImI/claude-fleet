// broker_sessions mapping: pty:attach records a pending entry, the
// JsonlWatcher pairs it with the next JSONL that appears, and the
// IPC layer surfaces the per-tab summary via summaryForBrokerSession.
//
// All tests use the real DB + watcher (no mock backend) and reach
// into pendingAttaches via the test-only IPC handlers in
// src/main/ipc.ts (gated by CLAUDE_FLEET_E2E=1) — docker/broker
// itself can't be exercised in CI but the rest of the pipeline
// (watcher → IPC listener → DB) is exactly what production runs.

import { _electron as electron, test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, callTestIpc } from './_helpers.js';

function writeManifest(userDataDir: string, name: string): string {
  const stateDir = path.join(userDataDir, 'state', name);
  const projectsDir = path.join(stateDir, '.claude', 'projects', '-workspace');
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      name,
      workspaceRoot: '/tmp/fleet-test-' + name,
      workspaceSubdir: '',
      profile: 'oauth',
      kind: 'container',
      image: 'mock',
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );
  return projectsDir;
}

function writeAssistantJsonl(projectsDir: string, claudeSessionUuid: string, inputTokens = 1): void {
  writeFileSync(
    path.join(projectsDir, `${claudeSessionUuid}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-opus-4-7',
        content: [],
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          service_tier: 'standard'
        }
      }
    }) + '\n'
  );
}

async function launchRealBackend(userDataDir: string) {
  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
      ),
      // Enable the test-only IPC handlers so we can drive
      // recordPendingAttach without going through the real
      // docker/broker stack.
      CLAUDE_FLEET_E2E: '1'
    } as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

test('broker_sessions: a single pending attach is consumed and mapping is learned when claude writes its first JSONL', async () => {
  // The happy path: attachPty records a pending attach, claude spawns
  // and writes its first JSONL, JsonlWatcher emits 'new-session' on
  // first sighting, ipc.ts consumes the pending attach + persists
  // the mapping. If this fails, the mapping isn't being learned even
  // in the simple single-attach case.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-mapping-'));
  const wsName = 'first-tab-workspace';
  const projectsDir = writeManifest(userDataDir, wsName);

  const { app } = await launchRealBackend(userDataDir);

  try {
    const brokerSessionId = 'broker-main-tab-id-aaaaaaaa';
    await callTestIpc(app, '__test:recordPendingAttach', [wsName, brokerSessionId]);

    const claudeSessionUuid = randomUUID();
    writeAssistantJsonl(projectsDir, claudeSessionUuid, 123);

    await expect
      .poll(
        async () =>
          callTestIpc<string | null>(app, '__test:lookupBrokerSession', [wsName, brokerSessionId]),
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBe(claudeSessionUuid);
  } finally {
    await app.close();
  }
});

test('broker_sessions: mapping is learned even when the user types many minutes after attaching the tab', async () => {
  // The user's actual bug, reproduced from the real-instance error.log:
  //   17:16:07 — main (dc8b7689) attached
  //   17:20:37 — session 2 (c6fdb44e) attached — 4.5 min later
  //   17:22:03 — session 3 (bb5d5dd8) attached
  //   ...broker_sessions has c6fdb44e and bb5d5dd8 but NOT dc8b7689.
  //
  // Cause: claude doesn't write its first JSONL until the user types
  // in the session. Pending attaches had a 30s TTL, so by the time
  // the user got around to typing in "main" (4+ minutes after opening
  // the workspace), the pending entry had expired. The 'new-session'
  // event fired with no candidate → no mapping. Sessions 2 and 3
  // worked because the user typed in them within ~12-23 seconds of
  // attaching, well inside the old TTL.
  //
  // The fix: pending attaches must persist long enough for realistic
  // user behavior. This test asserts that a pending attach 60 seconds
  // old still pairs with the next JSONL.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-late-type-'));
  const wsName = 'late-type-workspace';
  const projectsDir = writeManifest(userDataDir, wsName);

  const { app } = await launchRealBackend(userDataDir);

  try {
    const brokerSessionId = 'broker-late-type-main-id-aaaaaaaa';

    // Simulate: user attached "main" 60 seconds ago (real-world:
    // opened a tab, walked away for a minute, came back). Under the
    // old 30s TTL this entry is expired by now; the fix must keep it
    // queued so the next JSONL pairs with it.
    const recordedAt = Date.now() - 60_000;
    await callTestIpc(app, '__test:recordPendingAttach', [wsName, brokerSessionId, recordedAt]);

    // Now user types. claude finally writes its first JSONL.
    const claudeSessionUuid = randomUUID();
    writeAssistantJsonl(projectsDir, claudeSessionUuid);

    await expect
      .poll(
        async () =>
          callTestIpc<string | null>(app, '__test:lookupBrokerSession', [wsName, brokerSessionId]),
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBe(claudeSessionUuid);
  } finally {
    await app.close();
  }
});

test('broker_sessions: multi-tab attaches that interleave with JSONL writes all get correct mappings (no concurrent-skip)', async () => {
  // When the user creates several tabs quickly, multiple pending
  // attaches are in flight simultaneously. Under the original
  // single-match rule these all got skipped (count != 1 → null);
  // the FIFO fix takes the oldest pending entry for each
  // 'new-session', pairing N attaches + N JSONLs correctly in order.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-multi-attach-'));
  const wsName = 'multi-tab-workspace';
  const projectsDir = writeManifest(userDataDir, wsName);

  const { app } = await launchRealBackend(userDataDir);

  try {
    const brokerMainId = 'broker-main-aaaaaaaaaaaaaaaaaaaaaaaa';
    const brokerS2Id = 'broker-sess2-bbbbbbbbbbbbbbbbbbbbbbbb';
    const brokerS3Id = 'broker-sess3-cccccccccccccccccccccccc';
    const claudeMainUuid = '11111111-1111-1111-1111-111111111111';
    const claudeS2Uuid = '22222222-2222-2222-2222-222222222222';
    const claudeS3Uuid = '33333333-3333-3333-3333-333333333333';

    // Three tabs created in quick succession — all pending attaches
    // land before any claude has written its first JSONL.
    await callTestIpc(app, '__test:recordPendingAttach', [wsName, brokerMainId]);
    await callTestIpc(app, '__test:recordPendingAttach', [wsName, brokerS2Id]);
    await callTestIpc(app, '__test:recordPendingAttach', [wsName, brokerS3Id]);

    // Write three JSONLs in the order the claudes spawned (broker
    // spawns in attach-order in the common case).
    writeAssistantJsonl(projectsDir, claudeMainUuid);
    writeAssistantJsonl(projectsDir, claudeS2Uuid);
    writeAssistantJsonl(projectsDir, claudeS3Uuid);

    await expect
      .poll(
        async () =>
          callTestIpc<string | null>(app, '__test:lookupBrokerSession', [wsName, brokerMainId]),
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBe(claudeMainUuid);
    expect(
      await callTestIpc<string | null>(app, '__test:lookupBrokerSession', [wsName, brokerS2Id])
    ).toBe(claudeS2Uuid);
    expect(
      await callTestIpc<string | null>(app, '__test:lookupBrokerSession', [wsName, brokerS3Id])
    ).toBe(claudeS3Uuid);
  } finally {
    await app.close();
  }
});

test('summaryForBrokerSession: returns null for an unmapped broker session (fresh tab — no workspace fallback)', async () => {
  // The IPC must NOT fall back to the workspace's most-recently-active
  // session when no broker→claude mapping exists. A brand-new tab the
  // user just opened legitimately has no data; returning the previous
  // tab's numbers via fallback was the "new session shows the last
  // session's info" bug.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-fresh-tab-'));
  const name = 'fresh-tab-test';
  const projectsDir = writeManifest(userDataDir, name);
  // Existing claude session with real data — the "previous tab" the
  // user was using before clicking "+" to add a new tab.
  const previousClaudeUuid = randomUUID();
  writeAssistantJsonl(projectsDir, previousClaudeUuid, 4242);

  const { app, window } = await launchRealBackend(userDataDir);

  try {
    // Wait for the watcher to ingest the existing JSONL so the
    // workspace summary has real data to fall back to (the bug we're
    // guarding against would surface this as the "fresh tab" summary).
    await expect
      .poll(
        async () => {
          return await window.evaluate(async (wsName) => {
            type Api = {
              api: { observability: { summaryForWorkspace: (n: string) => Promise<unknown> } };
            };
            const s = await (window as unknown as Api).api.observability.summaryForWorkspace(
              wsName
            );
            return s !== null;
          }, name);
        },
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBe(true);

    // Ask for a broker session id that has NO mapping. Pre-fix: returns
    // the workspace summary (4242 input tokens). Post-fix: null.
    const result = await window.evaluate(async (wsName) => {
      type Api = {
        api: {
          observability: {
            summaryForBrokerSession: (
              n: string,
              brokerSessionId: string
            ) => Promise<unknown>;
          };
        };
      };
      return await (window as unknown as Api).api.observability.summaryForBrokerSession(
        wsName,
        'completely-fresh-broker-id-with-no-mapping'
      );
    }, name);

    expect(result).toBeNull();
  } finally {
    await app.close();
  }
});
