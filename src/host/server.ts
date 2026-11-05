// The fleet-host endpoint (remote-workspaces §6). Every route but /healthz and
// /leader authenticates every request; WebSockets authenticate on upgrade and
// re-verify on a timer and on config reload.
import { createServer, STATUS_CODES, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME_PAYLOAD } from '../main/broker.js';
import { VERIFY_TTL_MS } from '../main/identity/verifyCache.js';
import { ownerKey, type AttachHub, type Principal } from './attachHub.js';
import { authenticate, bearerToken, type AuthContext, type AuthResult } from './auth.js';
import type { HostWorkspaceInfo } from './config.js';
import type { EventHub } from './events.js';
import type { LeaseState } from './lease.js';
import type { Logger } from './log.js';
import { clientAddress, RejectionBudget, UNAUTH_LIMIT, UnauthLimiter, type UnauthLimitOptions } from './rateLimit.js';
import { dispatchRpc, type RpcRegistry } from './rpc.js';

export const MAX_RPC_BODY = 64 * 1024;
export const MAX_RPC_PER_IDENTITY = 8;
export const REVERIFY_MS = 60_000;
/** A viewer this far behind is dropped rather than buffered without bound. */
export const MAX_VIEWER_BUFFER = 8 << 20;
/** Concurrent GitHub verifications; more get 503. */
export const MAX_VERIFY_IN_FLIGHT = 16;
/** Non-OK GitHub verifications per minute across all callers; more misses get 429. */
export const UNAUTH_PER_MINUTE = 30;
/** Hashes of tokens GitHub verified OK; a miss on one skips the rejection limits. */
export const KNOWN_GOOD_MAX = 10_000;
export const KNOWN_GOOD_TTL_MS = 24 * 60 * 60_000;
export const MAX_SOCKETS_PER_IDENTITY = 8;
/** How long a socket sent a close frame may linger before it is terminated. */
export const CLOSE_GRACE_MS = 1_000;
/** Under the 60 s idle timeout of an ALB in front of the pod. */
export const PING_MS = 25_000;
/** Unanswered pings after which a socket is terminated. */
export const MAX_MISSED_PONGS = 2;
export const REQUEST_TIMEOUT_MS = 30_000;
/** Above the 60 s idle timeout of the ALB and Envoy in front, so the proxy closes idle connections first. */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HUB_SHUTDOWN_MS = 5_000;
export const HEADERS_TIMEOUT_MS = 10_000;

export interface VerifyLimits {
  maxInFlight?: number;
  unauthPerMinute?: number;
  /** Applies only when trustedProxyHops > 0. */
  perAddress?: UnauthLimitOptions;
}

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
  /**
   * From config `trustedProxyHops`; read per request so a reload applies.
   * Meaningful only behind an L7 proxy that appends a per-client X-Forwarded-For.
   */
  trustedProxyHops?(): number;
  verifyLimits?: VerifyLimits;
  maxSocketsPerIdentity?: number;
  maxRpcPerIdentity?: number;
  closeGraceMs?: number;
  maxViewerBuffer?: number;
  pingMs?: number;
  hubShutdownMs?: number;
  now?: () => number;
}

export interface HostServer {
  server: Server;
  /** Re-check every open socket against the current AuthContext. */
  reverifyAll(): Promise<void>;
  /** Refuse authenticated routes and upgrades (503) and revoke every open socket now; the listener stays up. */
  halt(code: number, reason: string): void;
  /** Closes every socket, detaches every broker upstream (hub.shutdown) and stops listening. */
  close(): Promise<void>;
}

interface LiveSocket {
  token: string;
  principal: Principal;
  verifiedAt: number;
  revoked: boolean;
  missedPongs: number;
  setPrincipal(p: Principal): void;
  /** Stop handling frames now, then close; terminate if the peer ignores the close. */
  revoke(code: number, reason: string): void;
  ping(): void;
  /** Stop handling frames and drop the connection without a close handshake. */
  kill(): void;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    ...headers
  });
  res.end(text);
}

function rejectUpgrade(socket: Duplex, status: number, error: string, headers: OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify({ error });
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${String(v)}\r\n`)
    .join('');
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n${extra}Connection: close\r\n\r\n${text}`
  );
}

