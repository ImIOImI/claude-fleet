// The fleet-host endpoint (remote-workspaces §6). Every route but /healthz and
// /leader authenticates every request; WebSockets authenticate on upgrade and
// re-verify on a timer and on config reload. A 401-limited address gets 429
// before its token is verified.
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME_PAYLOAD } from '../main/broker.js';
import type { AttachHub, Principal } from './attachHub.js';
import { authenticate, bearerToken, type AuthContext, type AuthResult } from './auth.js';
import type { HostWorkspaceInfo } from './config.js';
import type { EventHub } from './events.js';
import type { LeaseState } from './lease.js';
import type { Logger } from './log.js';
import { clientAddress, UNAUTH_LIMIT, UnauthLimiter, type UnauthLimitOptions } from './rateLimit.js';
import { dispatchRpc, type RpcRegistry } from './rpc.js';

export const MAX_RPC_BODY = 1 << 20;
export const REVERIFY_MS = 60_000;
/** A viewer this far behind is dropped rather than buffered without bound. */
export const MAX_VIEWER_BUFFER = 8 << 20;

export interface HostServerDeps {
  workspace(): { id: string } & HostWorkspaceInfo;
  auth(): AuthContext;
  lease(): LeaseState;
  healthy(): boolean;
  hub: AttachHub;
  events: EventHub;
  rpc: RpcRegistry;
  log: Logger;
  reverifyMs?: number;
  /** From config `trustedProxyHops`; read per request so a reload applies. */
  trustedProxyHops?(): number;
  unauthLimit?: UnauthLimitOptions;
}

export interface HostServer {
  server: Server;
  /** Re-check every open socket against the current AuthContext. */
  reverifyAll(): Promise<void>;
  close(): Promise<void>;
}

