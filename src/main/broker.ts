// Host-side client for the in-container broker daemon.
//
// The broker (broker/cmd/broker, see //broker) owns every claude PTY
// in a workspace and serves them over a Unix socket bind-mounted from
// the host. This module is the thin TS counterpart that opens the
// socket, speaks the wire protocol, and exposes a Duplex stream the
// rest of the app can use as if it were talking directly to a PTY.
//
// One BrokerClient per attached terminal session. Cheap by design —
// Unix sockets are; the broker side multiplexes already; we don't try
// to share a single host-side socket across sessions because it would
// add a fan-out layer for no real win.
//
// Frame format MUST match proto.go exactly:
//
//   [u32 totalLen BE][u8 type][payload]
//
//   totalLen counts type + payload (≥1).
//   payload schema depends on type:
//     control frames     → JSON
//     INPUT/OUTPUT/HISTORY → [u32 channel BE][bytes]
//     RESIZE             → [u32 channel BE][u16 cols BE][u16 rows BE]

import net from 'node:net';
import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

export enum FrameType {
  CREATE = 0x01,
  CREATED = 0x02,
  ATTACH = 0x03,
  ATTACHED = 0x04,
  DETACH = 0x05,
  DETACHED = 0x06,
  CLOSE = 0x07,
  CLOSED = 0x08,
  ENDED = 0x09,
  LIST = 0x0a,
  SESSIONS = 0x0b,
  INPUT = 0x10,
  OUTPUT = 0x11,
  HISTORY = 0x12,
  RESIZE = 0x13
}

const MAX_FRAME_PAYLOAD = 1 << 20; // mirror proto.MaxFramePayload

/** Timeout for control-RPC responses. See `rpc()` for the rationale. */
export const RPC_TIMEOUT_MS = 30_000;

/**
 * Splits a stream of socket bytes into discrete frames. Push raw
 * chunks; pull complete frames via the iterator returned by `consume`.
 */
class FrameReader {
  // Buffer<ArrayBufferLike> is the broader type that's compatible with
  // both Buffer.alloc() and Buffer.concat()/subarray() return shapes in
  // @types/node 22+. Without the explicit annotation the field gets
  // inferred as the narrower Buffer<ArrayBuffer> and later assignments
  // fail the variance check.
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): void {
    if (this.buf.length === 0) {
      this.buf = chunk;
      return;
    }
    this.buf = Buffer.concat([this.buf, chunk]);
  }

  *consume(): IterableIterator<{ type: FrameType; payload: Buffer }> {
    for (;;) {
      if (this.buf.length < 4) return;
      const totalLen = this.buf.readUInt32BE(0);
      if (totalLen === 0) {
        throw new Error('broker: zero-length frame');
      }
      if (totalLen - 1 > MAX_FRAME_PAYLOAD) {
        throw new Error(`broker: frame payload ${totalLen - 1} exceeds max ${MAX_FRAME_PAYLOAD}`);
      }
      if (this.buf.length < 4 + totalLen) return;
      const type = this.buf[4] as FrameType;
      const payload = this.buf.subarray(5, 4 + totalLen);
      // Copy the payload before advancing — the underlying buffer slice
      // would otherwise alias future reuse of the storage.
      const out = Buffer.from(payload);
      this.buf = this.buf.subarray(4 + totalLen);
      yield { type, payload: out };
    }
  }
}

function encodeFrame(type: FrameType, payload: Buffer): Buffer {
  const totalLen = payload.length + 1;
  const out = Buffer.allocUnsafe(4 + totalLen);
  out.writeUInt32BE(totalLen, 0);
  out[4] = type;
  payload.copy(out, 5);
  return out;
}

function encodeJSONFrame(type: FrameType, value: unknown): Buffer {
  return encodeFrame(type, Buffer.from(JSON.stringify(value), 'utf8'));
}

function encodeChannelData(channel: number, body: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(channel, 0);
  body.copy(out, 4);
  return out;
}

function decodeChannelData(payload: Buffer): { channel: number; body: Buffer } {
  if (payload.length < 4) throw new Error('broker: channel-data frame too short');
  return { channel: payload.readUInt32BE(0), body: payload.subarray(4) };
}

function encodeResize(channel: number, cols: number, rows: number): Buffer {
  const out = Buffer.allocUnsafe(8);
  out.writeUInt32BE(channel, 0);
  out.writeUInt16BE(cols, 4);
  out.writeUInt16BE(rows, 6);
  return out;
}

interface CreateResponse {
  id: string;
  ok: boolean;
  error?: string;
}

interface AttachResponse {
  channel: number;
  ok: boolean;
  error?: string;
}

export interface SessionInfo {
  id: string;
  alive: boolean;
}

