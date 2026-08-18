// Runtime tests for the local MCP bridge script (#295).
//
// The bridge is a source *string*, so the entry-builder tests in
// mcpLocalBridge.test.ts only prove what env we hand it. These spawn the real
// script and drive it end to end — the only way to catch the failure this
// issue was about, where the bridge dialed a transport the host never offered.
//
// Windows hosts can't listen() on a unix socket, so the unix leg is skipped
// there and the TCP leg is what actually ships on that platform.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalBridgeScript } from './mcpLocalBridge.js';

interface Fake {
  server: Server;
  lines: string[];
  sockets: Set<Socket>;
  close(): Promise<void>;
}

/** Line-logging listener on a TCP port or a unix socket path. */
function fakeServer(target: number | string): Promise<Fake> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((sock) => {
      sockets.add(sock);
      sock.setEncoding('utf8');
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => undefined);
      let buf = '';
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
    });
    const done = (): void =>
      resolve({
        server,
        lines,
        sockets,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          })
      });
    if (typeof target === 'number') server.listen(target, '127.0.0.1', done);
    else server.listen(target, done);
  });
}

function reply(fake: Fake, obj: unknown): void {
  for (const s of fake.sockets) s.write(JSON.stringify(obj) + '\n');
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const PORT = 19171;

describe('local MCP bridge (script runtime)', () => {
  let dir = '';
  let child: ChildProcess | null = null;
  let fakes: Fake[] = [];

  afterEach(async () => {
    child?.kill();
    child = null;
    for (const f of fakes) await f.close();
    fakes = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function startBridge(env: Record<string, string>): Promise<{
    out: string[];
    write(line: string): void;
    exited: Promise<number | null>;
  }> {
    const script = await ensureLocalBridgeScript(dir);
    const proc = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit']
    });
    child = proc;
    const out: string[] = [];
    let buf = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        out.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    return {
      out,
      write: (line) => proc.stdin!.write(line + '\n'),
      exited: new Promise((r) => proc.on('exit', (code) => r(code)))
    };
  }

  function tmp(): string {
    dir = mkdtempSync(join(tmpdir(), 'local-bridge-'));
    return dir;
  }

  it('pipes both directions over loopback TCP, token first (Windows transport)', async () => {
    const d = tmp();
    writeFileSync(join(d, 'token'), 'tok-win\n', 'utf8');
    const f = await fakeServer(PORT);
    fakes.push(f);

    const io = await startBridge({
      CLAUDE_FLEET_MCP_TCP: `127.0.0.1:${PORT}`,
      CLAUDE_FLEET_MCP_TOKEN_FILE: join(d, 'token')
    });

    io.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    await until(() => f.lines.length >= 2);
    expect(f.lines[0]).toBe('tok-win'); // auth precedes any traffic
    expect(JSON.parse(f.lines[1]).id).toBe(1);

    reply(f, { jsonrpc: '2.0', id: 1, result: { ok: true } });
    await until(() => io.out.length >= 1);
    expect(JSON.parse(io.out[0]).result).toEqual({ ok: true });
  });

  it.skipIf(process.platform === 'win32')(
    'still pipes over a unix socket (POSIX transport unchanged)',
    async () => {
      const d = tmp();
      const sockPath = join(d, 'mcp.sock');
      const f = await fakeServer(sockPath);
      fakes.push(f);

      const io = await startBridge({ CLAUDE_FLEET_MCP_SOCKET: sockPath });

      io.write('{"jsonrpc":"2.0","id":7,"method":"tools/list"}');
      await until(() => f.lines.length >= 1);
      expect(f.lines[0]).toBe('{"jsonrpc":"2.0","id":7,"method":"tools/list"}');
      expect(f.lines.some((l) => l === 'tok-win')).toBe(false); // no token on unix

      reply(f, { jsonrpc: '2.0', id: 7, result: { ok: true } });
      await until(() => io.out.length >= 1);
      expect(JSON.parse(io.out[0]).id).toBe(7);
    }
  );

  // The token is written by ensureWorkspaceToken at startup/create; a bridge
  // that raced it must wait, not authenticate as nobody. It must also not send
  // claude's request into a connection the server is about to drop.
  it('waits for a token that appears late instead of sending unauthenticated', async () => {
    const d = tmp();
    const tokenPath = join(d, 'token');
    const f = await fakeServer(PORT);
    fakes.push(f);

    const io = await startBridge({
      CLAUDE_FLEET_MCP_TCP: `127.0.0.1:${PORT}`,
      CLAUDE_FLEET_MCP_TOKEN_FILE: tokenPath
    });
    io.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');

    await new Promise((r) => setTimeout(r, 300));
    expect(f.lines).toEqual([]); // nothing forged through while unauthenticated

    writeFileSync(tokenPath, 'tok-late\n', 'utf8');
    await until(() => f.lines.length >= 2);
    expect(f.lines[0]).toBe('tok-late');
    expect(JSON.parse(f.lines[1]).id).toBe(2);
  });

  // Retry, not exit: the MCP server comes up with the app, so an attach that
  // beats it must survive the first refused connect.
  it('retries until the server appears', async () => {
    tmp();
    const io = await startBridge({ CLAUDE_FLEET_MCP_TCP: `127.0.0.1:${PORT}` });

    await new Promise((r) => setTimeout(r, 300));
    const f = await fakeServer(PORT);
    fakes.push(f);

    io.write('{"jsonrpc":"2.0","id":3,"method":"tools/list"}');
    await until(() => f.lines.length >= 1);
    expect(JSON.parse(f.lines[0]).id).toBe(3);
  });
});
