// One client per remote host (remote-workspaces §6): RPC, /whoami, /healthz,
// the /events socket and the bearer token. The token comes from the identity
// service on every call, is sent only to the host URL fixed at construction,
// and never appears in an error or a log line.
import WebSocket from 'ws';
import { MAX_FRAME_PAYLOAD } from './broker.js';
import type { Tier } from './identity/grants.js';
import { redactSecrets } from './identity/redact.js';
import { normalizeHostUrl, oneLine, safeLogin, wsUrl } from './remoteUrl.js';

export { CONTROL_RE, oneLine, safeLogin } from './remoteUrl.js';

export type RemoteErrorKind = 'not-signed-in' | 'unreachable' | 'unauthorized' | 'forbidden' | 'standby' | 'protocol';

export class RemoteError extends Error {
  constructor(
    readonly kind: RemoteErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

export interface WhoAmI {
  workspace: { id: string; name: string; description: string | null; color: { hue: number } | null };
  user: { provider: string; kind: 'user' | 'machine'; login: string; id: number; name: string | null; avatarUrl: string | null };
  tier: Tier;
}

export interface RemoteEvent {
  channel: string;
  payload: unknown;
}

/** Why /events is down. `retryInMs` null: not retrying (grant removed). */
export interface RemoteDisconnect {
  kind: RemoteErrorKind | 'dropped';
  code?: number;
  status?: number;
  retryInMs: number | null;
}

export interface RemoteClientOptions {
  url: string;
  token(): Promise<string | null>;
  timeoutMs?: number;
  /** Close a socket the host has not pinged for this long. */
  idleTimeoutMs?: number;
  /** Reconnect timer; returns a cancel. Injectable for tests. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export const REMOTE_TIMEOUT_MS = 10_000;
/** Over two of the host's 25 s pings. */
export const REMOTE_IDLE_MS = 60_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const SLOW_RETRY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 10 * 60_000;
/** A socket open this long resets the backoff, so a host that accepts then drops can't hold us at the floor. */
const STABLE_MS = 30_000;
const MAX_EVENT_BYTES = 1 << 20;
const TIERS: readonly string[] = ['read', 'steer', 'session'];
/** Same charset the host accepts (src/host/auth.ts); also keeps CR/LF out of the header. */
const TOKEN_RE = /^[A-Za-z0-9_.~+/=-]{1,4096}$/;
/** The host's id is always a ULID; it becomes a directory name under <userData>/state. */
const WORKSPACE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Reply caps: a hostile host could otherwise stream until main runs out of memory. */
export const MAX_SMALL_BODY = 64 * 1024;
export const MAX_RPC_BODY = 2 * 1024 * 1024;

function isWhoAmI(v: unknown): v is WhoAmI {
  const o = v as WhoAmI | null;
  return (
    !!o &&
    typeof o.workspace?.id === 'string' &&
    WORKSPACE_ID_RE.test(o.workspace.id) &&
    typeof o.workspace.name === 'string' &&
    typeof o.user?.login === 'string' &&
    TIERS.includes(o.tier)
  );
}

function httpsOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** Display fields are untrusted host text. */
function sanitizeWhoAmI(url: string, w: WhoAmI): WhoAmI {
  const login = safeLogin(w.user.login);
  if (!login) throw new RemoteError('protocol', `${url} is not a fleet-host (unexpected /whoami login)`);
  return {
    ...w,
    workspace: {
      ...w.workspace,
      name: oneLine(w.workspace.name, 64),
      description: typeof w.workspace.description === 'string' ? oneLine(w.workspace.description, 500) : null
    },
    user: { ...w.user, login, avatarUrl: httpsOrNull(w.user.avatarUrl) }
  };
}

/** Host text is untrusted: secrets cut out (before truncating, so none survive the cut), then one short line. */
function scrub(text: string, token: string | null): string {
  let t = token ? text.split(token).join('[redacted]') : text;
  t = redactSecrets(t);
  return oneLine(t, 200);
}

export function parseRetryAfter(v: string | string[] | null | undefined, now = Date.now()): number | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return undefined;
  const ms = /^\d+$/.test(s.trim()) ? Number(s.trim()) * 1000 : Date.parse(s) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined;
}

/** The body as text, or null once it exceeds `cap` (the request is then aborted). */
async function readCapped(res: Response, cap: number, abort: () => void): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > cap) {
    abort();
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      abort();
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function statusError(url: string, status: number, text: string, retryAfterMs?: number): RemoteError {
  if (status === 401) return new RemoteError('unauthorized', 'GitHub sign-in was rejected by the host; sign in again', 401);
  if (status === 403) return new RemoteError('forbidden', text || 'You have no grant on this host', 403);
  if (status === 503 && text === 'standby') return new RemoteError('standby', 'The host is starting up (standby); try again shortly', 503, retryAfterMs);
  if (status === 429) return new RemoteError('unreachable', `${url} is busy; try again shortly`, 429, retryAfterMs);
  const detail = `${url} answered ${status}${text ? `: ${text}` : ''}`;
  return new RemoteError(status >= 500 ? 'unreachable' : 'protocol', detail, status, retryAfterMs);
}

/** WebSocket close codes the host uses (src/host/server.ts, attachHub.ts). */
export function closeKind(code: number): RemoteDisconnect['kind'] {
  if (code === 4401) return 'unauthorized';
  if (code === 4403) return 'forbidden';
  if (code === 1001 || code === 1011) return 'unreachable';
  if (code === 1002 || code === 1003) return 'protocol';
  return 'dropped';
}

/** Next reconnect delay after `attempt` failures, or null to stop. Never under the first backoff step. */
export function reconnectDelay(attempt: number, why: { kind: RemoteDisconnect['kind']; retryAfterMs?: number }): number | null {
  if (why.kind === 'forbidden') return null;
  const base =
    why.kind === 'unauthorized' || why.kind === 'not-signed-in' || why.kind === 'protocol'
      ? SLOW_RETRY_MS
      : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return Math.min(Math.max(base, why.retryAfterMs ?? 0), MAX_RETRY_AFTER_MS);
}

export class RemoteClient {
  readonly url: string;
  private readonly token: () => Promise<string | null>;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(opts: RemoteClientOptions) {
    this.url = normalizeHostUrl(opts.url);
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? REMOTE_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? REMOTE_IDLE_MS;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  private async bearer(): Promise<string> {
    const t = await this.token();
    if (!t) throw new RemoteError('not-signed-in', 'Sign in with GitHub first (Settings → Account)');
    if (!TOKEN_RE.test(t)) throw new RemoteError('not-signed-in', 'The stored GitHub sign-in is malformed; sign in again (Settings → Account)');
    return t;
  }

  /** Host-supplied text made safe to show: one short line, token removed. */
  async redact(text: string): Promise<string> {
    return scrub(text, await this.token().catch(() => null));
  }

  private async request(path: string, init: { method: string; body?: string; auth: boolean; timeoutMs?: number; maxBody: number }): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = init.auth ? await this.bearer() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const abort = (): void => ctrl.abort();
    let res: Response;
    try {
      // A redirect would replay the bearer token to a URL the user never added.
      res = await fetch(this.url + path, {
        method: init.method,
        headers,
        body: init.body,
        redirect: 'error',
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs)])
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: unknown } };
      const why = e.name === 'TimeoutError' ? 'timed out' : typeof e.cause?.code === 'string' ? e.cause.code : e.name;
      throw new RemoteError('unreachable', `${this.url} is not reachable (${scrub(why, token)}); check your network or VPN`);
    }
    if (!res.ok) {
      let text = '';
      try {
        const raw = await readCapped(res, MAX_SMALL_BODY, abort);
        const b = raw === null ? null : (JSON.parse(raw) as { error?: unknown } | null);
        if (typeof b?.error === 'string') text = scrub(b.error, token);
      } catch {
        /* non-JSON or interrupted error body */
      }
      throw statusError(this.url, res.status, text, parseRetryAfter(res.headers.get('retry-after')));
    }
    let raw: string | null;
    try {
      raw = await readCapped(res, init.maxBody, abort);
    } catch (err) {
      const why = (err as Error).name === 'TimeoutError' ? 'timed out' : 'interrupted';
      throw new RemoteError('unreachable', `${this.url} reply ${why}; check your network or VPN`);
    }
    if (raw === null) throw new RemoteError('protocol', `${this.url} reply is too large`);
    try {
      return JSON.parse(raw);
    } catch {
      throw new RemoteError('protocol', `${this.url} is not a fleet-host (reply is not JSON)`);
    }
  }

  async healthz(timeoutMs = 3_000): Promise<{ status: string; lease: string }> {
    const body = (await this.request('/healthz', { method: 'GET', auth: false, timeoutMs, maxBody: MAX_SMALL_BODY })) as { status?: unknown; lease?: unknown } | null;
    if (typeof body?.status !== 'string' || typeof body.lease !== 'string') {
      throw new RemoteError('protocol', `${this.url} is not a fleet-host (unexpected /healthz reply)`);
    }
    return { status: body.status, lease: body.lease };
  }

  async whoami(): Promise<WhoAmI> {
    const body = await this.request('/whoami', { method: 'GET', auth: true, maxBody: MAX_SMALL_BODY });
    if (!isWhoAmI(body)) throw new RemoteError('protocol', `${this.url} is not a fleet-host (unexpected /whoami reply)`);
    return sanitizeWhoAmI(this.url, body);
  }

  async rpc<T>(channel: string, args: unknown[], opts: { timeoutMs?: number } = {}): Promise<T> {
    const body = (await this.request(`/rpc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      auth: true,
      body: JSON.stringify({ args }),
      maxBody: MAX_RPC_BODY,
      timeoutMs: opts.timeoutMs
    })) as { ok?: unknown; result?: T } | null;
    if (body?.ok !== true) throw new RemoteError('protocol', `${this.url} rpc ${channel} failed`);
    return body.result as T;
  }

  /** An authenticated WebSocket to `path`, resolved once open. */
  async openSocket(path: '/attach' | '/events'): Promise<WebSocket> {
    const token = await this.bearer();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: RemoteError): void => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const ws = new WebSocket(wsUrl(this.url, path), {
        headers: { Authorization: `Bearer ${token}` },
        followRedirects: false,
        handshakeTimeout: this.timeoutMs,
        perMessageDeflate: false,
        maxPayload: path === '/attach' ? MAX_FRAME_PAYLOAD + 5 : MAX_EVENT_BYTES
      });
      // Stays attached: ws may emit 'error' again (e.g. after terminate), which unhandled would throw.
      ws.on('error', (err) => fail(new RemoteError('unreachable', `${this.url}${path} is not reachable (${scrub(err.name, token)})`)));
      ws.once('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0;
        const retryAfterMs = parseRetryAfter(res.headers['retry-after']);
        res.resume();
        ws.terminate();
        const e = statusError(this.url, status, '', retryAfterMs);
        fail(status >= 300 && status < 400 ? new RemoteError('unreachable', `${this.url}${path} redirected; not following`, status) : e);
      });
      ws.once('open', () => {
        settled = true;
        this.watchIdle(ws);
        resolve(ws);
      });
    });
  }

  private watchIdle(ws: WebSocket): void {
    let timer: NodeJS.Timeout;
    const bump = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => ws.terminate(), this.idleTimeoutMs);
      timer.unref?.();
    };
    bump();
    ws.on('ping', bump);
    ws.on('message', bump);
    ws.once('close', () => clearTimeout(timer));
  }

  /** Subscribe to /events, reconnecting with backoff. Returns unsubscribe. */
  subscribe(onEvent: (e: RemoteEvent) => void, onState?: (connected: boolean, why?: RemoteDisconnect) => void): () => void {
    let stopped = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let cancel: (() => void) | null = null;
    const down = (why: Omit<RemoteDisconnect, 'retryInMs'>, retryAfterMs?: number): void => {
      if (stopped) return;
      const ms = reconnectDelay(attempt++, { kind: why.kind, retryAfterMs });
      onState?.(false, { ...why, retryInMs: ms });
      if (ms !== null) cancel = this.schedule(connect, ms);
    };
    const connect = (): void => {
      cancel = null;
      this.openSocket('/events').then(
        (sock) => {
          if (stopped) return sock.close(1000);
          ws = sock;
          const openedAt = Date.now();
          onState?.(true);
          sock.on('message', (data) => {
            try {
              const e = JSON.parse(String(data)) as RemoteEvent;
              if (e && typeof e.channel === 'string') onEvent(e);
            } catch {
              /* malformed push or a throwing handler */
            }
          });
          sock.once('close', (code) => {
            ws = null;
            if (Date.now() - openedAt >= STABLE_MS) attempt = 0;
            down({ kind: closeKind(code), code });
          });
        },
        (err: unknown) => {
          const e = err instanceof RemoteError ? err : new RemoteError('unreachable', 'connect failed');
          down({ kind: e.kind, status: e.status }, e.retryAfterMs);
        }
      );
    };
    connect();
    return () => {
      stopped = true;
      cancel?.();
      ws?.close(1000);
    };
  }
}
