import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrokerClient, FrameType } from './broker.js';

// A minimal in-process broker stub: it reads frames and replies to DIAL with
// DIALED{ok:true} and to LISTPORTS with PORTS{ports:[3000,8080]}. Frame codec
// is reproduced here (the real codec lives in broker.ts and is not exported).
function encodeJSON(type: number, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const out = Buffer.allocUnsafe(4 + 1 + body.length);
  out.writeUInt32BE(body.length + 1, 0);
  out[4] = type;
  body.copy(out, 5);
  return out;
}

function startStub(sockPath: string): net.Server {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const total = buf.readUInt32BE(0);
        if (buf.length < 4 + total) break;
        const type = buf[4];
        const payload = buf.subarray(5, 4 + total);
        buf = buf.subarray(4 + total);
        if (type === FrameType.DIAL) {
          const { channel } = JSON.parse(payload.toString('utf8'));
          sock.write(encodeJSON(FrameType.DIALED, { channel, ok: true }));
        } else if (type === FrameType.LISTPORTS) {
          sock.write(encodeJSON(FrameType.PORTS, { ports: [{ port: 3000 }, { port: 8080 }] }));
        }
      }
    });
  });
  server.listen(sockPath);
  return server;
}

describe('BrokerClient port-forward RPCs', () => {
  let server: net.Server | undefined;
  afterEach(() => server?.close());

  it('dial resolves with ok', async () => {
    const sock = path.join(mkdtempSync(path.join(tmpdir(), 'broker-test-')), 'b.sock');
    server = startStub(sock);
    const client = new BrokerClient(sock);
    await client.ready();
    const resp = await client.dial(1, 3000);
    expect(resp.ok).toBe(true);
    expect(resp.channel).toBe(1);
    client.close();
  });

  it('listPorts returns the port infos', async () => {
    const sock = path.join(mkdtempSync(path.join(tmpdir(), 'broker-test-')), 'b.sock');
    server = startStub(sock);
    const client = new BrokerClient(sock);
    await client.ready();
    const ports = await client.listPorts();
    expect(ports).toEqual([{ port: 3000 }, { port: 8080 }]);
    client.close();
  });

  it('listPorts includes pid and cmdline when present', async () => {
    const sock = path.join(mkdtempSync(path.join(tmpdir(), 'broker-test-')), 'b.sock');
    // Custom stub that responds with port info that includes pid and cmdline
    const server2 = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4) {
          const total = buf.readUInt32BE(0);
          if (buf.length < 4 + total) break;
          const type = buf[4];
          const payload = buf.subarray(5, 4 + total);
          buf = buf.subarray(4 + total);
          if (type === FrameType.LISTPORTS) {
            sock.write(
              encodeJSON(FrameType.PORTS, {
                ports: [
                  { port: 3000, pid: 42, cmdline: 'vite dev' },
                  { port: 8080, pid: 123 }
                ]
              })
            );
          }
        }
      });
    });
    server2.listen(sock);
    server = server2;
    const client = new BrokerClient(sock);
    await client.ready();
    const ports = await client.listPorts();
    expect(ports).toEqual([
      { port: 3000, pid: 42, cmdline: 'vite dev' },
      { port: 8080, pid: 123 }
    ]);
    client.close();
  });
});
