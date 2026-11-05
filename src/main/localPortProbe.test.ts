import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeLocalHttp } from './localPortProbe.js';

const open: net.Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close(() => undefined);
});

function listen(server: net.Server): Promise<number> {
  open.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  );
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
});
