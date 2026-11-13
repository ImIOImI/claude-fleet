// Runs a remote action with a per-intent, per-payload request id; tracks busy keys and the last message per key.
import { useCallback, useRef, useState } from 'react';
import type { RemoteActionResult } from '../../../preload/remoteAutomations';
import { actionMessage, intentRunner } from '../remoteAutomationsView';

export function useRemoteAction() {
  // Lazily initialised: a bare `useRef(intentRunner())` would still construct a runner on every
  // render (and discard all but the first), just to avoid using it.
  const runnerRef = useRef<ReturnType<typeof intentRunner> | null>(null);
  if (runnerRef.current === null) runnerRef.current = intentRunner();
  const runner = runnerRef.current;
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const run = useCallback(async <T,>(key: string, fingerprint: string, send: (requestId: string) => Promise<RemoteActionResult<T>>): Promise<RemoteActionResult<T>> => {
    setBusy((b) => new Set(b).add(key));
    setErrors(({ [key]: _drop, ...rest }) => rest);
    const r = await runner.run(key, fingerprint, send);
    const msg = actionMessage(r);
    if (msg) setErrors((x) => ({ ...x, [key]: msg }));
    setBusy((b) => {
      const n = new Set(b);
      n.delete(key);
      return n;
    });
    return r;
  }, [runner]);
  return { run, busy, errors };
}
