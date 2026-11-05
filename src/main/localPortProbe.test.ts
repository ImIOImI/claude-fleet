import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeLocalHttp } from './localPortProbe.js';

const open: net.Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close(() => undefined);
});

function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
  open.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
  });
}

/** ::1 isn't always available (e.g. some CI/container networks); probe once and skip if not. */
function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

describe('probeLocalHttp', () => {
  it('passes for an HTTP server', async () => {
    const port = await listen(http.createServer((_req, res) => res.end('ok')));
    await expect(probeLocalHttp(port)).resolves.toBe(true);
  });

  it('fails for a non-HTTP listener', async () => {
    const port = await listen(net.createServer((s) => s.end('SSH-2.0-nope\r\n')));
    await expect(probeLocalHttp(port)).resolves.toBe(false);
  });

  it('fails for a closed port', async () => {
    const srv = net.createServer();
    const port = await listen(srv);
    await new Promise<void>((r) => srv.close(() => r()));
    open.splice(open.indexOf(srv), 1);
    await expect(probeLocalHttp(port)).resolves.toBe(false);
  });

  it('fails when nothing answers before the timeout', async () => {
    const port = await listen(net.createServer(() => undefined));
    await expect(probeLocalHttp(port, 100)).resolves.toBe(false);
  });

  it('passes for an HTTP server bound only to ::1', async (ctx) => {
    if (!(await ipv6LoopbackAvailable())) ctx.skip();
    const port = await listen(http.createServer((_req, res) => res.end('ok')), '::1');
    await expect(probeLocalHttp(port)).resolves.toBe(true);
  });
});