interface LiveSocket {
  token: string;
  principal: Principal;
  setPrincipal(p: Principal): void;
  close(code: number, reason: string): void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function rejectUpgrade(socket: Duplex, status: number, error: string): void {
  const text = JSON.stringify({ error });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`
  );
}

// Pauses at the limit: breaking a for-await would destroy the socket before the 413 is sent.
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_RPC_BODY) {
        req.pause();
        resolve(null);
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

type GateResult = AuthResult | { ok: false; status: 429 | 503; error: string };

export function createHostServer(deps: HostServerDeps): HostServer {
  const live = new Set<LiveSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_PAYLOAD + 5 });
  const limiter = new UnauthLimiter(deps.unauthLimit ?? UNAUTH_LIMIT);

  async function gate(req: IncomingMessage): Promise<GateResult> {
    if (deps.lease() !== 'holder') return { ok: false, status: 503, error: 'standby' };
    const ip = clientAddress(req, deps.trustedProxyHops?.() ?? 0);
    if (limiter.limited(ip)) return { ok: false, status: 429, error: 'too many unauthenticated requests' };
    const r = await authenticate(req.headers.authorization, deps.auth(), deps.log);
    if (!r.ok && r.status === 401) limiter.record(ip);
    return r;
  }

  async function reverify(s: LiveSocket): Promise<void> {
    const r = await authenticate(`Bearer ${s.token}`, deps.auth(), deps.log);
    if (!r.ok) return s.close(r.status === 401 ? 4401 : 4403, r.error);
    s.setPrincipal({ identity: r.identity, tier: r.tier });
  }

  async function reverifyAll(): Promise<void> {
    await Promise.all([...live].map(reverify));
  }

  const timer = setInterval(() => void reverifyAll(), deps.reverifyMs ?? REVERIFY_MS);
  timer.unref();

  /** Returns the caller's login once authenticated, for the request log. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
    const path = new URL(req.url ?? '/', 'http://host').pathname;
    if (path === '/healthz' || path === '/leader') {
      if (req.method !== 'GET') sendJson(res, 405, { error: 'method not allowed' });
      else if (path === '/healthz') sendJson(res, deps.healthy() ? 200 : 503, { status: deps.healthy() ? 'ok' : 'unhealthy', lease: deps.lease() });
      else sendJson(res, deps.lease() === 'holder' ? 200 : 503, { lease: deps.lease() });
      return null;
    }
    const isRpc = path.startsWith('/rpc/');
    if (path !== '/whoami' && !isRpc && path !== '/attach' && path !== '/events') {
      sendJson(res, 404, { error: 'not found' });
      return null;
    }
    if (req.method !== (isRpc ? 'POST' : 'GET')) {
      sendJson(res, 405, { error: 'method not allowed' });
      return null;
    }
    const auth = await gate(req);
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.error });
      return null;
    }
    const login = auth.identity.login;
    if (path === '/attach' || path === '/events') {
      sendJson(res, 426, { error: 'WebSocket upgrade required' });
    } else if (path === '/whoami') {
      const { id, name, description, color } = deps.workspace();
      const i = auth.identity;
      sendJson(res, 200, {
        workspace: { id, name, description, color },
        user: { provider: i.provider, kind: i.kind, login: i.login, id: i.id, name: i.name, avatarUrl: i.avatarUrl },
        tier: auth.tier
      });
    } else {
      await handleRpc(req, res, path, auth);
    }
    return login;
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse, path: string, caller: Principal): Promise<void> {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
    }
    const raw = await readBody(req);
    if (!raw) {
      res.setHeader('Connection', 'close');
      return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { ok: false, error: 'body is not JSON' });
    }
    let channel: string;
    try {
      channel = decodeURIComponent(path.slice('/rpc/'.length));
    } catch {
      return sendJson(res, 404, { ok: false, error: 'no such channel' });
    }
    const r = await dispatchRpc(deps.rpc, channel, body, caller);
    sendJson(res, r.status, r.body);
  }

  const server = createServer((req, res) => {
    const started = Date.now();
    const path = new URL(req.url ?? '/', 'http://host').pathname;
    handle(req, res)
      .then((login) => {
        if (path !== '/healthz') {
          deps.log.log('info', 'request', { method: req.method, path, status: res.statusCode, login, ms: Date.now() - started });
        }
      })
      .catch((err: Error) => {
        deps.log.log('error', 'request failed', { method: req.method, path, error: err.message });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
  });

  function track(ws: WebSocket, token: string, principal: Principal, onPrincipal: (p: Principal) => void): LiveSocket {
    const s: LiveSocket = {
      token,
      principal,
      setPrincipal(p) {
        s.principal = p;
        onPrincipal(p);
      },
      close: (code, reason) => ws.close(code, reason)
    };
    live.add(s);
    ws.on('close', () => live.delete(s));
    return s;
  }

  function guardedSend(ws: WebSocket, data: Buffer | string): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_VIEWER_BUFFER) return ws.close(1013, 'viewer too slow');
    ws.send(data);
  }

  function onAttach(ws: WebSocket, token: string, principal: Principal): void {
    const viewer = deps.hub.viewer(principal, {
      send: (f) => guardedSend(ws, f),
      close: (code, reason) => ws.close(code, reason)
    });
    track(ws, token, principal, (p) => (viewer.principal = p));
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return ws.close(1003, 'binary frames only');
      void viewer.receive(data);
    });
    ws.on('close', () => void viewer.dispose());
  }

  function onEvents(ws: WebSocket, token: string, principal: Principal): void {
    track(ws, token, principal, () => undefined);
    const off = deps.events.add({ send: (t) => guardedSend(ws, t) });
    ws.on('message', () => ws.close(1003, 'events is server-push only'));
    ws.on('close', off);
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const path = new URL(req.url ?? '/', 'http://host').pathname;
    if (path !== '/attach' && path !== '/events') return rejectUpgrade(socket, 404, 'not found');
    void gate(req).then((auth) => {
      deps.log.log('info', 'upgrade', { path, status: auth.ok ? 101 : auth.status, login: auth.ok ? auth.identity.login : null });
      if (!auth.ok) return rejectUpgrade(socket, auth.status, auth.error);
      const token = bearerToken(req.headers.authorization) as string;
      const principal: Principal = { identity: auth.identity, tier: auth.tier };
      wss.handleUpgrade(req, socket, head, (ws) => (path === '/attach' ? onAttach : onEvents)(ws, token, principal));
    }).catch((err: Error) => {
      deps.log.log('error', 'upgrade failed', { path, error: err.message });
      rejectUpgrade(socket, 500, 'internal error');
    });
  });

  return {
    server,
    reverifyAll,
    async close() {
      clearInterval(timer);
      for (const s of live) s.close(1001, 'host shutting down');
      const done = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const grace = setTimeout(() => server.closeAllConnections(), 5_000);
      await done;
      clearTimeout(grace);
    }
  };
}
