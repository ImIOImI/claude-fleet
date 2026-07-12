// Cross-workspace read scoping (#122/#146). Launches the real app with two
// workspaces — A (a reachable expert) and B (a manager granted `read` over A).
// Reads are workspace-scoped by default (no flag): A (no grants) sees only its
// own sessions, never B's; B sees its own + A's; and the `query` tool runs only
// against a per-call snapshot of the caller's allowed rows, so even arbitrary
// read-only SQL can't escape the scope (#174). This is the #146 isolation guarantee.

import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, RpcClient, connectMcp } from './_helpers.js';

function toolText(res: { result?: unknown }): unknown {
  const content = (res.result as { content?: Array<{ text?: string }> })?.content;
  return content?.[0]?.text ? JSON.parse(content[0].text) : undefined;
}

test('scoped reads: caller sees own + read-granted sessions only; no query tool (#146)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-scoped-'));
  const A = '01SCOPEDAAAAAAAAAAAAAAAAAA';
  const B = '01SCOPEDBBBBBBBBBBBBBBBBBB';

  const seed = (id: string, name: string, extra: Record<string, unknown>): string => {
    const proj = path.join(userDataDir, 'state', id, '.claude', 'projects', '-workspace');
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'state', id, 'workspace.json'),
      JSON.stringify({
        id, name, labels: [], workspaceRoot: '/tmp/fleet', workspaceSubdir: '',
        kind: 'container', image: 'mock', authMode: 'oauth',
        env: { plain: {}, secretKeys: [] }, createdAt: Date.now(), lastUsedAt: Date.now(), ...extra
      })
    );
    // One assistant event so each workspace has an ingestable session.
    const sessionId = randomUUID();
    writeFileSync(
      path.join(proj, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(),
        message: { model: 'claude-opus-4-7', content: [{ type: 'text', text: `from ${name}` }], usage: { input_tokens: 5, output_tokens: 1 } }
      }) + '\n'
    );
    return sessionId;
  };

  const sessionA = seed(A, 'ws-a', { accessibility: { reachable: true } });
  const sessionB = seed(B, 'ws-b', { control: { canControl: [{ id: A, verbs: ['read'] }] } });

  const app: ElectronApplication = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
    ) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const clients: RpcClient[] = [];
  try {
    await new Promise((r) => setTimeout(r, 800)); // let the watcher ingest both sessions

    const listSessionIds = async (sockId: string): Promise<string[]> => {
      const c = await connectMcp(sockId, userDataDir);
      clients.push(c);
      await c.call('initialize', { protocolVersion: '2024-11-05' });
      // poll until ingest has landed
      for (let i = 0; i < 20; i++) {
        const res = await c.call('tools/call', { name: 'list_sessions', arguments: {} });
        const rows = (toolText(res) as Array<{ id: string }>) ?? [];
        if (rows.length > 0) return rows.map((r) => r.id);
        await new Promise((r) => setTimeout(r, 300));
      }
      return [];
    };

    // A holds no grants → sees only its own session, never B's.
    const aSees = await listSessionIds(A);
    expect(aSees).toContain(sessionA);
    expect(aSees).not.toContain(sessionB);

    // B is read-granted over the (reachable) A → sees both its own and A's.
    const bSees = await listSessionIds(B);
    expect(bSees).toContain(sessionB);
    expect(bSees).toContain(sessionA);

    // The `query` tool exists but is snapshot-scoped (#174): from A's socket
    // (no grants) it can only ever see A's own rows — never B's — because A's
    // per-call snapshot is seeded with A's workspace rows only. So even raw
    // read-only SQL cannot escape the scope (#146).
    const qc = await connectMcp(A, userDataDir);
    clients.push(qc);
    await qc.call('initialize', { protocolVersion: '2024-11-05' });
    const tools = await qc.call('tools/list');
    const names = (tools.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('query');

    const qres = await qc.call('tools/call', {
      name: 'query',
      arguments: { sql: 'SELECT id FROM sessions' }
    });
    const qIds = ((toolText(qres) as Array<{ id: string }>) ?? []).map((r) => r.id);
    expect(qIds).toContain(sessionA);
    expect(qIds).not.toContain(sessionB);
  } finally {
    clients.forEach((c) => c.close());
    await app.close();
  }
});
