// Test support: a fake Postgres that asks for a cleartext password, records it,
// then accepts the connection. Proves which password each new connection sends.
import { createServer, type Server, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';

export interface FakePgAuth { port: number; passwords: string[]; close(): Promise<void> }

const msg = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
const int32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

const SSL_REQUEST = 80877103;

/** With `tls`, answers SSLRequest and speaks the protocol over TLS with that cert. */
export async function fakePgAuth(tls?: { key: string; cert: string }): Promise<FakePgAuth> {
  const passwords: string[] = [];
  const socks = new Set<Socket>();
  const server: Server = createServer((raw) => {
    socks.add(raw);
    raw.on('close', () => socks.delete(raw));
    raw.on('error', () => undefined);
    if (!tls) return speak(raw);
    raw.once('data', (d) => {
      if (d.length !== 8 || d.readInt32BE(4) !== SSL_REQUEST) return raw.destroy();
      raw.write('S');
      const sec = new TLSSocket(raw, { isServer: true, ...tls });
      sec.on('error', () => raw.destroy());
      speak(sec);
    });
  });
  function speak(sock: Socket): void {
    let buf = Buffer.alloc(0);
    let started = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!started) {
          if (buf.length < 4) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          buf = buf.subarray(len);
          started = true;
          sock.write(msg('R', int32(3)));
          continue;
        }
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        const body = buf.subarray(5, len + 1);
        buf = buf.subarray(len + 1);
        if (type === 'p') {
          passwords.push(body.subarray(0, body.length - 1).toString('utf8'));
          sock.write(Buffer.concat([msg('R', int32(0)), msg('Z', Buffer.from('I'))]));
        } else if (type === 'X') {
          sock.end();
          return;
        }
      }
    });
  }
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as { port: number }).port,
    passwords,
    close: () => new Promise<void>((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }),
  };
}
