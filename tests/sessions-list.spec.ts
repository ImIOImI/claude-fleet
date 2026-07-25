// Sessions table (#3) against the real DB + watcher: seed a workspace
// manifest + a transcript on disk, launch the real app (no mock — mock
// disables the watcher + DB), and exercise the list / rename / delete IPC
// through window.api. The renderer surface (SessionsPane) reads exactly
// this data.

import { _electron as electron, test, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

interface SessionListItem {
  id: string;
  workspaceId: string;
  firstUserMessage: string | null;
  userSetName: string | null;
  eventCount: number;
  usd: number;
  workspaceName: string;
  tags: string[];
}

// Thin window.api.sessions wrappers, run in the renderer page context.
function listSessions(window: Page, workspaceId?: string): Promise<SessionListItem[]> {
  return window.evaluate(
    (wsId) =>
      (window as unknown as {
        api: { sessions: { list: (id?: string) => Promise<SessionListItem[]> } };
      }).api.sessions.list(wsId),
    workspaceId
  );
}
function renameSession(window: Page, id: string, name: string): Promise<void> {
  return window.evaluate(
    ([sid, n]) =>
      (window as unknown as {
        api: { sessions: { rename: (i: string, nm: string) => Promise<void> } };
      }).api.sessions.rename(sid, n),
    [id, name] as const
  );
}
function deleteSession(window: Page, workspaceId: string, id: string): Promise<void> {
  return window.evaluate(
    ([wsId, sid]) =>
      (window as unknown as {
        api: { sessions: { delete: (w: string, i: string) => Promise<void> } };
      }).api.sessions.delete(wsId, sid),
    [workspaceId, id] as const
  );
}

test('Sessions table: list reflects the seeded transcript; rename + delete round-trip', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-sessions-'));
  // 26-char Crockford-base32 id so the startup migration treats it as
  // already-migrated and leaves the state dir alone.
  const wsId = '01TESTSESSIONS000000000000';
  const stateDir = path.join(userDataDir, 'state', wsId);
  const jsonlDir = path.join(stateDir, '.claude', 'projects', '-workspace');
  mkdirSync(jsonlDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id: wsId,
      name: 'sessions-ws',
      labels: [],
      workspaceRoot: '/tmp/fleet-test-sessions',
      workspaceSubdir: '',
      kind: 'container',
      image: 'mock',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );

  const sessionId = randomUUID();
  const lines = [
    {
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: { content: 'Investigate the flaky test' }
    },
    {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
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
    },
    { type: 'session-summary', summary: 'Seeded for the tags e2e.', tags: ['e2e-tag', 'seeded'] }
  ];
  writeFileSync(
    path.join(jsonlDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  );

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    // Drop CLAUDE_FLEET_MOCK so the real watcher + DB run.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
    ) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  try {
    // Wait for the watcher to ingest the seeded transcript.
    await expect
      .poll(async () => (await listSessions(window, wsId)).length, {
        timeout: 8_000,
        intervals: [200, 500, 1000]
      })
      .toBe(1);

    let rows = await listSessions(window, wsId);
    expect(rows[0].id).toBe(sessionId);
    expect(rows[0].firstUserMessage).toBe('Investigate the flaky test');
    expect(rows[0].workspaceName).toBe('sessions-ws');
    expect(rows[0].eventCount).toBe(2);
    expect(rows[0].usd).toBeGreaterThan(0);
    expect(rows[0].userSetName).toBeNull();

    // Tags from the summary chapter ride the sessions:list payload (#spec:
    // sessions-open-group-and-tags). Order preserved from the summarizer.
    expect(rows[0].tags).toEqual(['e2e-tag', 'seeded']);

    // With no live terminal tab mapped to this session, the pane shows no
    // Open group — every row is plain "Recent" (no group headers at all
    // when the Open group is empty).
    // Positive control: the pane is rendered with the seeded row — the
    // zero-counts below assert an empty Open group, not an empty DOM.
    await expect(window.locator('.session-row')).toHaveCount(1);
    await expect(window.locator('.session-group-label')).toHaveCount(0);
    await expect(window.locator('.session-row.open')).toHaveCount(0);

    // The global list (no workspace filter) also surfaces it.
    expect((await listSessions(window)).some((r) => r.id === sessionId)).toBe(true);

    // Rename sets the override; empty clears it.
    await renameSession(window, sessionId, 'My session');
    rows = await listSessions(window, wsId);
    expect(rows[0].userSetName).toBe('My session');
    await renameSession(window, sessionId, '  ');
    rows = await listSessions(window, wsId);
    expect(rows[0].userSetName).toBeNull();

    // Delete drops it from the list.
    await deleteSession(window, wsId, sessionId);
    await expect
      .poll(async () => (await listSessions(window, wsId)).length, { timeout: 4_000 })
      .toBe(0);
  } finally {
    await app.close();
  }
});
