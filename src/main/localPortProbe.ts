import net from 'node:net';

function probeHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
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

/**
 * True when <port> answers a minimal GET with an HTTP status line on 127.0.0.1
 * or ::1. Node >=17 resolves `localhost` in OS order, which puts ::1 first on
 * Windows and macOS, so a dev server bound only to ::1 (e.g. Vite's default)
 * needs the second attempt.
 */
export async function probeLocalHttp(port: number, timeoutMs = 1500): Promise<boolean> {
  if (await probeHost('127.0.0.1', port, timeoutMs)) return true;
  return probeHost('::1', port, timeoutMs);
}