/** Null for a request target URL can't parse (e.g. `//a:99999`), which would otherwise throw in a listener. */
function pathOf(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? '/', 'http://host').pathname;
  } catch {
    return null;
  }
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

type GateResult = AuthResult | { ok: false; status: 429 | 503; error: string; retryAfterSec?: number };

function failureHeaders(r: GateResult): OutgoingHttpHeaders {
  if (r.ok) return {};
  if (r.status === 401) return { 'WWW-Authenticate': 'Bearer' };
  if ('retryAfterSec' in r && r.retryAfterSec !== undefined) return { 'Retry-After': String(r.retryAfterSec) };
  return {};
}

/**
 * Last-resort process handlers: log every arrival (redacted, with stack) and
 * call `onFatal` once. State may be corrupt, so the caller exits; PTYs live in
 * the broker and survive a fleet-host restart.
 */
export function installCrashGuards(log: Logger, onFatal: () => void, proc: NodeJS.EventEmitter = process): () => void {
  let count = 0;
  const arrive = (msg: string, err: unknown): void => {
    log.log('error', msg, { error: err, count: ++count });
    if (count === 1) onFatal();
  };
  const onException = (err: unknown): void => arrive('uncaught exception', err);
  const onRejection = (err: unknown): void => arrive('unhandled rejection', err);
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.off('uncaughtException', onException);
    proc.off('unhandledRejection', onRejection);
  };
}

