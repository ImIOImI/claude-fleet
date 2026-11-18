// A remote host's /attach socket speaks the broker frame protocol, so the
// ordinary BrokerClient drives it over a WebSocket stream and the renderer's
// pty:* channels see the same PtyHandle as for a container. The host requires
// whole frames per message: BrokerClient writes one frame per write, and the
// ws stream sends each write as one message.
import { randomUUID } from 'node:crypto';
import { createWebSocketStream } from 'ws';
import { BrokerClient, brokerPtyStream } from './broker.js';
import { claudeCreateArgs } from './claudeArgs.js';
import type { PtyHandle } from './docker.js';
import { closeKind, RemoteError, type RemoteClient } from './remoteClient.js';

const CHANNEL = 1;
/** How long a closing socket may wait for the host's close frame. */
const CLOSE_GRACE_MS = 1_000;
/** How long End session waits for CLOSED before dropping the socket. */
const CLOSE_WAIT_MS = 3_000;
export const DRAIN_NOTICE_TEXT = "[host is restarting; your input wasn't sent]";
const HOST_STARTING = 'The host is starting; reopen this tab in a moment.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DRAINED = 200;

/** The host's drained sessions (D151); an older host without the channel has none. */
export async function fetchDrained(client: Pick<RemoteClient, 'rpc'>): Promise<Array<{ brokerSessionId: string; sessionId: string }>> {
  try {
    const r = await client.rpc<{ rows?: unknown }>('sessions:drained', []);
    const rows = Array.isArray(r?.rows) ? r.rows.slice(0, MAX_DRAINED) : [];
    return rows.flatMap((x) => {
      const o = x as { brokerSessionId?: unknown; sessionId?: unknown } | null;
      return o && typeof o.brokerSessionId === 'string' && typeof o.sessionId === 'string' && UUID_RE.test(o.sessionId)
        ? [{ brokerSessionId: o.brokerSessionId, sessionId: o.sessionId }] : [];
    });
  } catch (err) {
    if (err instanceof RemoteError && err.status === 404) return [];
    throw err;
  }
}

/** Fixed text per host close code; the host's reason string is untrusted. */
function closeNotice(code: number): string | null {
  if (code === 4401) return 'The host signed you out: sign in with GitHub again (Settings → Account), then reopen this tab.';
  if (code === 4403) return 'Your access to this host was removed.';
  if (code === 1013) return 'Disconnected: this tab fell too far behind the host. Reopen it.';
  if (code === 1008) return 'Disconnected by the host (a limit was reached). Reopen this tab.';
  if (code === 1001 || code === 1011) return 'The host is restarting. Reopen this tab when it is back.';
  if (code === 1000) return null;
  return 'The connection to the host was lost.';
}

export interface RemoteAttachOptions {
  client: RemoteClient;
  sessionId: string;
  cols: number;
  rows: number;
  resumeOf?: string;
  /** The viewer's tier allows CREATE (`session`). */
  canCreate: boolean;
  closeWaitMs?: number;
  /** Drained-session lookup for a missing session (D151); absent: none. */
  drained?: () => Promise<Array<{ brokerSessionId: string; sessionId: string }>>;
}

export async function attachRemotePty(o: RemoteAttachOptions): Promise<PtyHandle> {
  const ws = await o.client.openSocket('/attach');
  const broker = new BrokerClient(createWebSocketStream(ws));
  const stream = brokerPtyStream(broker, CHANNEL);
  broker.on('notice', (ch: number) => {
    if (ch === CHANNEL && !stream.destroyed && !stream.readableEnded) stream.push(Buffer.from(`\r\n\x1b[33m${DRAIN_NOTICE_TEXT}\x1b[0m\r\n`));
  });
  let closing = false;
  let closedWith: number | null = null;
  // Runs before the ws stream ends, so the notice lands ahead of the stream's end.
  ws.once('close', (code: number) => {
    closedWith = code;
    const notice = closing ? null : closeNotice(code);
    if (notice && !stream.destroyed && !stream.readableEnded) stream.push(Buffer.from(`\r\n\x1b[33m[${notice}]\x1b[0m\r\n`));
  });
  const shut = (): void => {
    closing = true;
    ws.close(1000);
    setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
  };
  const fail = (msg: string): never => {
    closing = true;
    stream.destroy();
    broker.close();
    throw new Error(msg);
  };
  const step = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      // A JSON.parse message quotes the host's bytes, too few to redact reliably.
      if (closedWith === null) fail(`host attach failed: ${err instanceof SyntaxError ? 'malformed host reply' : await o.client.redact((err as Error).message)}`);
      const kind = closeKind(closedWith!);
      closing = true;
      stream.destroy();
      throw new RemoteError(kind === 'dropped' ? 'unreachable' : kind, closeNotice(closedWith!) ?? 'The host closed the connection');
    }
  };
  let r = await step(broker.attachSession(o.sessionId, CHANNEL));
  const hostSays = (e: string | undefined): Promise<string> => o.client.redact(e ?? 'unknown error');
  if (!r.ok && /no such session/i.test(r.error ?? '')) {
    if (!o.canCreate) fail('This session is not running on the host, and your tier cannot start one');
    let resumeOf = o.resumeOf;
    if (!resumeOf && o.drained) {
      // A failed lookup must not start a fresh claude in place of the drained one.
      const rows = await o.drained().catch(() => null);
      if (rows === null) return fail(HOST_STARTING);
      resumeOf = rows.find((x) => x.brokerSessionId === o.sessionId)?.sessionId;
    }
    const created = await step(broker.createSession(o.sessionId, o.cols, o.rows, claudeCreateArgs(resumeOf, resumeOf ? undefined : randomUUID())));
    // Another viewer resumed it first: attach to theirs.
    if (!created.ok && !/id already in use/i.test(created.error ?? '')) fail(`host refused to start the session: ${await hostSays(created.error)}`);
    r = await step(broker.attachSession(o.sessionId, CHANNEL));
  }
  if (!r.ok) fail(`host refused to attach: ${await hostSays(r.error)}`);
  return {
    stream,
    resize: async (cols, rows) => broker.sendResize(CHANNEL, cols, rows),
    detach: () => {
      closing = true;
      void broker.detachChannel(CHANNEL).catch(() => undefined).finally(shut);
    },
    close: async () => {
      closing = true;
      // The host refuses CLOSE of someone else's session; dropping the socket then just detaches.
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<void>((ok) => (timer = setTimeout(ok, o.closeWaitMs ?? CLOSE_WAIT_MS)));
      await Promise.race([broker.closeChannel(CHANNEL).catch(() => undefined), waited]);
      clearTimeout(timer);
      shut();
    }
  };
}
