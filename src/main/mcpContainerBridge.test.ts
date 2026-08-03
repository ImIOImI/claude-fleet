// Regression tests for the container-side MCP bridge (first-call hang).
//
// The old `{ printf token; exec cat; } | socat` pipeline silently ATE the
// first request written after a host-app restart: socat's TCP peer died with
// the app, `cat` only noticed on its next write (SIGPIPE) and died carrying
// the request, and the respawned pipeline never re-sent it — so claude hung
// forever on a request no server ever saw. Verified empirically 2026-07-09.
//
// The node bridge must instead: buffer stdin lines, track requests by
// JSON-RPC id, reconnect after the server goes away, and RE-SEND unanswered
// requests (token first) on every new connection.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureContainerBridgeScript } from './mcpContainerBridge.js';

interface FakeServer {
  server: Server;
  lines: string[];
  sockets: Set<Socket>;
  close(): Promise<void>;
}

/** Line-logging TCP server; can answer a request id on demand. */
function fakeServer(port: number): Promise<FakeServer> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      sock.on('error', () => undefined);
    });
    server.listen(port, '127.0.0.1', () =>
      resolve({
        server,
        lines,
        sockets,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          })
      })
    );
  });
}

function reply(fake: FakeServer, obj: unknown): void {
  for (const s of fake.sockets) s.write(JSON.stringify(obj) + '\n');
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const PORT = 19071;

describe('container MCP bridge', () => {
  let dir: string;
  let child: ChildProcess | null = null;
  let fakes: FakeServer[] = [];

  afterEach(async () => {
    child?.kill();
    child = null;
    for (const f of fakes) await f.close();
    fakes = [];
    rmSync(dir, { recursive: true, force: true });
  });

  async function startBridge(
    extraEnv: Record<string, string> = {}
  ): Promise<{ out: string[]; write(line: string): void }> {
    dir = mkdtempSync(join(tmpdir(), 'bridge-'));
    writeFileSync(join(dir, 'token'), 'tok-abc\n', 'utf8');
    const script = ensureContainerBridgeScript(dir);
    child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        CLAUDE_FLEET_MCP_TCP: `127.0.0.1:${PORT}`,
        CLAUDE_FLEET_MCP_TOKEN_FILE: join(dir, 'token'),
        CLAUDE_FLEET_MCP_RETRY_MS: '100',
        ...extraEnv
      },
      stdio: ['pipe', 'pipe', 'inherit']
    });
    const out: string[] = [];
    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        out.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    return { out, write: (line) => child!.stdin!.write(line + '\n') };
  }

  it('authenticates, forwards requests, and returns responses', async () => {
    const f1 = await fakeServer(PORT);
    fakes.push(f1);
    const io = await startBridge();

    io.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    await until(() => f1.lines.length >= 2);
    expect(f1.lines[0]).toBe('tok-abc'); // token precedes traffic
    expect(JSON.parse(f1.lines[1]).id).toBe(1);

    reply(f1, { jsonrpc: '2.0', id: 1, result: { ok: true } });
    await until(() => io.out.length >= 1);
    expect(JSON.parse(io.out[0]).id).toBe(1);
  });

  it('re-sends an unanswered request to the NEW server after a restart (the eaten first call)', async () => {
    const f1 = await fakeServer(PORT);
    fakes.push(f1);
    const io = await startBridge();

    // req 1 is answered by server 1 — must NOT be replayed later.
    io.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    await until(() => f1.lines.length >= 2);
    reply(f1, { jsonrpc: '2.0', id: 1, result: {} });
    await until(() => io.out.length >= 1);

    // The app "quits": listener + live connections die.
    await f1.close();
    await new Promise((r) => setTimeout(r, 150));

    // The fateful first-call-after-restart, written while nothing is listening.
    io.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_errors"}}');
    await new Promise((r) => setTimeout(r, 150));

    // The app "restarts".
    const f2 = await fakeServer(PORT);
    fakes.push(f2);

    // The bridge reconnects, re-authenticates, and delivers request 2.
    await until(() => f2.lines.length >= 2);
    expect(f2.lines[0]).toBe('tok-abc');
    const replayedIds = f2.lines.slice(1).map((l) => JSON.parse(l).id);
    expect(replayedIds).toContain(2); // the previously-eaten call arrives
    expect(replayedIds).not.toContain(1); // answered requests are not replayed

    reply(f2, { jsonrpc: '2.0', id: 2, result: { recovered: true } });
    await until(() => io.out.length >= 2);
    expect(JSON.parse(io.out[1]).id).toBe(2);
  });

  it('re-sends a request that was in flight when the server died', async () => {
    const f1 = await fakeServer(PORT);
    fakes.push(f1);
    const io = await startBridge();

    // Delivered to server 1 but never answered — the response is lost with the app.
    io.write('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_sessions"}}');
    await until(() => f1.lines.length >= 2);
    await f1.close();

    const f2 = await fakeServer(PORT);
    fakes.push(f2);
    await until(() => f2.lines.length >= 2);
    expect(f2.lines[0]).toBe('tok-abc');
    expect(JSON.parse(f2.lines[1]).id).toBe(7); // replayed, not lost
  });

  it('backs off exponentially when the server keeps dropping the connection (#243)', async () => {
    // The pathological churn case: a server that accepts then immediately
    // drops every connection without ever sending data (so the connection
    // never proves healthy and the backoff never resets). The bridge must
    // slow its reconnects instead of hammering at a fixed 1s interval.
    const accepts: number[] = [];
    const server = createServer((sock) => {
      accepts.push(Date.now());
      sock.on('error', () => undefined);
      sock.destroy();
    });
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
    fakes.push({
      server,
      lines: [],
      sockets: new Set(),
      close: () => new Promise<void>((r) => server.close(() => r()))
    });

    await startBridge({
      CLAUDE_FLEET_MCP_RETRY_MS: '80',
      CLAUDE_FLEET_MCP_RETRY_MAX_MS: '640',
      CLAUDE_FLEET_MCP_STABLE_MS: '60000' // never resets during the test
    });

    await until(() => accepts.length >= 5, 8000);
    // Gaps between successive accepts follow the reconnect delay: ~80, 160,
    // 320, 640 (then capped). Assert each of the first few grows, and that
    // none blows past the cap (with generous scheduler slack).
    const gaps = accepts.slice(1).map((t, i) => t - accepts[i]!);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.4);
    expect(gaps[2]!).toBeGreaterThan(gaps[1]! * 1.4);
    for (const g of gaps) expect(g).toBeLessThan(640 + 400);
  });
});
