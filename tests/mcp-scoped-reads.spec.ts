// Scoped MCP reads (#122). Launches the real app with CLAUDE_FLEET_SCOPED_READS=1
// and two workspaces — A (a reachable expert) and B (a manager granted `read`
// over A). With scoping ON, A (no grants) sees only its own sessions, B sees its
// own + A's, and the raw `query` hatch is disabled. (Flag OFF — the default,
// current fleet-global behavior — stays covered by mcp-server.spec.ts.)

import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_helpers.js';

class RpcClient {
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  constructor(private sock: Socket) {
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
      }
    });
  }
  call(method: string, params?: unknown): Promise<{ result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  close(): void {
    this.sock.destroy();
  }
}

async function connectWithRetry(sockPath: string, deadlineMs = 8000): Promise<Socket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const s = connect(sockPath);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
    } catch (err) {
      if (Date.now() - start > deadlineMs) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function toolText(res: { result?: unknown }): unknown {
  const content = (res.result as { content?: Array<{ text?: string }> })?.content;
  return content?.[0]?.text ? JSON.parse(content[0].text) : undefined;
}

test('scoped reads: caller sees own + read-granted sessions only; query disabled (#122)', async () => {
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
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')),
      CLAUDE_FLEET_SCOPED_READS: '1'
    } as Record<string, string>
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const clients: RpcClient[] = [];
  try {
    await new Promise((r) => setTimeout(r, 800)); // let the watcher ingest both sessions

    const listSessionIds = async (sockId: string): Promise<string[]> => {
      const sock = await connectWithRetry(path.join(userDataDir, 'mcp', sockId, 'mcp.sock'));
      const c = new RpcClient(sock);
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

    // The raw query hatch is disabled under scoping.
    const qSock = await connectWithRetry(path.join(userDataDir, 'mcp', A, 'mcp.sock'));
    const qc = new RpcClient(qSock);
    clients.push(qc);
    await qc.call('initialize', { protocolVersion: '2024-11-05' });
    const q = await qc.call('tools/call', { name: 'query', arguments: { sql: 'SELECT 1' } });
    const qr = q.result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(qr.isError).toBe(true);
    expect(qr.content?.[0]?.text ?? '').toMatch(/disabled under scoped reads/);
  } finally {
    clients.forEach((c) => c.close());
    await app.close();
  }
});