export function createHostServer(deps: HostServerDeps): HostServer {
  const now = deps.now ?? Date.now;
  const grace = deps.closeGraceMs ?? CLOSE_GRACE_MS;
  const maxBuffer = deps.maxViewerBuffer ?? MAX_VIEWER_BUFFER;
  const live = new Set<LiveSocket>();
  const openByIdentity = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_PAYLOAD + 5 });
  const limits = deps.verifyLimits ?? {};
  const maxInFlight = limits.maxInFlight ?? MAX_VERIFY_IN_FLIGHT;
  const budget = new RejectionBudget(limits.unauthPerMinute ?? UNAUTH_PER_MINUTE, now);
  const perAddress = new UnauthLimiter({ ...(limits.perAddress ?? UNAUTH_LIMIT), now });
  let inFlight = 0;
  let halted = false;
  const rpcByIdentity = new Map<string, number>();
  const knownGood = new Map<string, number>();
  const tokenKey = (t: string): string => createHash('sha256').update(t).digest('hex');
  function isKnownGood(key: string): boolean {
    const at = knownGood.get(key);
    if (at === undefined) return false;
    knownGood.delete(key);
    if (now() - at > KNOWN_GOOD_TTL_MS) return false;
    knownGood.set(key, at);
    return true;
  }

  // Cached answers (valid or rejected) never touch a limit, and a token GitHub
  // accepted in the last 24 h skips the rejection limits, so one bad client
  // can't lock out users whose tokens are already known.
  async function gate(req: IncomingMessage, ctx: AuthContext): Promise<GateResult> {
    if (halted) return { ok: false, status: 503, error: 'shutting down' };
    if (deps.lease() !== 'holder') return { ok: false, status: 503, error: 'standby' };
    const header = req.headers.authorization;
    const token = bearerToken(header);
    if (!token) return { ok: false, status: 401, error: 'missing or malformed bearer token' };
    if (ctx.peek(token) !== 'miss') return authenticate(header, ctx, deps.log);
    const key = tokenKey(token);
    const trusted = isKnownGood(key);
    const hops = deps.trustedProxyHops?.() ?? 0;
    const ip = hops > 0 ? clientAddress(req, hops) : null;
    if (!trusted && ip && perAddress.limited(ip)) {
      return { ok: false, status: 429, error: 'too many rejected tokens', retryAfterSec: Math.ceil(perAddress.retryAfterMs(ip) / 1000) };
    }
    if (inFlight >= maxInFlight) return { ok: false, status: 503, error: 'identity checks busy', retryAfterSec: 1 };
    const wait = trusted ? 0 : budget.waitMs();
    if (wait > 0) return { ok: false, status: 429, error: 'too many rejected tokens', retryAfterSec: Math.ceil(wait / 1000) };
    inFlight++;
    let r: AuthResult;
    try {
      r = await authenticate(header, ctx, deps.log);
    } finally {
      inFlight--;
    }
    if (r.ok) rememberGood(key);
    else if (r.status !== 503) {
      if (r.status === 401 || r.status === 403) knownGood.delete(key);
      budget.spend();
      if (ip) perAddress.record(ip);
    }
    return r;
  }

  function rememberGood(key: string): void {
    knownGood.delete(key);
    if (knownGood.size >= KNOWN_GOOD_MAX) knownGood.delete(knownGood.keys().next().value as string);
    knownGood.set(key, now());
  }

  async function reverify(s: LiveSocket): Promise<void> {
    if (s.revoked) return;
    const r = await authenticate(`Bearer ${s.token}`, deps.auth(), deps.log);
    if (s.revoked) return;
    if (r.ok) {
      s.verifiedAt = now();
      rememberGood(tokenKey(s.token));
      return s.setPrincipal({ identity: r.identity, tier: r.tier });
    }
    if (r.status === 502 || r.status === 503) {
      if (now() - s.verifiedAt <= VERIFY_TTL_MS) {
        deps.log.log('warn', 'identity unverifiable; keeping socket', { login: s.principal.identity.login, status: r.status });
        return;
      }
      return s.revoke(4401, 'identity unverifiable');
    }
    knownGood.delete(tokenKey(s.token));
    s.revoke(r.status === 401 ? 4401 : 4403, r.error);
  }

  async function reverifyAll(): Promise<void> {
    await Promise.all([...live].map(reverify));
  }

  const timer = setInterval(() => void reverifyAll(), deps.reverifyMs ?? REVERIFY_MS);
  timer.unref();
  const pinger = setInterval(() => {
    for (const s of live) {
      if (s.missedPongs >= MAX_MISSED_PONGS) s.kill();
      else {
        s.missedPongs++;
        s.ping();
      }
    }
  }, deps.pingMs ?? PING_MS);
  pinger.unref();

  /** Returns the caller's login once authenticated, for the request log. */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<string | null> {
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
    const auth = await gate(req, deps.auth());
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.error }, failureHeaders(auth));
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
      const key = ownerKey(auth.identity);
      const n = rpcByIdentity.get(key) ?? 0;
      if (n >= (deps.maxRpcPerIdentity ?? MAX_RPC_PER_IDENTITY)) {
        sendJson(res, 429, { ok: false, error: 'too many concurrent requests' }, { 'Retry-After': '1' });
        return login;
      }
      rpcByIdentity.set(key, n + 1);
      try {
        await handleRpc(req, res, path, auth);
      } finally {
        const left = (rpcByIdentity.get(key) ?? 1) - 1;
        if (left > 0) rpcByIdentity.set(key, left);
        else rpcByIdentity.delete(key);
      }
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
    const r = await dispatchRpc(deps.rpc, channel, body, caller, deps.log);
    sendJson(res, r.status, r.body);
  }

  const server = createServer((req, res) => {
    const started = Date.now();
    const path = pathOf(req);
    if (path === null) {
      deps.log.log('info', 'request', { method: req.method, path: null, status: 400 });
      return sendJson(res, 400, { error: 'bad request target' });
    }
    handle(req, res, path)
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
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  function track(ws: WebSocket, token: string, principal: Principal, onPrincipal: (p: Principal) => void, onRevoke: () => void): LiveSocket {
    const s: LiveSocket = {
      token,
      principal,
      verifiedAt: now(),
      revoked: false,
      missedPongs: 0,
      ping() {
        if (ws.readyState === ws.OPEN) ws.ping();
      },
      setPrincipal(p) {
        s.principal = p;
        onPrincipal(p);
      },
      revoke(code, reason) {
        if (s.revoked) return;
        s.revoked = true;
        onRevoke();
        ws.close(code, reason);
        setTimeout(() => ws.terminate(), grace).unref();
      },
      kill() {
        if (!s.revoked) {
          s.revoked = true;
          onRevoke();
        }
        ws.terminate();
      }
    };
    ws.on('pong', () => (s.missedPongs = 0));
    // ws emits protocol violations (oversize message, RSV1, bad opcode, bad UTF-8) here; unhandled, they would crash the process.
    ws.on('error', (err) => {
      deps.log.log('warn', 'websocket error', { login: s.principal.identity.login, error: err.message });
      s.kill();
    });
    live.add(s);
    ws.on('close', () => live.delete(s));
    return s;
  }

  function guardedSend(ws: WebSocket, s: LiveSocket, data: Buffer | string): void {
    if (s.revoked || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > maxBuffer) return s.revoke(1013, 'viewer too slow');
    ws.send(data);
  }

  function onAttach(ws: WebSocket, token: string, principal: Principal): void {
    // `s` is assigned before the viewer can send: sends only follow a received frame.
    let s!: LiveSocket;
    const viewer = deps.hub.viewer(principal, {
      send: (f) => guardedSend(ws, s, f),
      close: (code, reason) => s.revoke(code, reason)
    });
    s = track(ws, token, principal, (p) => (viewer.principal = p), () => void viewer.dispose());
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (s.revoked) return;
      if (!isBinary) return s.revoke(1003, 'binary frames only');
      void viewer.receive(data);
    });
    ws.on('close', () => void viewer.dispose());
  }

  function onEvents(ws: WebSocket, token: string, principal: Principal): void {
    let off: () => void = () => undefined;
    const s = track(ws, token, principal, () => undefined, () => off());
    off = deps.events.add({ send: (t) => guardedSend(ws, s, t) });
    ws.on('message', () => s.revoke(1003, 'events is server-push only'));
    ws.on('close', () => off());
  }

  /** Counts the socket against its identity until it closes; false at the cap. */
  function reserveSlot(key: string, socket: Duplex): boolean {
    const open = openByIdentity.get(key) ?? 0;
    if (open >= (deps.maxSocketsPerIdentity ?? MAX_SOCKETS_PER_IDENTITY)) return false;
    openByIdentity.set(key, open + 1);
    socket.once('close', () => {
      const n = (openByIdentity.get(key) ?? 1) - 1;
      if (n > 0) openByIdentity.set(key, n);
      else openByIdentity.delete(key);
    });
    return true;
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const path = pathOf(req);
    if (path === null) return rejectUpgrade(socket, 400, 'bad request target');
    if (path !== '/attach' && path !== '/events') return rejectUpgrade(socket, 404, 'not found');
    void gate(req, deps.auth())
      .then((auth) => {
        deps.log.log('info', 'upgrade', { path, status: auth.ok ? 101 : auth.status, login: auth.ok ? auth.identity.login : null });
        // The client may have gone while GitHub answered; its 'close' has then already fired.
        if (socket.destroyed) return;
        if (!auth.ok) return rejectUpgrade(socket, auth.status, auth.error, failureHeaders(auth));
        if (!reserveSlot(ownerKey(auth.identity), socket)) {
          return rejectUpgrade(socket, 429, 'too many open sockets', { 'Retry-After': '5' });
        }
        const token = bearerToken(req.headers.authorization) as string;
        const principal: Principal = { identity: auth.identity, tier: auth.tier };
        wss.handleUpgrade(req, socket, head, (ws) => (path === '/attach' ? onAttach : onEvents)(ws, token, principal));
      })
      .catch((err: Error) => {
        deps.log.log('error', 'upgrade failed', { path, error: err.message });
        rejectUpgrade(socket, 500, 'internal error');
      });
  });

  function halt(code: number, reason: string): void {
    halted = true;
    for (const s of live) s.revoke(code, reason);
  }

  return {
    server,
    reverifyAll,
    halt,
    async close() {
      clearInterval(timer);
      clearInterval(pinger);
      halt(1001, 'host shutting down');
      let bound: NodeJS.Timeout | undefined;
      await Promise.race([
        deps.hub.shutdown(),
        new Promise<void>((resolve) => (bound = setTimeout(resolve, deps.hubShutdownMs ?? HUB_SHUTDOWN_MS)))
      ]);
      clearTimeout(bound);
      const done = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), grace);
      await done;
      clearTimeout(force);
    }
  };
}