/**
 * BrokerClient owns one socket connection to a workspace's broker.
 * Pending control RPCs (CREATE/ATTACH/DETACH/CLOSE/LIST) are tracked by
 * frame-type — only one of each can be in flight at once, which is fine
 * because we use one client per terminal session and the attach flow is
 * strictly serial.
 *
 * Events:
 *   'output'  (channel, bytes)   — live PTY output (FrameOutput)
 *   'history' (channel, bytes)   — ring-buffer dump on attach (FrameHistory)
 *   'ended'   (channel, reason)  — session ended (FrameEnded)
 *   'error'   (Error)            — socket-level error
 *   'close'   ()                 — socket closed
 */
export class BrokerClient extends EventEmitter {
  private socket: net.Socket;
  private reader = new FrameReader();
  private connected = false;
  // One outstanding waiter per response-frame type. Resolves when the
  // matching frame arrives. Reset to null on resolve so the next RPC
  // can take it.
  private waiters: Partial<Record<FrameType, (payload: Buffer) => void>> = {};

  constructor(endpoint: string | { host: string; port: number }) {
    super();
    // A string is a unix-socket path (Linux/macOS). An {host,port} object
    // is a loopback TCP endpoint (Windows), where the broker can't be
    // reached over an AF_UNIX socket living inside Docker's Linux VM.
    this.socket =
      typeof endpoint === 'string'
        ? net.createConnection(endpoint)
        : net.createConnection(endpoint.port, endpoint.host);
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    // Re-emit socket errors on the BrokerClient EventEmitter — but ONLY
    // when a consumer has actually attached an 'error' listener. Without
    // the guard, an error firing before any consumer subscribes (e.g.,
    // ENOENT on a missing broker socket, which happens immediately after
    // `new BrokerClient()` and before `client.ready()` finishes wiring
    // its own socket-level listener) hits `EventEmitter.emit('error')`
    // with zero listeners → Node throws synchronously inside the libuv
    // I/O callback → uncaughtException kills the awaiting handler's
    // tick → renderer's invoke fails with "reply was never sent" and
    // never sees the rejection we tried to throw. The pre-ready path
    // doesn't need the re-emit anyway: `ready()` attaches its own
    // `socket.once('error', …)` and rejects the connect promise
    // directly. The re-emit is only useful for errors after ready()
    // resolves, when brokerPtyStream has attached its own 'error'
    // listener on this BrokerClient.
    this.socket.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
    this.socket.on('close', () => {
      this.connected = false;
      this.emit('close');
    });
  }

