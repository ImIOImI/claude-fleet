// A failed remote action RPC as a renderer-facing kind and one-line message.
import type { RemoteActionErrorKind } from '../../preload/remoteAutomations.js';
import { RemoteError } from '../remoteClient.js';
import { oneLine } from '../remoteUrl.js';
import { RemoteShapeError } from './remoteRows.js';

/** remoteClient.ts bakes this into the message on both the connect and read timeout paths; there's no separate signal to key off. */
const TIMED_OUT_RE = /\btimed out\b/;
const unknownOutcome = (why: string): string => `${why} It may have gone through. Retrying is safe (same request).`;

export function actionError(err: unknown, name?: string): { kind: RemoteActionErrorKind; message: string; retryAfterMs?: number } {
  // The request went out but the reply couldn't be read as an action reply (D128: the host may still have run it).
  if (err instanceof RemoteShapeError) return { kind: 'unavailable', message: unknownOutcome("The host's reply didn't make sense.") };
  const message = oneLine(err instanceof Error ? err.message : String(err), 300);
  if (!(err instanceof RemoteError)) return { kind: 'failed', message };
  if (err.status === 429) {
    return { kind: 'busy', message: 'the host is busy; try again shortly', ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}) };
  }
  if (err.kind === 'forbidden') return { kind: 'forbidden', message };
  if (err.status === 400) return { kind: 'invalid', message };
  if (err.kind === 'unreachable' && TIMED_OUT_RE.test(err.message)) {
    return { kind: 'unavailable', message: `No answer from ${name ?? 'the host'} in 15 s; it may have gone through. Retrying is safe (same request).` };
  }
  if (err.kind === 'unreachable' || err.kind === 'standby' || err.kind === 'not-signed-in' || err.kind === 'unauthorized' || err.status === 503) {
    return { kind: 'unavailable', message };
  }
  // The host's rpc envelope was itself malformed ("rpc … failed") or the reply was over the body cap: same uncertainty as a bad shape.
  if (err.kind === 'protocol') return { kind: 'unavailable', message: unknownOutcome('The host answered strangely.') };
  return { kind: 'failed', message };
}
