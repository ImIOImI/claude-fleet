// The host's view of the in-container broker. One upstream attachment per
// session (the broker allows one writer); control ops use a fresh connection
// each, because BrokerClient allows one in-flight request per response type.
import { BrokerClient, type BrokerPortInfo, type SessionInfo } from '../main/broker.js';

export const UPSTREAM_CHANNEL = 1;

export interface UpstreamHandlers {
  onHistory(body: Buffer): void;
  onOutput(body: Buffer): void;
  onEnded(): void;
  /** The broker connection dropped. */
  onGone(): void;
}

export interface Upstream {
  input(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /** Kill the session in the broker. */
  closeSession(): Promise<void>;
  /** Leave the session alive and drop the connection. */
  detach(): Promise<void>;
}

export interface BrokerOps {
  attach(id: string, h: UpstreamHandlers): Promise<{ ok: true; upstream: Upstream } | { ok: false; error: string }>;
  create(id: string, cols: number, rows: number, args: string[]): Promise<{ ok: boolean; error?: string }>;
  list(): Promise<SessionInfo[]>;
  listPorts(): Promise<BrokerPortInfo[]>;
  killPort(port: number): Promise<{ ok: boolean; error?: string }>;
}

async function withClient<T>(socket: string, fn: (c: BrokerClient) => Promise<T>): Promise<T> {
  const c = new BrokerClient(socket);
  try {
    await c.ready();
    return await fn(c);
  } finally {
    c.close();
  }
}

export function brokerOps(socket: string): BrokerOps {
  return {
    async attach(id, h) {
      const c = new BrokerClient(socket);
      try {
        await c.ready();
      } catch (err) {
        c.close();
        return { ok: false, error: `broker unreachable (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
      }
      c.on('history', (ch: number, b: Buffer) => ch === UPSTREAM_CHANNEL && h.onHistory(b));
      c.on('output', (ch: number, b: Buffer) => ch === UPSTREAM_CHANNEL && h.onOutput(b));
      c.on('ended', (ch: number) => ch === UPSTREAM_CHANNEL && h.onEnded());
      c.on('error', () => undefined);
      c.on('close', () => h.onGone());
      const r = await c.attachSession(id, UPSTREAM_CHANNEL).catch((err: Error) => ({ ok: false, error: err.message }));
      if (!r.ok) {
        c.removeAllListeners('close');
        c.close();
        return { ok: false, error: r.error ?? 'attach failed' };
      }
      return {
        ok: true,
        upstream: {
          input: (d) => c.sendInput(UPSTREAM_CHANNEL, d),
          resize: (cols, rows) => c.sendResize(UPSTREAM_CHANNEL, cols, rows),
          async closeSession() {
            await c.closeChannel(UPSTREAM_CHANNEL);
          },
          async detach() {
            c.removeAllListeners('close');
            await c.detachChannel(UPSTREAM_CHANNEL).catch(() => undefined);
            c.close();
          }
        }
      };
    },
    create: (id, cols, rows, args) => withClient(socket, (c) => c.createSession(id, cols, rows, args)),
    list: () => withClient(socket, (c) => c.listSessions()),
    listPorts: () => withClient(socket, (c) => c.listPorts()),
    killPort: (port) => withClient(socket, (c) => c.killPort(port))
  };
}
