// Local-workspace MCP wiring (#295), end to end on BOTH transports.
//
// The bug this pins: on Windows the fleet MCP was never wired into a local
// workspace at all. `ensureMcpConfig` gated on `<userData>/mcp/<id>/mcp.sock`,
// a file a Windows host never creates (it can't `listen()` on a unix socket —
// it mints a per-workspace token and fronts every workspace with one
// loopback-TCP listener instead), so the gate could never pass and no
// `mcp-config.json` was ever written. The local bridge was unix-only besides.
//
// Rather than assert the config's *shape* (which would have happily passed
// against a bridge that couldn't dial), this drives the whole chain the way
// claude does: read the `mcp-config.json` the app actually wrote, spawn the
// bridge from EXACTLY that command/args/env, and speak JSON-RPC over its stdio
// to the app's live MCP server. If the transport is wrong, the round trip
// fails — on whichever platform is wrong.
//
// Runs on both CI e2e jobs, so the Linux job covers the unix leg and the
// windows-latest job covers the TCP + token leg that #295 was about.
//
// The WSL launcher variant is not driven here: its bridge is exec'd across the
// interop boundary, so the command is a `/mnt/c/…` path this side can't spawn.
// Its entry shape is unit-tested (`mcpLocalBridge.test.ts`) and the interop
// mechanism itself is covered by `wsl-local.spec.ts`; the full in-distro MCP
// round trip stays with #260.

import { _electron as electron, test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, waitForLogEntry } from './_helpers.js';

interface McpEntry {
  type: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Newline-delimited JSON-RPC over a child process's stdio (what claude does
 *  with an `mcpServers` stdio entry). */
class StdioRpc {
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  constructor(private child: ChildProcess) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }
  call(method: string, params?: unknown): Promise<{ result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out — the bridge never reached the server`)),
        15_000
      );
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}

test('Local MCP wiring: the app-written mcp-config drives a working bridge (#295)', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'fleet-local-mcp-'));
  const id = '01LOCALMCPWS000000000000WS';
  const stateDir = path.join(userDataDir, 'state', id);
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(
    path.join(stateDir, 'workspace.json'),
    JSON.stringify({
      id,
      name: 'local-mcp-test',
      labels: [],
      workspaceRoot: tmpdir(),
      workspaceSubdir: '',
      kind: 'local',
      authMode: 'oauth',
      env: { plain: {}, secretKeys: [] },
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
  );

  const stubPath = path.resolve(import.meta.dirname, 'fixtures', 'claude-stub.js');

  // Non-mock launch so the DB and the MCP server actually start (CLAUDE_FLEET_MOCK
  // filtered out exactly as mcp-server.spec.ts does).
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_FLEET_MOCK')
  ) as Record<string, string>;

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...baseEnv,
      CLAUDE_FLEET_LOCAL_CLAUDE_BIN: process.execPath,
      CLAUDE_FLEET_LOCAL_CLAUDE_EXTRA_ARGS: stubPath
    }
  });

  let bridge: ChildProcess | null = null;
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Resume the seeded workspace and attach a session — ensureMcpConfig runs
    // inside attachPty, so nothing is written until a real attach happens.
    await window.locator('.top-strip').getByRole('button', { name: 'Add workspace' }).click();
    const row = window.locator('.saved-row', { hasText: 'local-mcp-test' });
    await expect(row).toBeVisible({ timeout: 8_000 });
    await row.locator('.saved-row-header').click();
    await row.getByRole('button', { name: 'Resume' }).click();
    await expect(window.locator('.ws-chip .name', { hasText: 'local-mcp-test' })).toBeVisible({
      timeout: 10_000
    });
    await window.locator('.ws-chip', { hasText: 'local-mcp-test' }).click();
    await waitForLogEntry(
      userDataDir,
      (e) => e.type === 'mapping-learned' && e.workspaceId === id,
      15_000
    );

    // 1. The config exists at all. On Windows before the fix this file was
    //    never written, so this is the assertion that fails outright there.
    const configPath = path.join(stateDir, 'mcp-config.json');
    expect(
      existsSync(configPath),
      'mcp-config.json was not written — MCP wiring was skipped for this local workspace'
    ).toBe(true);

    const entry = (
      JSON.parse(readFileSync(configPath, 'utf8')) as {
        mcpServers: Record<string, McpEntry>;
      }
    ).mcpServers['claude-fleet-state'];
    expect(entry).toBeTruthy();

    // 2. The transport matches what THIS host's MCP server actually offers,
    //    and the readiness file it names is really on disk.
    if (process.platform === 'win32') {
      expect(entry.env.CLAUDE_FLEET_MCP_TCP).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(entry.env.CLAUDE_FLEET_MCP_SOCKET).toBeUndefined();
      const tokenPath = entry.env.CLAUDE_FLEET_MCP_TOKEN_FILE;
      expect(tokenPath).toBe(path.join(userDataDir, 'mcp', id, 'token'));
      expect(existsSync(tokenPath)).toBe(true);
    } else {
      expect(entry.env.CLAUDE_FLEET_MCP_SOCKET).toBe(
        path.join(userDataDir, 'mcp', id, 'mcp.sock')
      );
      expect(entry.env.CLAUDE_FLEET_MCP_TCP).toBeUndefined();
      expect(existsSync(entry.env.CLAUDE_FLEET_MCP_SOCKET)).toBe(true);
    }

    // 3. The payoff: run the bridge exactly as claude would, from the config
    //    the app wrote, and complete an MCP round trip through it.
    bridge = spawn(entry.command, entry.args, {
      env: { ...baseEnv, ...entry.env },
      stdio: ['pipe', 'pipe', 'inherit']
    });
    const rpc = new StdioRpc(bridge);

    const init = await rpc.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'local-mcp-wiring-spec', version: '0' }
    });
    expect(init.error).toBeUndefined();

    const tools = await rpc.call('tools/list');
    const names = (tools.result as { tools?: Array<{ name: string }> })?.tools?.map((t) => t.name);
    expect(names).toContain('list_sessions');

    // A real read proves the server resolved a caller identity for this
    // connection — on Windows that means the token round trip worked, which is
    // the whole mechanism #295 was missing.
    const sessions = await rpc.call('tools/call', {
      name: 'list_sessions',
      arguments: {}
    });
    expect(sessions.error).toBeUndefined();
  } finally {
    bridge?.kill();
    await app.close();
  }
});
