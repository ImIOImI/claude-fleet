// Test doubles shared by the host's unit tests (not shipped: only *.test.ts import it).
import { FrameReader, FrameType, decodeChannelData, encodeChannelData, encodeFrame, encodeJSONFrame } from '../main/broker.js';
import type { BrokerPortInfo } from '../main/broker.js';
import type { Identity } from '../main/identity/types.js';
import type { BrokerOps, Upstream, UpstreamHandlers } from './brokerOps.js';
import type { ViewerSink } from './attachHub.js';

export const TOKEN = 'gho_' + 'T'.repeat(36);

export function person(login: string, id: number, teams: string[] = []): Identity {
  return { provider: 'github', kind: 'user', login, id, name: null, avatarUrl: null, teams };
}

export interface FakeSession {
  handlers: UpstreamHandlers | null;
  inputs: Buffer[];
  resizes: Array<[number, number]>;
  closed: boolean;
  detached: number;
}

export function fakeBroker(initial: string[] = []) {
  const sessions = new Map<string, FakeSession>();
  const created: Array<{ id: string; args: string[] }> = [];
  const killed: number[] = [];
  const ports: BrokerPortInfo[] = [{ port: 3000, session: 's1' }];
  const add = (id: string): FakeSession => {
    const s: FakeSession = { handlers: null, inputs: [], resizes: [], closed: false, detached: 0 };
    sessions.set(id, s);
    return s;
  };
  for (const id of initial) add(id);
  let attachCalls = 0;
  const ops: BrokerOps = {
    async attach(id, h) {
      attachCalls++;
      const s = sessions.get(id);
      if (!s) return { ok: false, error: 'no such session' };
      if (s.handlers) return { ok: false, error: 'already attached' };
      s.handlers = h;
      const upstream: Upstream = {
        input: (d) => s.inputs.push(d),
        resize: (c, r) => s.resizes.push([c, r]),
        async closeSession() {
          s.closed = true;
          s.handlers = null;
        },
        async detach() {
          s.detached++;
          s.handlers = null;
        }
      };
      return { ok: true, upstream };
    },
    async create(id, _c, _r, args) {
      if (sessions.has(id)) return { ok: false, error: 'session id in use' };
      add(id);
      created.push({ id, args });
      return { ok: true };
    },
    async list() {
      return [...sessions.keys()].map((id) => ({ id, alive: !sessions.get(id)!.closed }));
    },
    async listPorts() {
      return ports.map((p) => ({ ...p }));
    },
    async killPort(port) {
      killed.push(port);
      return { ok: true };
    }
  };
  return { ops, sessions, created, killed, ports, attachCalls: () => attachCalls };
}

export interface Received {
  type: FrameType;
  json?: Record<string, unknown>;
  channel?: number;
  body?: Buffer;
}

const DATA_FRAMES = new Set([FrameType.OUTPUT, FrameType.HISTORY, FrameType.INPUT]);

export function decodeAll(buf: Buffer): Received[] {
  const r = new FrameReader();
  r.push(buf);
  const out: Received[] = [];
  for (const f of r.consume()) {
    if (DATA_FRAMES.has(f.type)) {
      const { channel, body } = decodeChannelData(f.payload);
      out.push({ type: f.type, channel, body });
    } else {
      out.push({ type: f.type, json: JSON.parse(f.payload.toString('utf8')) as Record<string, unknown> });
    }
  }
  return out;
}

export function sinkRecorder() {
  const frames: Received[] = [];
  const closes: Array<[number, string]> = [];
  const sink: ViewerSink = {
    send: (f) => frames.push(...decodeAll(f)),
    close: (code, reason) => closes.push([code, reason])
  };
  return { sink, frames, closes };
}

export const jsonFrame = encodeJSONFrame;
export const inputFrame = (channel: number, s: string): Buffer =>
  encodeFrame(FrameType.INPUT, encodeChannelData(channel, Buffer.from(s)));
export function resizeFrame(channel: number, cols: number, rows: number): Buffer {
  const p = Buffer.alloc(8);
  p.writeUInt32BE(channel, 0);
  p.writeUInt16BE(cols, 4);
  p.writeUInt16BE(rows, 6);
  return encodeFrame(FrameType.RESIZE, p);
}