  async ready(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        this.socket.off('error', onError);
        this.connected = true;
        resolve();
      };
      const onError = (err: Error): void => {
        this.socket.off('connect', onConnect);
        reject(err);
      };
      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
    });
  }

  private onData(chunk: Buffer): void {
    this.reader.push(chunk);
    try {
      for (const frame of this.reader.consume()) {
        this.dispatch(frame.type, frame.payload);
      }
    } catch (err) {
      // Same guard as the socket-error re-emit: don't throw via the
      // unhandled-error path if no consumer is listening. `socket.destroy()`
      // below triggers 'close' which consumers always observe via the
      // brokerPtyStream wiring, so dropping the error event is recoverable.
      if (this.listenerCount('error') > 0) this.emit('error', err as Error);
      this.socket.destroy();
    }
  }

  private dispatch(type: FrameType, payload: Buffer): void {
    switch (type) {
      case FrameType.OUTPUT: {
        const { channel, body } = decodeChannelData(payload);
        this.emit('output', channel, body);
        return;
      }
      case FrameType.HISTORY: {
        const { channel, body } = decodeChannelData(payload);
        this.emit('history', channel, body);
        return;
      }
      case FrameType.ENDED: {
        const obj = JSON.parse(payload.toString('utf8')) as { channel: number; reason: string };
        this.emit('ended', obj.channel, obj.reason);
        return;
      }
      default: {
        // Response frames satisfy their waiter, if any.
        const waiter = this.waiters[type];
        if (waiter) {
          this.waiters[type] = undefined;
          waiter(payload);
          return;
        }
        // Unknown / unsolicited — log and drop. Robust forward-compat.
        // eslint-disable-next-line no-console
        console.warn('broker: unsolicited frame type', type);
      }
    }
  }

  private rpc(
    request: { type: FrameType; payload: Buffer },
    responseType: FrameType
  ): Promise<Buffer> {
    if (this.waiters[responseType]) {
      return Promise.reject(new Error(`broker: ${FrameType[responseType]} already in flight`));
    }
    return new Promise<Buffer>((resolve, reject) => {
      // Why 30s and not 10s: the host-side flow does ATTACH → CREATE (if
      // missing) → ATTACH on the same connection. CREATE inside the
      // broker spawns the `claude` binary via pty.StartWithSize, and the
      // first claude spawn after a workspace pause/resume cycle (or
      // anywhere the broker's session map is empty) routinely takes
      // 15–25s — auth checks, MCP server warm-up, sometimes a network
      // call. A 10s timeout fires before that finishes; the broker
      // eventually sends the response but the waiter is gone, producing
      // both "ATTACHED timed out" (host) and "unsolicited frame type 4"
      // (host, when the late response lands). 30s covers the observed
      // worst case with margin without making honestly-stuck sessions
      // hang the UI indefinitely.
      const timer = setTimeout(() => {
        this.waiters[responseType] = undefined;
        reject(new Error(`broker: ${FrameType[responseType]} timed out`));
      }, RPC_TIMEOUT_MS);
      this.waiters[responseType] = (payload: Buffer): void => {
        clearTimeout(timer);
        resolve(payload);
      };
      this.socket.write(encodeFrame(request.type, request.payload), (err) => {
        if (err) {
          clearTimeout(timer);
          this.waiters[responseType] = undefined;
          reject(err);
        }
      });
    });
  }

  /**
   * Spawn a new claude PTY in the broker. `args`, when provided, are
   * appended to the broker's claude exec — the host uses this to resume a
   * prior session (`['--resume', '<claude-uuid>']`). Omitted for ordinary
   * new sessions, in which case the field is left off the wire entirely
   * (matching the broker's `omitempty`).
   */
  async createSession(
    id: string,
    cols: number,
    rows: number,
    args?: string[]
  ): Promise<CreateResponse> {
    const body = args && args.length > 0 ? { id, cols, rows, args } : { id, cols, rows };
    const payload = await this.rpc(
      { type: FrameType.CREATE, payload: Buffer.from(JSON.stringify(body), 'utf8') },
      FrameType.CREATED
    );
    return JSON.parse(payload.toString('utf8')) as CreateResponse;
  }

  async attachSession(id: string, channel: number): Promise<AttachResponse> {
    const payload = await this.rpc(
      { type: FrameType.ATTACH, payload: Buffer.from(JSON.stringify({ id, channel }), 'utf8') },
      FrameType.ATTACHED
    );
    return JSON.parse(payload.toString('utf8')) as AttachResponse;
  }

  async detachChannel(channel: number): Promise<void> {
    await this.rpc(
      { type: FrameType.DETACH, payload: Buffer.from(JSON.stringify({ channel }), 'utf8') },
      FrameType.DETACHED
    );
  }

  async closeChannel(channel: number): Promise<void> {
    await this.rpc(
      { type: FrameType.CLOSE, payload: Buffer.from(JSON.stringify({ channel }), 'utf8') },
      FrameType.CLOSED
    );
  }

  async listSessions(): Promise<SessionInfo[]> {
    const payload = await this.rpc(
      { type: FrameType.LIST, payload: Buffer.alloc(0) },
      FrameType.SESSIONS
    );
    const obj = JSON.parse(payload.toString('utf8')) as { sessions: SessionInfo[] };
    return obj.sessions;
  }

  sendInput(channel: number, data: Buffer): void {
    this.socket.write(encodeFrame(FrameType.INPUT, encodeChannelData(channel, data)));
  }

  sendResize(channel: number, cols: number, rows: number): void {
    this.socket.write(encodeFrame(FrameType.RESIZE, encodeResize(channel, cols, rows)));
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

/**
 * brokerPty is the host-side adapter that turns a BrokerClient
 * attached on a given channel into a Duplex stream — matching the
 * shape the IPC layer already expects from docker.ts's PtyHandle.
 *
 * `data` events emit OUTPUT and HISTORY bytes. ENDED on the channel
 * triggers an 'end' event. Host-side `write()` sends INPUT frames.
 */
export function brokerPtyStream(client: BrokerClient, channel: number): Duplex {
  const stream = new Duplex({
    write(chunk: Buffer | string, _enc, cb) {
      try {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        client.sendInput(channel, buf);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    read() {
      /* push-driven from broker callbacks */
    }
  });

  const onOutput = (ch: number, body: Buffer): void => {
    if (ch === channel) stream.push(body);
  };
  const onHistory = (ch: number, body: Buffer): void => {
    if (ch === channel) stream.push(body);
  };
  const onEnded = (ch: number): void => {
    if (ch === channel) stream.push(null);
  };
  const onError = (err: Error): void => {
    stream.destroy(err);
  };
  const onClose = (): void => {
    stream.push(null);
  };

  client.on('output', onOutput);
  client.on('history', onHistory);
  client.on('ended', onEnded);
  client.on('error', onError);
  client.on('close', onClose);

  stream.on('close', () => {
    client.off('output', onOutput);
    client.off('history', onHistory);
    client.off('ended', onEnded);
    client.off('error', onError);
    client.off('close', onClose);
  });

  return stream;
}
