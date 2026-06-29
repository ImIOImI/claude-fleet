// ai_title ingest -> display, and the first_user_message noise skip, against
// the real DB + watcher. Seed two workspaces-worth of transcript on disk,
// launch the real app (no mock — mock disables the watcher + DB), and read the
// session rows back through window.api.sessions.list.
//
// Regression net for two invariants:
//  - Claude Code's native `ai-title` transcript line populates sessions.ai_title
//    (the title rides on an undocumented native CC line type; a `claude` pin
//    bump that drops it should fail here — see SPEC.md §7/§11).
//  - A `/clear`-style synthetic command-wrapper user message is NOT captured as
//    first_user_message; the first real prompt wins (userPromptText.ts).

import { _electron as electron, test, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

interface SessionListItem {
  id: string;
  workspaceId: string;
  aiTitle: string | null;
  firstUserMessage: string | null;
}

function listSessions(window: Page, workspaceId?: string): Promise<SessionListItem[]> {
  return window.evaluate(
    (wsId) =>
      (window as unknown as {
        api: { sessions: { list: (id?: string) => Promise<SessionListItem[]> } };
      }).api.sessions.list(wsId),
    workspaceId
  );
}

const SYNTHETIC_USER_BLOB =
  '<local-command-caveat>Caveat: messages below were generated while running ' +
  'local commands. DO NOT respond to these.</local-command-caveat>\n' +
  '<command-name>/clear</command-name>\n<command-message>clear</command-message>';

const REAL_PROMPT_A = 'Investigate why the flaky test intermittently fails';
const REAL_PROMPT_B = 'Add a retry around the network call';
const AI_TITLE_A = 'Investigate flaky test failure';

function writeWorkspace(userDataDir: string, wsId: string, name: string): string {
  const stateDir = path.join(userDataDir, 'state', wsId);
  const jsonlDir = path.join(stateDir, '.claude', 'projects', '-workspace');
  mkdirSync(jsonlDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id: wsId,
      name,
      labels: [],
      workspaceRoot: `/tmp/fleet-test-${name}`,
      workspaceSubdir: '',
      kind: 'container',
      image: 'mock',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );
  return jsonlDir;
}

function writeTranscript(jsonlDir: string, sessionId: string, lines: object[]): void {
  writeFileSync(
    path.join(jsonlDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  );
}

function userLine(content: string): object {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content } };
}
function assistantLine(): object {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      model: 'claude-opus-4-8',
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        service_tier: 'standard'
      }
    }
  };
}

test('ai-title populates the title; a synthetic command-wrapper is skipped for first_user_message', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-aititle-'));
  // 26-char Crockford-base32 ids so the startup migration treats them as
  // already-migrated and leaves the state dirs alone.
  const wsId = '01TESTAITITLE0000000000000';

  const jsonlDir = writeWorkspace(userDataDir, wsId, 'aititle-ws');

  // Session A: synthetic wrapper first, then a real last-prompt, then ai-title.
  const sessionA = '11111111-1111-4111-8111-111111111111';
  writeTranscript(jsonlDir, sessionA, [
    userLine(SYNTHETIC_USER_BLOB),
    { type: 'last-prompt', lastPrompt: REAL_PROMPT_A, sessionId: sessionA },
    { type: 'ai-title', aiTitle: AI_TITLE_A, sessionId: sessionA },
    assistantLine()
  ]);

  // Session B: same noise, real prompt, but NO ai-title line.
  const sessionB = '22222222-2222-4222-8222-222222222222';
  writeTranscript(jsonlDir, sessionB, [
    userLine(SYNTHETIC_USER_BLOB),
    { type: 'last-prompt', lastPrompt: REAL_PROMPT_B, sessionId: sessionB },
    assistantLine()
  ]);

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
    await expect
      .poll(async () => (await listSessions(window, wsId)).length, {
        timeout: 8_000,
        intervals: [200, 500, 1000]
      })
      .toBe(2);

    const rows = await listSessions(window, wsId);
    const a = rows.find((r) => r.id === sessionA);
    const b = rows.find((r) => r.id === sessionB);

    // Session A: ai-title populated the title; the synthetic blob was skipped.
    expect(a?.aiTitle).toBe(AI_TITLE_A);
    expect(a?.firstUserMessage).toBe(REAL_PROMPT_A);

    // Session B: no ai-title -> null; the real prompt (not the blob) is the
    // first_user_message fallback.
    expect(b?.aiTitle).toBeNull();
    expect(b?.firstUserMessage).toBe(REAL_PROMPT_B);
  } finally {
    await app.close();
  }
});
