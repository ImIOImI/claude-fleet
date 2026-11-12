// A failed remote action RPC as a renderer-facing kind and one-line message.
import type { RemoteActionErrorKind } from '../../preload/remoteAutomations.js';
import { RemoteError } from '../remoteClient.js';
import { oneLine } from '../remoteUrl.js';

export function actionError(err: unknown): { kind: RemoteActionErrorKind; message: string; retryAfterMs?: number } {
  const message = oneLine(err instanceof Error ? err.message : String(err), 300);
  if (!(err instanceof RemoteError)) return { kind: 'failed', message };
  if (err.status === 429) {
    return { kind: 'busy', message: 'the host is busy; try again shortly', ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}) };
  }
  if (err.kind === 'forbidden') return { kind: 'forbidden', message };
  if (err.status === 400) return { kind: 'invalid', message };
  if (err.kind === 'unreachable' || err.kind === 'standby' || err.kind === 'not-signed-in' || err.kind === 'unauthorized' || err.status === 503) {
    return { kind: 'unavailable', message };
  }
  return { kind: 'failed', message };
}
