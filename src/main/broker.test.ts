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

describe('BrokerClient over an already-open Duplex', () => {
  async function pipe(reply?: (frame: Buffer, peer: import('node:stream').Duplex) => void) {
    const { Duplex } = await import('node:stream');
    const written: Buffer[] = [];
    const stream: import('node:stream').Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        written.push(chunk);
        reply?.(chunk, stream);
        cb();
      }
    });
    return { stream, written };
  }

  it('speaks the frame protocol on the given stream without connecting', async () => {
    const { encodeJSONFrame } = await import('./broker.js');
    const { stream, written } = await pipe((_f, peer) => peer.push(encodeJSONFrame(FrameType.SESSIONS, { sessions: [{ id: 's1', alive: true }] })));
    const c = new BrokerClient(stream);
    await c.ready();
    expect(await c.listSessions()).toEqual([{ id: 's1', alive: true }]);
    expect(written[0][4]).toBe(FrameType.LIST);
    c.close();
  });

  it('writes exactly one whole frame per write, splitting oversized input', async () => {
    const { FrameReader, MAX_FRAME_PAYLOAD, decodeChannelData } = await import('./broker.js');
    const { stream, written } = await pipe();
    const c = new BrokerClient(stream);
    const big = Buffer.alloc(MAX_FRAME_PAYLOAD * 2 + 10, 0x61);
    c.sendInput(1, big);
    c.sendResize(1, 80, 24);
    let total = 0;
    for (const w of written) {
      const r = new FrameReader();
      r.push(w);
      const frames = [...r.consume()];
      expect(frames).toHaveLength(1);
      expect(w.length).toBe(4 + w.readUInt32BE(0));
      expect(w.length).toBeLessThanOrEqual(MAX_FRAME_PAYLOAD + 5);
      if (frames[0].type === FrameType.INPUT) total += decodeChannelData(frames[0].payload).body.length;
    }
    expect(total).toBe(big.length);
    expect(written.length).toBe(4);
    c.close();
  });

  it('treats the peer ending the stream as close and fails a pending request at once', async () => {
    const { stream } = await pipe();
    const c = new BrokerClient(stream);
    const closed = new Promise<void>((r) => c.once('close', () => r()));
    const pending = c.listSessions();
    stream.push(null);
    await closed;
    const started = Date.now();
    await expect(pending).rejects.toThrow(/closed/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('BrokerClient over a unix socket (container path)', () => {
  let server: net.Server | undefined;
  afterEach(() => server?.close());

  it('rejects a pending request at once when the broker drops the socket mid-LIST', async () => {
    const sock = path.join(mkdtempSync(path.join(tmpdir(), 'broker-test-')), 'b.sock');
    server = net.createServer((s) => s.on('data', () => s.destroy()));
    await new Promise<void>((r) => server!.listen(sock, () => r()));
    const client = new BrokerClient(sock);
    await client.ready();
    const started = Date.now();
    await expect(client.listSessions()).rejects.toThrow(/closed/);
    expect(Date.now() - started).toBeLessThan(1000);
    client.close();
  });

  it('does not add the Duplex end→destroy hook to a net.Socket', async () => {
    const sock = path.join(mkdtempSync(path.join(tmpdir(), 'broker-test-')), 'b.sock');
    server = net.createServer(() => undefined);
    await new Promise<void>((r) => server!.listen(sock, () => r()));
    const baseline = net.createConnection(sock);
    const client = new BrokerClient(sock);
    await client.ready();
    const socket = (client as unknown as { socket: net.Socket }).socket;
    expect(socket.listenerCount('end')).toBe(baseline.listenerCount('end'));
    baseline.destroy();
    client.close();
  });
});
