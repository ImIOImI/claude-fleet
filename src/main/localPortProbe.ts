import net from 'node:net';

/** True when 127.0.0.1:<port> answers a minimal GET with an HTTP status line. */
export function probeLocalHttp(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => sock.write('GET / HTTP/1.0\r\nHost: localhost\r\n\r\n'));
    sock.once('data', (b) => finish(String(b).startsWith('HTTP/')));
    sock.once('error', () => finish(false));
    sock.once('end', () => finish(false));
  });
}
