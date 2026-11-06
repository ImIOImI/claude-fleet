// /attach: many viewers, one broker writer per session. The host terminates
// every viewer frame, checks its tier, and relays through a single upstream
// attachment per session, fanning OUTPUT out and replaying recent output to
// newcomers as HISTORY.
import {
  FrameType,
  MAX_FRAME_PAYLOAD,
  decodeChannelData,
  encodeChannelData,
  encodeFrame,
  encodeJSONFrame
} from '../main/broker.js';
import { tierAtLeast, type Tier } from '../main/identity/grants.js';
import type { Identity } from '../main/identity/types.js';
import { DEFAULT_PORT } from './config.js';
import { portKillRefusal, type BrokerOps, type Upstream } from './brokerOps.js';
import type { Logger } from './log.js';
import { CLIENT_FRAME_TIER, RESPONSE_OF, decodeResize, hostCreateArgs, validSessionId } from './frameGate.js';

/** Matches the broker's per-session ring. */
export const REPLAY_BYTES = 64 * 1024;
/** Frames received but not yet handled; past this the viewer is closed with 1008. */
export const MAX_PENDING_FRAMES = 256;
/** Payload bytes received but not yet handled; past this the viewer is closed with 1008. */
export const MAX_PENDING_BYTES = 8 << 20;
/** Per-viewer token bucket for every frame but INPUT and RESIZE (each may open a broker connection). */
export const CONTROL_BURST = 20;
export const CONTROL_PER_SEC = 10;

export interface AttachHubOptions {
  /** fleet-host's own port, which KILLPORT must never reach. */
  hostPort?: number;
  log?: Logger;
  now?: () => number;
  controlBurst?: number;
  controlPerSec?: number;
  /** Extends a gated CREATE's args (the MCP config). */
  createArgs?: (args: string[]) => string[];
}

export interface Principal {
  identity: Identity;
  tier: Tier;
}

export interface ViewerSink {
  send(frame: Buffer): void;
  close(code: number, reason: string): void;
}

export const ownerKey = (i: Identity): string => `${i.provider}:${i.id}`;

/** Earliest replay position that can't be mid escape sequence or mid codepoint (mirrors ring.go trimToSafeStart). */
export function trimToSafeStart(b: Buffer): Buffer {
  if (b.length === 0) return b;
  const esc = b.indexOf(0x1b);
  const nl = b.indexOf(0x0a);
  if (esc < 0 && nl < 0) {
    let i = 0;
    while (i < b.length && (b[i] & 0xc0) === 0x80) i++;
    return b.subarray(i);
  }
  if (esc < 0) return b.subarray(nl + 1);
  if (nl < 0) return b.subarray(esc);
  return esc < nl + 1 ? b.subarray(esc) : b.subarray(nl + 1);
}

export class ReplayBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private wrapped = false;
  constructor(private readonly cap: number) {}

  append(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.cap) {
      const head = this.chunks[0];
      const excess = this.size - this.cap;
      this.wrapped = true;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  snapshot(): Buffer {
    const all = Buffer.concat(this.chunks);
    return this.wrapped ? trimToSafeStart(all) : all;
  }
}

type JoinResult = { ok: true } | { ok: false; error: string };

class SessionTap {
  private readonly viewers = new Map<Viewer, number>();
  private readonly replay = new ReplayBuffer(REPLAY_BYTES);
  private upstream: Upstream | null = null;
  private opening: Promise<JoinResult> | null = null;
  ended = false;

  constructor(
    readonly id: string,
    private readonly ops: BrokerOps,
    private readonly onRetire: (tap: SessionTap) => void,
    private readonly onExit: (id: string) => void
  ) {}

  async join(v: Viewer, channel: number): Promise<JoinResult> {
    if (!this.upstream && !this.ended) {
      this.opening ??= this.open();
      const r = await this.opening;
      if (!r.ok) {
        this.opening = null;
        if (this.viewers.size === 0) this.onRetire(this);
        return r;
      }
    }
    this.viewers.set(v, channel);
    return { ok: true };
  }

  private async open(): Promise<JoinResult> {
    const r = await this.ops.attach(this.id, {
      onHistory: (b) => this.fanOut(FrameType.HISTORY, b),
      onOutput: (b) => this.fanOut(FrameType.OUTPUT, b),
      onEnded: () => this.end('exit'),
      onGone: () => this.end('broker-gone')
    });
    if (!r.ok) return r;
    this.upstream = r.upstream;
    return { ok: true };
  }

