// Read-only MCP server (#12) end-to-end: launch the real app (non-mock so the
// DB + MCP server start), seed a workspace manifest + a JSONL event for the
// watcher to ingest, then drive the Unix socket at <userData>/mcp/mcp.sock
// with newline-delimited JSON-RPC — exactly how the in-container reconnecting
// socat bridge will. Verifies initialize, tools/list, the typed read tools, and
// committee control, and the snapshot-scoped `query` tool (#174).

import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, RpcClient, connectMcp } from './_helpers.js';

/** Pull the JSON text out of an MCP tools/call result envelope. */
function toolText(res: { result?: unknown }): unknown {
  const content = (res.result as { content?: Array<{ text?: string }> })?.content;
  return content?.[0]?.text ? JSON.parse(content[0].text) : undefined;
}

test('MCP server: initialize, tools, typed reads, committee control', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'claude-fleet-mcp-'));
  const id = '01MCPTESTWS0000000000000WS';
  // A second workspace proves the per-workspace listener fan-out (#117): each
  // manifest gets its OWN socket at <userData>/mcp/<id>/mcp.sock at startup.
  const id2 = '01MCPTESTWS0000000000000W2';
  const stateDir = path.join(userDataDir, 'state', id);
  const projectsDir = path.join(stateDir, '.claude', 'projects', '-workspace');
  mkdirSync(projectsDir, { recursive: true });

  const seedManifest = (wsId: string, name: string, extra: Record<string, unknown> = {}): void => {
    mkdirSync(path.join(userDataDir, 'state', wsId), { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'state', wsId, 'workspace.json'),
      JSON.stringify({
        id: wsId,
        name,
        labels: [],
        workspaceRoot: '/tmp/fleet-mcp',
        workspaceSubdir: '',
        kind: 'container',
        image: 'mock',
        authMode: 'oauth',
        env: { plain: {}, secretKeys: [] },
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        ...extra
      })
    );
  };
  // `id` opts in as a reachable expert and names `id2` in acceptFrom (so it is
  // also discoverable in id2's roster); `id2` is a manager granted `read` over
  // it — so a committee_collect from id2's socket is permitted (#120).
  seedManifest(id, 'mcp-test-ws', {
    description: 'reviews auth',
    labels: ['security'],
    accessibility: { reachable: true, acceptFrom: [id2], roleHint: 'security' },
    installedLoadouts: [{ id: 'expert-security', title: 'Expert · Security', files: [], installedAt: 0 }]
  });
  seedManifest(id2, 'mcp-test-ws-2', { control: { canControl: [{ id, verbs: ['read'] }] } });

  const app: ElectronApplication = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
    ) as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  let client: RpcClient | null = null;
  try {
    // Seed an assistant event for the watcher to ingest into the DB.
    await new Promise((r) => setTimeout(r, 500));
    const sessionId = randomUUID();
    const event = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'hello from the expert' }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          service_tier: 'standard'
        }
      }
    };
    writeFileSync(path.join(projectsDir, `${sessionId}.jsonl`), JSON.stringify(event) + '\n');

    // Per-workspace socket (#117): the listener for the seeded manifest's id is
    // brought up at startup, exactly how the in-container bind reaches it.
    client = await connectMcp(id, userDataDir);

    // initialize
    const init = await client.call('initialize', { protocolVersion: '2024-11-05' });
    expect((init.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe('claude-fleet-state');

    // tools/list exposes the typed tools, the session_summary aggregator, and
    // the snapshot-scoped `query` tool (#174).
    const tools = await client.call('tools/list');
    const names = ((tools.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_sessions',
        'get_session',
        'get_cost',
        'list_events',
        'search_transcripts',
        'list_errors',
        'session_summary',
        'query',
        'committee_pause',
        'committee_unpause',
        'committee_roster',
        'signal_input_wait',
        'report_session_mapping',
        'mark_useful',
        'get_config'
      ])
    );

    // get_config surfaces the live host app version (#219) so a workspace can
    // tell what claude-fleet it's talking to — must match package.json.
    const pkgVersion = (
      JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
    ).version;
    const cfg = toolText(
      await client.call('tools/call', { name: 'get_config', arguments: {} })
    ) as { workspaceId?: string; app?: { version?: string } };
    expect(cfg.workspaceId).toBe(id);
    expect(cfg.app?.version).toBe(pkgVersion);

    // The watcher ingest is async — poll the typed list_sessions until the
    // seeded session lands. (This connection's caller id is `id`, which owns the
    // session, so scoped reads surface it.)
    await expect
      .poll(
        async () => {
          const res = await client!.call('tools/call', { name: 'list_sessions', arguments: {} });
          const rows = (toolText(res) as Array<{ id: string }>) ?? [];
          return rows.some((s) => s.id === sessionId);
        },
        { timeout: 8_000, intervals: [200, 500, 1000] }
      )
      .toBe(true);

    // committee_pause (#119) is wired through the async dispatch + injected
    // handler, and enforces assertControl: this connection's caller id is `id`
    // (the listener that accepted it), and `id2` never opted in (not reachable),
    // so the call is refused before any backend effect is reached.
    const cp = await client.call('tools/call', { name: 'committee_pause', arguments: { id: id2 } });
    const cpRes = cp.result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(cpRes.isError).toBe(true);
    expect(cpRes.content?.[0]?.text ?? '').toContain('control denied');

    // Per-workspace fan-out (#117): the second workspace has its OWN listener
    // at its OWN per-id socket path — a separate connection that initializes
    // independently, exactly how a sibling container's bind would reach it.
    const client2 = await connectMcp(id2, userDataDir);
    try {
      const init2 = await client2.call('initialize', { protocolVersion: '2024-11-05' });
      expect((init2.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe('claude-fleet-state');

      // committee_collect (#120) cross-workspace: id2 holds a `read` grant over
      // `id`, which opted in — so collecting from id2's socket returns id's
      // transcript turn (the seeded assistant text), cursored by events.id.
      const col = await client2.call('tools/call', { name: 'committee_collect', arguments: { id } });
      const collected = toolText(col) as {
        sessionId: string | null;
        cursor: number;
        turns: Array<{ role: string; text: string }>;
      };
      expect(collected.sessionId).toBe(sessionId);
      expect(collected.cursor).toBeGreaterThan(0);
      expect(collected.turns.some((t) => t.role === 'assistant' && t.text.includes('hello from the expert'))).toBe(
        true
      );

      // A second collect cursored past that turn returns nothing new.
      const col2 = await client2.call('tools/call', {
        name: 'committee_collect',
        arguments: { id, since: collected.cursor }
      });
      expect((toolText(col2) as { turns: unknown[] }).turns).toHaveLength(0);

      // committee_status (#121): id2 (read-granted) sees id's status. No live
      // container/attach in this harness ⇒ not paused, not busy; lastActiveAt
      // comes from the seeded session row.
      const st = await client2.call('tools/call', { name: 'committee_status', arguments: { id } });
      const status = toolText(st) as {
        paused: boolean;
        busy: boolean;
        lastActiveAt: number | null;
        name: string;
        roleHint?: string;
      };
      expect(status.paused).toBe(false);
      expect(status.busy).toBe(false);
      expect(typeof status.lastActiveAt).toBe('number');
      // Enriched status also carries the expert's metadata.
      expect(status.name).toBe('mcp-test-ws');
      expect(status.roleHint).toBe('security');

      // committee_roster (discovery): id2 sees `id` because it is reachable AND
      // names id2 in acceptFrom, with its metadata + a controllable grant.
      const ros = await client2.call('tools/call', { name: 'committee_roster', arguments: {} });
      const roster = toolText(ros) as Array<{
        id: string;
        roleHint?: string;
        description?: string;
        installedLoadouts: Array<{ id: string; title: string }>;
        grant: { controllable: boolean; verbs: string[] };
      }>;
      expect(roster).toHaveLength(1);
      expect(roster[0].id).toBe(id);
      expect(roster[0].roleHint).toBe('security');
      expect(roster[0].description).toBe('reviews auth');
      expect(roster[0].installedLoadouts).toEqual([{ id: 'expert-security', title: 'Expert · Security' }]);
      expect(roster[0].grant).toEqual({ controllable: true, verbs: ['read'] });

      // Conversely, the expert (caller `id`) holds no grants and no peer names
      // it, so its own roster is empty — discovery is acceptFrom-gated, per-caller.
      const rosExpert = await client.call('tools/call', { name: 'committee_roster', arguments: {} });
      expect(toolText(rosExpert) as unknown[]).toHaveLength(0);
    } finally {
      client2.close();
    }
  } finally {
    client?.close();
    await app.close();
  }
});
