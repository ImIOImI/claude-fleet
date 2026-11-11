// host:port parsing for the two-pod layout's TCP endpoints.
import type { Server } from 'node:net';

export interface HostPort {
  host: string;
  port: number;
}

export function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : null;
}

/** A DNS name or IPv4 address and a port; IPv6 literals are not accepted. */
export function parseHostPort(text: string): HostPort | null {
  const m = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(text);
  if (!m) return null;
  const port = parsePort(m[2]);
  return port === null ? null : { host: m[1], port };
}

/** A Unix socket path, or a TCP port on `host` (default 0.0.0.0, which Istio's inbound forwarding needs). */
export type ListenTarget = { path: string } | { port: number; host?: string };

/** Resolves with the bound TCP port, or null for a Unix socket. */
export function listenOn(server: Server, target: ListenTarget): Promise<number | null> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const done = (): void => {
      server.off('error', reject);
      const a = server.address();
      resolve(a && typeof a === 'object' ? a.port : null);
    };
    if ('path' in target) server.listen(target.path, done);
    else server.listen(target.port, target.host ?? '0.0.0.0', done);
  });
}