  private fanOut(type: FrameType.OUTPUT | FrameType.HISTORY, body: Buffer): void {
    this.replay.append(body);
    for (const [v, ch] of this.viewers) v.deliver(type, ch, body);
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.upstream = null;
    this.onRetire(this);
    if (reason === 'exit') this.onExit(this.id);
    for (const [v, ch] of this.viewers) v.deliverEnded(ch, reason);
  }

  history(): Buffer {
    return this.replay.snapshot();
  }

  input(d: Buffer): void {
    this.upstream?.input(d);
  }

  resize(cols: number, rows: number): void {
    this.upstream?.resize(cols, rows);
  }

  async closeSession(): Promise<void> {
    const up = this.upstream;
    if (up) await up.closeSession();
    this.end('closed');
  }

  /** Drop the upstream without killing the session (SIGTERM). */
  async shutdown(): Promise<void> {
    const up = this.upstream;
    this.upstream = null;
    this.onRetire(this);
    if (up) await up.detach();
  }

  async leave(v: Viewer): Promise<void> {
    if (!this.viewers.delete(v) || this.viewers.size > 0) return;
    const up = this.upstream;
    this.upstream = null;
    this.onRetire(this);
    if (up) await up.detach();
  }
}

export class AttachHub {
  private readonly taps = new Map<string, SessionTap>();
  /** Broker session id → ownerKey of the person who CREATEd it (in memory; PTYs die with the container). */
  readonly owners = new Map<string, string>();
  private readonly ownerSeq = new Map<string, number>();
  private seq = 0;
  readonly hostPort: number;
  readonly log: Logger | undefined;
  readonly now: () => number;
  readonly controlBurst: number;
  readonly controlPerSec: number;
  readonly createArgs: (args: string[]) => string[];

  constructor(
    readonly ops: BrokerOps,
    opts: AttachHubOptions = {}
  ) {
    this.hostPort = opts.hostPort ?? DEFAULT_PORT;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.controlBurst = opts.controlBurst ?? CONTROL_BURST;
    this.controlPerSec = opts.controlPerSec ?? CONTROL_PER_SEC;
    this.createArgs = opts.createArgs ?? ((a) => a);
  }

  setOwner(id: string, key: string): void {
    this.owners.set(id, key);
    this.ownerSeq.set(id, ++this.seq);
  }

  dropOwner(id: string): void {
    this.owners.delete(id);
    this.ownerSeq.delete(id);
  }

  /** Take before listing the broker; pruneOwners then spares owners set after it. */
  ownerMark(): number {
    return this.seq;
  }

  pruneOwners(live: ReadonlySet<string>, mark: number): void {
    for (const [id, seq] of this.ownerSeq) if (seq <= mark && !live.has(id)) this.dropOwner(id);
  }

  tap(id: string): SessionTap {
    let t = this.taps.get(id);
    if (!t) {
      t = new SessionTap(
        id,
        this.ops,
        (gone) => {
          if (this.taps.get(gone.id) === gone) this.taps.delete(gone.id);
        },
        (exited) => this.dropOwner(exited)
      );
      this.taps.set(id, t);
    }
    return t;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.taps.values()].map((t) => t.shutdown()));
  }

  get liveTaps(): number {
    return this.taps.size;
  }

  viewer(principal: Principal, sink: ViewerSink): Viewer {
    return new Viewer(this, principal, sink);
  }
}

type Json = Record<string, unknown>;

class PartialFrame extends Error {}

/** Splits one WebSocket message into frames. A message may not end mid-frame, so reassembly never copies across messages. */
function* wholeFrames(msg: Buffer): IterableIterator<{ type: FrameType; payload: Buffer }> {
  let at = 0;
  while (at < msg.length) {
    if (msg.length - at < 4) throw new PartialFrame();
    const totalLen = msg.readUInt32BE(at);
    if (totalLen === 0 || totalLen - 1 > MAX_FRAME_PAYLOAD) throw new Error('bad frame length');
    if (msg.length - at < 4 + totalLen) throw new PartialFrame();
    yield { type: msg[at + 4] as FrameType, payload: Buffer.from(msg.subarray(at + 5, at + 4 + totalLen)) };
    at += 4 + totalLen;
  }
}

function parseJson(payload: Buffer): Json | null {
  try {
    const v: unknown = JSON.parse(payload.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

const isChannel = (c: unknown): c is number => typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 0xffffffff;
const dim = (n: unknown, d: number): number => (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 1000 ? n : d);
const clampDim = (n: number): number => Math.min(1000, Math.max(1, n));
const UNMETERED = new Set([FrameType.INPUT, FrameType.RESIZE]);

export class Viewer {
  private readonly channels = new Map<number, SessionTap>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private pending = 0;
  private pendingBytes = 0;
  private tokens: number;
  private refilledAt: number;
  /** Frames refused for insufficient tier. */
  denied = 0;

  constructor(
    private readonly hub: AttachHub,
    public principal: Principal,
    private readonly sink: ViewerSink
  ) {
    this.tokens = hub.controlBurst;
    this.refilledAt = hub.now();
  }

  private takeControlToken(): boolean {
    const t = this.hub.now();
    this.tokens = Math.min(this.hub.controlBurst, this.tokens + ((t - this.refilledAt) / 1000) * this.hub.controlPerSec);
    this.refilledAt = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** One binary WebSocket message: whole frames only. */
  receive(msg: Buffer): Promise<void> {
    if (this.closed) return this.queue;
    try {
      for (const f of wholeFrames(msg)) {
        if (++this.pending > MAX_PENDING_FRAMES) {
          this.fail(1008, 'too many pending frames');
          break;
        }
        const size = f.payload.length;
        this.pendingBytes += size;
        if (this.pendingBytes > MAX_PENDING_BYTES) {
          this.fail(1008, 'too many pending bytes');
          break;
        }
        this.queue = this.queue
          .then(() => (this.closed ? undefined : this.safeHandle(f.type, f.payload)))
          .finally(() => {
            this.pending--;
            this.pendingBytes -= size;
          });
      }
    } catch (err) {
      this.fail(1002, err instanceof PartialFrame ? 'partial frame' : 'malformed frame');
    }
    return this.queue;
  }

  deliver(type: FrameType.OUTPUT | FrameType.HISTORY, channel: number, body: Buffer): void {
    if (!this.closed) this.sink.send(encodeFrame(type, encodeChannelData(channel, body)));
  }

  deliverEnded(channel: number, reason: string): void {
    if (!this.closed) this.sink.send(encodeJSONFrame(FrameType.ENDED, { channel, reason }));
  }

  private reply(type: FrameType, body: unknown): void {
    if (!this.closed) this.sink.send(encodeJSONFrame(type, body));
  }

  private fail(code: number, reason: string): void {
    void this.dispose();
    this.sink.close(code, reason);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const taps = [...this.channels.values()];
    this.channels.clear();
    await Promise.all(taps.map((t) => t.leave(this)));
  }

  private deny(type: FrameType, payload: Buffer, need: Tier): void {
    this.denied++;
    const resp = RESPONSE_OF.get(type);
    if (resp === undefined) return;
    const req = parseJson(payload) ?? {};
    this.reply(resp, { id: req.id, channel: req.channel, ok: false, error: `forbidden: needs ${need}` });
  }

  private async safeHandle(type: FrameType, payload: Buffer): Promise<void> {
    try {
      await this.handle(type, payload);
    } catch (err) {
      this.hub.log?.log('error', 'attach frame failed', { type, error: err });
      const resp = RESPONSE_OF.get(type);
      if (resp !== undefined) this.reply(resp, { ok: false, error: 'broker request failed' });
    }
  }

  private async handle(type: FrameType, payload: Buffer): Promise<void> {
    const need = CLIENT_FRAME_TIER.get(type);
    if (need === undefined) return this.fail(1008, `frame type ${type} not accepted`);
    if (!tierAtLeast(this.principal.tier, need)) return this.deny(type, payload, need);
    if (!UNMETERED.has(type) && !this.takeControlToken()) {
      const resp = RESPONSE_OF.get(type);
      const req = parseJson(payload) ?? {};
      if (resp !== undefined) this.reply(resp, { id: req.id, channel: req.channel, ok: false, error: 'rate limited' });
      return;
    }
    switch (type) {
      case FrameType.INPUT: {
        const { channel, body } = decodeChannelData(payload);
        this.channels.get(channel)?.input(body);
        return;
      }
      case FrameType.RESIZE: {
        const { channel, cols, rows } = decodeResize(payload);
        this.channels.get(channel)?.resize(clampDim(cols), clampDim(rows));
        return;
      }
      case FrameType.LIST:
        return this.reply(FrameType.SESSIONS, { sessions: await this.hub.ops.list() });
      case FrameType.LISTPORTS:
        return this.reply(FrameType.PORTS, { ports: await this.hub.ops.listPorts() });
    }
    const req = parseJson(payload);
    const resp = RESPONSE_OF.get(type) as FrameType;
    if (!req) return this.reply(resp, { ok: false, error: 'bad json' });
    switch (type) {
      case FrameType.ATTACH:
        return this.attach(req);
      case FrameType.DETACH: {
        const tap = isChannel(req.channel) ? this.channels.get(req.channel) : undefined;
        if (!tap) return this.reply(resp, { channel: req.channel, ok: false, error: 'channel not attached' });
        this.channels.delete(req.channel as number);
        await tap.leave(this);
        return this.reply(resp, { channel: req.channel, ok: true });
      }
      case FrameType.CLOSE:
        return this.close(req);
      case FrameType.CREATE:
        return this.create(req);
      case FrameType.KILLPORT: {
        const port = req.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          return this.reply(resp, { ok: false, error: 'bad port' });
        }
        const refusal = await portKillRefusal(this.hub.ops, port, this.hub.hostPort);
        if (refusal) return this.reply(resp, { ok: false, error: refusal });
        return this.reply(resp, await this.hub.ops.killPort(port));
      }
      case FrameType.DIAL:
        return this.reply(resp, { channel: req.channel, ok: false, error: 'port forwarding is not available on remote hosts' });
    }
  }

  private async attach(req: Json): Promise<void> {
    const { id, channel } = req;
    if (!validSessionId(id) || !isChannel(channel)) {
      return this.reply(FrameType.ATTACHED, { channel, ok: false, error: 'bad request' });
    }
    if (this.channels.has(channel)) {
      return this.reply(FrameType.ATTACHED, { channel, ok: false, error: 'channel in use' });
    }
    if ([...this.channels.values()].some((t) => t.id === id)) {
      return this.reply(FrameType.ATTACHED, { channel, ok: false, error: 'session already attached on this connection' });
    }
    const tap = this.hub.tap(id);
    const r = await tap.join(this, channel);
    if (!r.ok) return this.reply(FrameType.ATTACHED, { channel, ok: false, error: r.error });
    if (this.closed) return tap.leave(this);
    this.channels.set(channel, tap);
    this.reply(FrameType.ATTACHED, { channel, ok: true });
    const h = tap.history();
    if (h.length > 0) this.deliver(FrameType.HISTORY, channel, h);
    if (tap.ended) this.deliverEnded(channel, 'exit');
  }

  private async close(req: Json): Promise<void> {
    const tap = isChannel(req.channel) ? this.channels.get(req.channel) : undefined;
    if (!tap) return this.reply(FrameType.CLOSED, { channel: req.channel, ok: false, error: 'channel not attached' });
    if (this.hub.owners.get(tap.id) !== ownerKey(this.principal.identity)) {
      return this.reply(FrameType.CLOSED, { channel: req.channel, ok: false, error: 'forbidden: only the session owner can close it' });
    }
    this.channels.delete(req.channel as number);
    await tap.closeSession();
    this.hub.dropOwner(tap.id);
    this.reply(FrameType.CLOSED, { channel: req.channel, ok: true });
  }

  private async create(req: Json): Promise<void> {
    const { id } = req;
    if (!validSessionId(id)) return this.reply(FrameType.CREATED, { id, ok: false, error: 'bad session id' });
    const args = hostCreateArgs(req.args);
    if (!args) return this.reply(FrameType.CREATED, { id, ok: false, error: 'forbidden: unsupported create args' });
    const r = await this.hub.ops.create(id, dim(req.cols, 80), dim(req.rows, 24), this.hub.createArgs(args));
    if (r.ok) this.hub.setOwner(id, ownerKey(this.principal.identity));
    this.reply(FrameType.CREATED, { id, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  }
}
